const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVICE = 'localminidrama-comfyui-bridge';
const VERSION = 1;
const BACKEND_DIR = path.resolve(__dirname, '..', '..');

// The factory keeps lifecycle tests independent of real Python processes and the DB.
function createComfyUIBridgeProcess(dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const parentProcess = dependencies.parentProcess || process;
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const existsSync = dependencies.existsSync || fs.existsSync;
  const backendDir = dependencies.backendDir || BACKEND_DIR;
  const loadConfig = dependencies.loadConfig || (() => require('../config/index.js').loadConfig());
  const now = dependencies.now || Date.now;
  const healthTimeoutMs = dependencies.healthTimeoutMs ?? 1000;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 10000;
  const probeTimeoutMs = dependencies.probeTimeoutMs ?? 5000;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 100;
  const stopTimeoutMs = dependencies.stopTimeoutMs ?? 1500;
  const killTimeoutMs = dependencies.killTimeoutMs ?? 500;
  const bridgeExitTimeoutMs = dependencies.bridgeExitTimeoutMs ?? 2000;
  const ownedChildren = new Set();
  let managed = null;
  let starting = null;
  let startingPort = null;
  let stopping = null;
  let generation = 0;
  let exitHookInstalled = false;
  let lastConfig;
  let lastLog;

  function logMessage(log, level, message, details) {
    // Never include the connection object, inherited environment, or token in logs.
    if (typeof log?.[level] === 'function') log[level](message, details);
  }

  function onParentExit() {
    for (const record of ownedChildren) {
      try { record.child.kill('SIGKILL'); } catch (_) {}
    }
  }

  function trackChild(child, role, log) {
    const record = { child, role, log, ended: false, stopping: false, ready: false, error: null };
    record.exited = new Promise((resolve) => {
      const finish = (code, signal) => {
        if (record.ended) return;
        record.ended = true;
        record.code = code;
        ownedChildren.delete(record);
        if (managed === record && !record.redirected) managed = null;
        if (exitHookInstalled && ownedChildren.size === 0) {
          parentProcess.removeListener('exit', onParentExit);
          exitHookInstalled = false;
        }
        if (role === 'bridge' && record.ready && !record.stopping) {
          logMessage(log, 'warn', 'ComfyUI bridge exited; the next video request will restart it', { code, signal });
        }
        resolve();
      };
      child.once('exit', finish);
      child.on('error', (error) => {
        record.error = error;
        // Failed spawn emits error without exit. A kill error can leave a live PID.
        if (!child.pid) finish(null, null);
      });
    });
    ownedChildren.add(record);
    if (!exitHookInstalled) {
      parentProcess.once('exit', onParentExit);
      exitHookInstalled = true;
    }
    return record;
  }

  async function waitForExit(record, timeoutMs) {
    if (record.ended) return true;
    let timer;
    try {
      return await Promise.race([
        record.exited.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function terminate(record) {
    if (!record || (record.ended && (!record.redirected || record.workerExited))) return;
    if (record.terminating) return record.terminating;
    const attempt = (async () => {
      record.stopping = true;
      if (!record.ended) {
        try { record.child.kill('SIGTERM'); } catch (_) {}
        if (!await waitForExit(record, stopTimeoutMs)) {
          try { record.child.kill('SIGKILL'); } catch (_) {}
          if (!await waitForExit(record, killTimeoutMs)) {
            throw new Error('Could not stop the managed ComfyUI bridge Python process. Stop the backend and check that process before restarting.');
          }
        }
      }
      if (record.redirected && !record.workerExited) {
        // Windows venv launchers can exit before their Python worker. Its dual-PID
        // watchdog closes the listener; never signal a PID learned from HTTP.
        const deadline = now() + bridgeExitTimeoutMs;
        while (now() < deadline) {
          const result = await readHealth(record.port);
          if (result.state === 'absent' ||
              (result.state === 'healthy' && result.health.pid !== record.servicePid)) {
            record.workerExited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        if (!record.workerExited) {
          throw new Error('ComfyUI bridge worker did not stop after its Windows Python launcher exited. Check the bridge parent-process watchdog before restarting.');
        }
      }
      if (managed === record) managed = null;
    })();
    record.terminating = attempt;
    try {
      await attempt;
    } finally {
      if (record.terminating === attempt) record.terminating = null;
    }
  }

  function assertActive(epoch) {
    if (epoch !== generation) throw new Error('ComfyUI bridge startup was stopped. Retry after backend shutdown completes.');
  }

  function readHealth(port, challenge) {
    return new Promise((resolve) => {
      let settled = false;
      let request;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ state: 'occupied', reason: '/health timed out' });
        request?.destroy();
      }, healthTimeoutMs);
      try {
        request = http.get({
          hostname: '127.0.0.1', port, path: '/health', agent: false,
          headers: challenge ? { 'X-LMD-Bridge-Challenge': challenge } : {},
        }, (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) {
              finish({ state: 'occupied', reason: '/health response is too large' });
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (response.statusCode !== 200) {
              finish({ state: 'occupied', reason: `/health returned HTTP ${response.statusCode}` });
              return;
            }
            let health;
            try { health = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
            if (health?.service !== SERVICE || health.version !== VERSION ||
                !Number.isSafeInteger(health.pid) || health.pid <= 0 || !Array.isArray(health.models)) {
              finish({ state: 'occupied', reason: '/health is not a compatible LocalMiniDrama ComfyUI bridge' });
              return;
            }
            finish({ state: 'healthy', health });
          });
          response.once('error', () => finish({ state: 'occupied', reason: '/health response failed' }));
          response.once('aborted', () => finish({ state: 'occupied', reason: '/health response was interrupted' }));
        });
        request.once('error', (error) => {
          finish(error.code === 'ECONNREFUSED'
            ? { state: 'absent' }
            : { state: 'occupied', reason: '/health could not be reached' });
        });
      } catch (_) {
        finish({ state: 'occupied', reason: '/health could not be reached' });
      }
    });
  }

  async function isManagedHealth(record, result, epoch) {
    if (record.ended || record.error || result.state !== 'healthy') return false;
    const pid = result.health.pid;
    if (record.servicePid && record.servicePid !== pid) return false;
    if (pid === record.child.pid) {
      record.servicePid = pid;
      return true;
    }
    if (platform !== 'win32') return false;

    // Windows venv python.exe and py.exe may stay alive as redirectors while a
    // different PID serves HTTP. Prove possession of our inherited secret before
    // trusting that worker, without sending the secret to an unverified listener.
    const challenge = crypto.randomBytes(32).toString('hex');
    const proofResult = await readHealth(record.port, challenge);
    assertActive(epoch);
    if (record.ended || record.error || proofResult.state !== 'healthy') return false;
    const health = proofResult.health;
    if (health.pid !== pid || health.parent_pid !== parentProcess.pid ||
        health.launcher_pid !== record.child.pid || typeof health.auth_proof !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(health.auth_proof)) return false;
    const expected = crypto.createHmac('sha256', record.token)
      .update(`v1:${challenge}:${health.pid}:${health.parent_pid}:${health.launcher_pid}`)
      .digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(health.auth_proof, 'hex'))) return false;
    record.servicePid = pid;
    record.redirected = true;
    return true;
  }

  function portError(port, result) {
    const reason = result.state === 'healthy' ? 'another bridge process is already listening' : result.reason;
    return new Error(`ComfyUI bridge port ${port} is occupied: ${reason}. Stop that service or set comfyui_bridge.port to an unused port.`);
  }

  function pythonCandidates(config) {
    const candidates = [];
    const add = (command, args = []) => {
      if (typeof command !== 'string' || !command.trim()) return;
      command = command.trim();
      if (!candidates.some((item) => item.command === command && item.args.join(' ') === args.join(' '))) {
        candidates.push({ command, args });
      }
    };
    add(config.comfyui_bridge?.python);
    add(env.LMD_COMFYUI_PYTHON);
    const venvPython = path.resolve(backendDir, '..', '.venv', 'Scripts', 'python.exe');
    if (existsSync(venvPython)) add(venvPython);
    add('python3');
    add('python');
    if (platform === 'win32') add('py', ['-3']);
    return candidates;
  }

  function spawnOwned(candidate, args, token, role, log) {
    const child = spawnProcess(candidate.command, [...candidate.args, ...args], {
      cwd: backendDir,
      env: token ? { ...env, LMD_COMFY_BRIDGE_TOKEN: token } : { ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    return trackChild(child, role, log);
  }

  async function findPython(config, log, epoch) {
    for (const candidate of pythonCandidates(config)) {
      assertActive(epoch);
      let record;
      try {
        record = spawnOwned(candidate,
          ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], null, 'probe', log);
      } catch (_) {
        continue;
      }
      const exited = await waitForExit(record, probeTimeoutMs);
      if (!exited) await terminate(record);
      assertActive(epoch);
      if (exited && !record.error && record.code === 0) return candidate;
    }
    throw new Error('Python 3.10+ is required for the ComfyUI bridge. Install it and set comfyui_bridge.python or LMD_COMFYUI_PYTHON to its executable.');
  }

  async function ensureConnection(config, log, port, epoch) {
    let result = await readHealth(port);
    assertActive(epoch);
    const current = managed;
    if (current && (!current.ended || current.redirected)) {
      if (current.port !== port) {
        throw new Error(`ComfyUI bridge is already managed on port ${current.port}. Call stopComfyUIBridge before changing comfyui_bridge.port.`);
      }
      const owned = await isManagedHealth(current, result, epoch);
      assertActive(epoch);
      if (owned && !current.ended) {
        return { baseUrl: current.baseUrl, token: current.token };
      }
      await terminate(current);
      assertActive(epoch);
      result = await readHealth(port);
      assertActive(epoch);
    }
    if (result.state !== 'absent') throw portError(port, result);

    const scriptPath = path.join(backendDir, 'scripts', 'comfyui_bridge.py');
    if (!existsSync(scriptPath)) {
      throw new Error('ComfyUI bridge script is missing. Restore backend-node/scripts/comfyui_bridge.py and restart the backend.');
    }
    const candidate = await findPython(config, log, epoch);
    assertActive(epoch);
    // Recheck after interpreter discovery so another listener cannot be adopted.
    result = await readHealth(port);
    assertActive(epoch);
    if (result.state !== 'absent') throw portError(port, result);
    const token = env.LMD_COMFY_BRIDGE_TOKEN || crypto.randomBytes(32).toString('hex');
    let record;
    try {
      record = spawnOwned(candidate, [
        scriptPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--data-dir', path.join(backendDir, 'data', 'comfyui-bridge'),
        '--parent-pid', String(parentProcess.pid),
      ], token, 'bridge', log);
    } catch (_) {
      throw new Error('Could not start the ComfyUI bridge Python process. Check comfyui_bridge.python and the Python installation.');
    }
    record.port = port;
    record.baseUrl = `http://127.0.0.1:${port}`;
    record.token = token;
    managed = record;
    try {
      const deadline = now() + startupTimeoutMs;
      while (now() < deadline) {
        assertActive(epoch);
        if (record.ended || record.error) {
          throw new Error('ComfyUI bridge Python exited before becoming ready. Check the Python bridge output and Python 3.10+ installation.');
        }
        result = await readHealth(port);
        assertActive(epoch);
        if (record.ended || record.error) {
          throw new Error('ComfyUI bridge Python exited before becoming ready. Check the Python bridge output and Python 3.10+ installation.');
        }
        const owned = await isManagedHealth(record, result, epoch);
        assertActive(epoch);
        if (owned && !record.ended) {
          record.ready = true;
          logMessage(log, 'info', 'ComfyUI bridge is ready', { baseUrl: record.baseUrl, pid: record.servicePid });
          return { baseUrl: record.baseUrl, token: record.token };
        }
        if (result.state !== 'absent') throw portError(port, result);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      throw new Error(`ComfyUI bridge did not become ready within ${startupTimeoutMs}ms. Check the Python bridge output and comfyui_bridge.port.`);
    } catch (error) {
      await terminate(record);
      throw error;
    }
  }

  async function startComfyUIBridge({ config, log } = {}) {
    // Video clients may pass an AI model config; it contains no bridge settings.
    const isBackendConfig = config && typeof config === 'object' &&
      ['app', 'server', 'comfyui_bridge'].some((key) => Object.hasOwn(config, key));
    config = isBackendConfig ? config : (lastConfig ?? loadConfig());
    log = log ?? lastLog;
    if (config.comfyui_bridge?.enabled === false) {
      throw new Error('ComfyUI bridge is disabled. Set comfyui_bridge.enabled to true and restart the backend to use local video generation.');
    }
    const rawPort = config.comfyui_bridge?.port ?? 5681;
    const port = Number(rawPort);
    if (!['number', 'string'].includes(typeof rawPort) ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('comfyui_bridge.port must be an integer between 1 and 65535.');
    }
    lastConfig = config;
    lastLog = log;
    if (stopping) await stopping;
    if (starting) {
      if (startingPort !== port) {
        throw new Error('ComfyUI bridge is starting on another port. Call stopComfyUIBridge before changing comfyui_bridge.port.');
      }
      return starting;
    }
    startingPort = port;
    const attempt = ensureConnection(config, log, port, generation);
    starting = attempt;
    try {
      return await attempt;
    } finally {
      if (starting === attempt) {
        starting = null;
        startingPort = null;
      }
    }
  }

  async function getComfyUIBridgeConnection(options = {}) {
    return startComfyUIBridge(options);
  }

  async function stopComfyUIBridge() {
    if (stopping) return stopping;
    generation += 1;
    const attempt = (async () => {
      const records = new Set(ownedChildren);
      if (managed) records.add(managed);
      await Promise.all([...records].map(terminate));
      if (starting) await starting.catch(() => {});
    })();
    stopping = attempt;
    try {
      await attempt;
    } finally {
      if (stopping === attempt) stopping = null;
    }
  }

  return { startComfyUIBridge, getComfyUIBridgeConnection, stopComfyUIBridge };
}

module.exports = { ...createComfyUIBridgeProcess(), createComfyUIBridgeProcess };
