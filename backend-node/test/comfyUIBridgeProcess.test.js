const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {
  createComfyUIBridgeProcess,
  startComfyUIBridge,
  getComfyUIBridgeConnection,
  stopComfyUIBridge,
} = require('../src/services/comfyUIBridgeProcess');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SERVICE = 'localminidrama-comfyui-bridge';

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function harness(t, options = {}) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const parentProcess = new EventEmitter();
  parentProcess.pid = 12345;
  const calls = [];
  const children = [];
  const servers = [];
  const logs = [];
  let nextPid = 40000;
  let configLoads = 0;
  const config = { comfyui_bridge: { port, ...options.bridgeConfig } };
  const env = { ...options.env };
  const log = {
    info: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
  };
  function fakeSpawn(command, args, spawnOptions) {
    calls.push({ command, args, options: spawnOptions });
    if (options.throwSpawn?.(command, args)) throw new Error('spawn failed');
    const probe = args.includes('-c');
    const outcome = probe ? (options.probe?.(command, args) ?? 0) : 0;
    const child = new EventEmitter();
    child.pid = outcome === 'ENOENT' ? undefined : ++nextPid;
    child.signals = [];
    child.ended = false;
    child.finish = (code = 0, signal = null) => {
      if (child.ended) return;
      child.ended = true;
      child.emit('exit', code, signal);
    };
    child.die = async (code = 1, signal = null) => {
      await close(child.server);
      child.finish(code, signal);
    };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === 'SIGTERM' && options.ignoreTerm) return true;
      queueMicrotask(() => {
        if (options.detachedWorker && child.server) child.finish(0, signal);
        else child.die(0, signal);
      });
      return true;
    };
    children.push(child);
    if (probe) {
      if (outcome !== 'hang') {
        queueMicrotask(() => {
          if (outcome === 'ENOENT') child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
          else child.finish(outcome);
        });
      }
    } else if (options.bridgeExits) {
      queueMicrotask(() => child.finish(1));
    } else if (!options.noServer) {
      child.server = http.createServer((request, response) => {
        options.onHealth?.(request);
        const body = options.healthBody?.(child, request, spawnOptions) ?? {
          service: SERVICE, version: 1, pid: child.pid, models: ['test-model'],
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      servers.push(child.server);
      child.server.listen(port, '127.0.0.1');
    }
    return child;
  }
  const bridge = createComfyUIBridgeProcess({
    spawn: fakeSpawn,
    parentProcess,
    env,
    platform: options.platform || 'win32',
    backendDir: BACKEND_DIR,
    existsSync: (file) => file.endsWith('bridge.py') ? !options.missingScript : Boolean(options.venv),
    loadConfig: () => { configLoads += 1; return config; },
    healthTimeoutMs: 60,
    startupTimeoutMs: 120,
    probeTimeoutMs: 30,
    pollIntervalMs: 2,
    stopTimeoutMs: 20,
    killTimeoutMs: 20,
    bridgeExitTimeoutMs: 100,
  });
  t.after(async () => {
    await bridge.stopComfyUIBridge();
    for (const server of servers) await close(server);
  });
  return {
    bridge, config, env, log, logs, calls, children, parentProcess, port,
    get configLoads() { return configLoads; },
    async occupy(handler) {
      const server = http.createServer(handler);
      servers.push(server);
      await listen(server, port);
      return server;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('test condition did not become ready');
}

test('exports the three async process lifecycle entry points', () => {
  assert.equal(startComfyUIBridge.constructor.name, 'AsyncFunction');
  assert.equal(getComfyUIBridgeConnection.constructor.name, 'AsyncFunction');
  assert.equal(stopComfyUIBridge.constructor.name, 'AsyncFunction');
});

test('coalesces concurrent starts and reuses only the healthy managed PID', async (t) => {
  const h = await harness(t, {
    bridgeConfig: { python: 'C:\\Python With Spaces\\python.exe' },
    env: { LMD_COMFY_BRIDGE_TOKEN: 'test-bridge-token', UNRELATED_SECRET: 'test-other-secret' },
    onHealth(request) {
      assert.equal(request.url, '/health');
      assert.equal(request.headers.authorization, undefined);
    },
  });
  const results = await Promise.all([
    h.bridge.startComfyUIBridge({ config: h.config, log: h.log }),
    h.bridge.startComfyUIBridge({ config: h.config, log: h.log }),
    h.bridge.getComfyUIBridgeConnection({ config: h.config, log: h.log }),
  ]);
  assert.deepEqual(results[0], { baseUrl: `http://127.0.0.1:${h.port}`, token: 'test-bridge-token' });
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.deepEqual(await h.bridge.getComfyUIBridgeConnection(), results[0]);
  assert.equal(h.calls.length, 2, 'one version probe and one bridge process');
  const launch = h.calls[1];
  assert.equal(launch.command, 'C:\\Python With Spaces\\python.exe');
  assert.deepEqual(launch.args, [
    path.join(BACKEND_DIR, 'scripts', 'comfyui_bridge.py'),
    '--host', '127.0.0.1', '--port', String(h.port),
    '--data-dir', path.join(BACKEND_DIR, 'data', 'comfyui-bridge'),
    '--parent-pid', '12345',
  ]);
  for (const call of h.calls) {
    assert.deepEqual(call.options.stdio, ['ignore', 'inherit', 'inherit']);
    assert.equal(call.options.cwd, BACKEND_DIR);
    assert.equal(call.options.shell, undefined);
  }
  assert.equal(launch.options.env.LMD_COMFY_BRIDGE_TOKEN, results[0].token);
  assert.equal(JSON.stringify(h.logs).includes('test-bridge-token'), false);
  assert.equal(JSON.stringify(h.logs).includes('test-other-secret'), false);
});

test('lazy clients load global bridge settings rather than AI credentials', async (t) => {
  const h = await harness(t);
  const connection = await h.bridge.getComfyUIBridgeConnection({
    config: { base_url: 'https://unrelated.example', api_key: 'test-api-secret', port: 9999 }, log: h.log,
  });
  assert.equal(connection.baseUrl, `http://127.0.0.1:${h.port}`);
  assert.match(connection.token, /^[a-f0-9]{64}$/);
  assert.equal(h.configLoads, 1);
  assert.deepEqual(await h.bridge.getComfyUIBridgeConnection(), connection);
  assert.equal(h.configLoads, 1);
  assert.equal(JSON.stringify(h.logs).includes('test-api-secret'), false);
  assert.equal(h.calls[1].options.env.LMD_COMFY_BRIDGE_TOKEN, connection.token);
});

test('rejects disabled and invalid bridge settings before spawning', async (t) => {
  const h = await harness(t);
  await assert.rejects(h.bridge.startComfyUIBridge({ config: { comfyui_bridge: { enabled: false } } }), /disabled.*enabled to true/);
  for (const port of [0, -1, 1.5, 65536, 'invalid', true, false, [5681]]) {
    await assert.rejects(h.bridge.startComfyUIBridge({ config: { comfyui_bridge: { port } } }), /integer between 1 and 65535/);
  }
  assert.equal(h.calls.length, 0);
});

test('refuses occupied ports without spawning or killing their listener', async (t) => {
  const cases = [
    ['unrelated service', 200, JSON.stringify({ service: 'other', version: 1, pid: 1, models: [] })],
    ['incompatible version', 200, JSON.stringify({ service: SERVICE, version: 2, pid: 1, models: [] })],
    ['incomplete health', 200, JSON.stringify({ service: SERVICE, version: 1, pid: 1 })],
    ['invalid JSON', 200, 'not-json'],
    ['HTTP error', 403, '{}'],
    ['unmanaged bridge', 200, JSON.stringify({ service: SERVICE, version: 1, pid: 1, models: [] })],
    ['oversized response', 200, 'x'.repeat(65537)],
  ];
  for (const [name, status, body] of cases) {
    await t.test(name, async (t) => {
      const h = await harness(t);
      const server = await h.occupy((request, response) => { response.writeHead(status); response.end(body); });
      await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /port .* occupied.*comfyui_bridge.port/);
      assert.equal(h.calls.length, 0);
      assert.equal(server.listening, true);
    });
  }
});

test('bounds an unresponsive occupied-port health check', async (t) => {
  const h = await harness(t);
  const server = await h.occupy(() => {});
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /occupied: \/health timed out/);
  assert.equal(h.calls.length, 0);
  assert.equal(server.listening, true);
});

test('rejects a healthy service with the wrong child PID and stops only its own child', async (t) => {
  const h = await harness(t, {
    healthBody: () => ({ service: SERVICE, version: 1, pid: 99999, models: [] }),
  });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /another bridge process/);
  const child = h.children.at(-1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.ended, true);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
});

function launcherHealth(child, request, spawnOptions, overrides = {}) {
  const health = { service: SERVICE, version: 1, pid: child.pid + 1000, models: ['test-model'] };
  const challenge = request.headers['x-lmd-bridge-challenge'];
  if (challenge) {
    health.parent_pid = 12345;
    health.launcher_pid = child.pid;
    Object.assign(health, overrides);
    health.auth_proof = crypto.createHmac('sha256', spawnOptions.env.LMD_COMFY_BRIDGE_TOKEN)
      .update(`v1:${challenge}:${health.pid}:${health.parent_pid}:${health.launcher_pid}`)
      .digest('hex');
  }
  return health;
}

test('accepts a Windows venv worker only with fresh secret proof and matching parent and launcher PIDs', async (t) => {
  const challenges = [];
  const proofs = [];
  const h = await harness(t, {
    venv: true,
    env: { LMD_COMFY_BRIDGE_TOKEN: 'test-launcher-secret' },
    onHealth(request) {
      assert.equal(request.headers.authorization, undefined, 'never send a token to an unverified listener');
      if (request.headers['x-lmd-bridge-challenge']) challenges.push(request.headers['x-lmd-bridge-challenge']);
    },
    healthBody(child, request, spawnOptions) {
      const health = launcherHealth(child, request, spawnOptions);
      if (health.auth_proof) proofs.push(health.auth_proof);
      return health;
    },
  });
  const first = await h.bridge.startComfyUIBridge({ config: h.config, log: h.log });
  assert.deepEqual(await h.bridge.getComfyUIBridgeConnection(), first);
  assert.equal(h.calls.length, 2, 'worker is reused rather than spawning a second redirector');
  assert.equal(h.calls[1].command, path.resolve(BACKEND_DIR, '..', '.venv', 'Scripts', 'python.exe'));
  assert.equal(challenges.length, 2);
  assert.equal(new Set(challenges).size, 2, 'each validation uses a fresh challenge');
  assert.equal(challenges.every((challenge) => /^[a-f0-9]{64}$/.test(challenge)), true);
  assert.equal(h.logs[0][1].pid, h.children.at(-1).pid + 1000);
  const logged = JSON.stringify(h.logs);
  assert.equal(logged.includes(first.token), false);
  assert.equal(proofs.some((proof) => logged.includes(proof)), false);
});

test('rejects Windows worker claims without both a valid proof and the expected process relationship', async (t) => {
  const cases = [
    ['boolean authentication claim', (health) => { delete health.auth_proof; health.authenticated = true; }],
    ['wrong token', (health) => { health.auth_proof = '0'.repeat(64); }],
    ['malformed proof', (health) => { health.auth_proof = 'invalid'; }],
    ['wrong parent PID', null, { parent_pid: 54321 }],
    ['wrong launcher PID', null, { launcher_pid: 54321 }],
    ['changed worker PID', null, { pid: 54321 }],
  ];
  for (const [name, tamper, overrides] of cases) {
    await t.test(name, async (t) => {
      const h = await harness(t, {
        healthBody(child, request, spawnOptions) {
          assert.equal(request.headers.authorization, undefined);
          const health = launcherHealth(child, request, spawnOptions, overrides);
          if (request.headers['x-lmd-bridge-challenge']) tamper?.(health);
          return health;
        },
      });
      await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /another bridge process/);
      assert.deepEqual(h.children.at(-1).signals, ['SIGTERM']);
      assert.equal(h.parentProcess.listenerCount('exit'), 0);
    });
  }
});

test('does not allow a launcher PID mismatch on other platforms even with a valid proof', async (t) => {
  let challenges = 0;
  const h = await harness(t, {
    platform: 'linux',
    healthBody(child, request, spawnOptions) {
      if (request.headers['x-lmd-bridge-challenge']) challenges += 1;
      return launcherHealth(child, request, spawnOptions);
    },
  });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /another bridge process/);
  assert.equal(challenges, 0);
});

test('refuses a preexisting launcher worker without sending a proof challenge or spawning', async (t) => {
  const h = await harness(t);
  let challenges = 0;
  const server = await h.occupy((request, response) => {
    if (request.headers['x-lmd-bridge-challenge']) challenges += 1;
    assert.equal(request.headers.authorization, undefined);
    response.end(JSON.stringify({ service: SERVICE, version: 1, pid: 99999, models: [], parent_pid: 12345, launcher_pid: 40002 }));
  });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /another bridge process/);
  assert.equal(challenges, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(server.listening, true);
});

test('rejects a replayed launcher health proof instead of returning a cached connection', async (t) => {
  let firstProof;
  const h = await harness(t, {
    healthBody(child, request, spawnOptions) {
      const health = launcherHealth(child, request, spawnOptions);
      if (health.auth_proof) {
        firstProof ??= health.auth_proof;
        health.auth_proof = firstProof;
      }
      return health;
    },
  });
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  await assert.rejects(h.bridge.getComfyUIBridgeConnection(), /another bridge process/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.ended, true);
});

test('waits for the verified worker listener after stopping its Windows launcher', async (t) => {
  const h = await harness(t, { detachedWorker: true, healthBody: launcherHealth });
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  const stopping = h.bridge.stopComfyUIBridge();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await until(() => child.ended);
  assert.equal(child.server.listening, true, 'worker can briefly outlive its redirector');
  assert.equal(stopped, false, 'stop waits for the worker watchdog');
  await close(child.server);
  await stopping;
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.server.listening, false);
});

test('lazy recovery waits for an already-dead launcher worker before spawning again', async (t) => {
  const h = await harness(t, { healthBody: launcherHealth });
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  child.finish(1);
  const recovering = h.bridge.getComfyUIBridgeConnection();
  assert.equal(h.calls.length, 2);
  await tick();
  await close(child.server);
  await recovering;
  assert.equal(h.calls.length, 4);
  assert.deepEqual(child.signals, [], 'an already-exited launcher is never signaled');
});

test('bounds worker-watchdog failure without signaling the HTTP-reported PID', async (t) => {
  const h = await harness(t, { detachedWorker: true, healthBody: launcherHealth });
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  await assert.rejects(h.bridge.stopComfyUIBridge(), /worker did not stop.*watchdog/);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.server.listening, true);
  await close(child.server);
  await h.bridge.stopComfyUIBridge();
});

test('checks Python 3.10+ in configured, environment, and project-venv order', async (t) => {
  const venv = path.resolve(BACKEND_DIR, '..', '.venv', 'Scripts', 'python.exe');
  const h = await harness(t, {
    venv: true,
    bridgeConfig: { python: 'configured-python' },
    env: { LMD_COMFYUI_PYTHON: 'environment-python' },
    probe(command) {
      if (command === 'configured-python') return 1;
      if (command === 'environment-python') return 'ENOENT';
      return 0;
    },
  });
  await h.bridge.startComfyUIBridge({ config: h.config });
  assert.deepEqual(h.calls.map((call) => call.command), ['configured-python', 'environment-python', venv, venv]);
  for (const call of h.calls.slice(0, -1)) {
    assert.equal(call.args[0], '-c');
    assert.match(call.args[1], /sys.version_info >= \(3, 10\)/);
  }
});

test('supports the Windows py -3 launcher after missing Python commands', async (t) => {
  const h = await harness(t, { probe: (command) => command === 'py' ? 0 : 'ENOENT' });
  await h.bridge.startComfyUIBridge({ config: h.config });
  assert.deepEqual(h.calls.map((call) => call.command), ['python3', 'python', 'py', 'py']);
  assert.deepEqual(h.calls[2].args.slice(0, 2), ['-3', '-c']);
  assert.equal(h.calls[3].args[0], '-3');
});

test('reports missing or old Python actionably without retaining child handles', async (t) => {
  const h = await harness(t, { probe: () => 1 });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /Python 3.10\+.*comfyui_bridge.python.*LMD_COMFYUI_PYTHON/);
  assert.equal(h.calls.length, 3);
  assert.equal(h.children.every((child) => child.ended), true);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
});

test('times out and terminates interpreter probes before trying another candidate', async (t) => {
  const h = await harness(t, { probe: (command) => command === 'python3' ? 'hang' : 0 });
  await h.bridge.startComfyUIBridge({ config: h.config });
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  assert.deepEqual(h.calls.map((call) => call.command), ['python3', 'python', 'python']);
});

test('fails a missing in-project Python script before interpreter discovery', async (t) => {
  const h = await harness(t, { missingScript: true });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /script is missing/);
  assert.equal(h.calls.length, 0);
});

test('cleans up a bridge that never listens and permits a later retry', async (t) => {
  const h = await harness(t, { noServer: true });
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /did not become ready/);
  assert.equal(h.children.at(-1).ended, true);
  assert.deepEqual(h.children.at(-1).signals, ['SIGTERM']);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
  await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /did not become ready/);
  assert.equal(h.calls.length, 4, 'failed startup promise does not block retries');
});

test('detects early bridge death and cleans up spawn failures', async (t) => {
  await t.test('early death', async (t) => {
    const h = await harness(t, { bridgeExits: true });
    await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /exited before becoming ready/);
    assert.equal(h.parentProcess.listenerCount('exit'), 0);
  });
  await t.test('synchronous bridge spawn failure', async (t) => {
    const h = await harness(t, { throwSpawn: (_command, args) => !args.includes('-c') });
    await assert.rejects(h.bridge.startComfyUIBridge({ config: h.config }), /Could not start.*Python process/);
    assert.equal(h.parentProcess.listenerCount('exit'), 0);
  });
});

test('resets a dead process and lazily recovers using remembered global settings', async (t) => {
  const h = await harness(t);
  const first = await h.bridge.startComfyUIBridge({ config: h.config, log: h.log });
  const child = h.children.at(-1);
  await child.die(1);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
  const second = await h.bridge.getComfyUIBridgeConnection();
  assert.equal(second.baseUrl, first.baseUrl);
  assert.notEqual(second.token, first.token);
  assert.equal(h.calls.length, 4);
  assert.equal(h.children.at(-1).pid !== child.pid, true);
  assert.equal(h.logs.some((entry) => entry[0].includes('next video request will restart')), true);
});

test('restarts an owned process whose health listener has disappeared', async (t) => {
  const h = await harness(t);
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  await close(child.server);
  assert.equal(child.ended, false);
  await h.bridge.getComfyUIBridgeConnection();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.ended, true);
  assert.equal(h.calls.length, 4);
});

test('shutdown is idempotent, reaps its child, and permits explicit restart', async (t) => {
  const h = await harness(t);
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  await Promise.all([h.bridge.stopComfyUIBridge(), h.bridge.stopComfyUIBridge()]);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.ended, true);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
  await h.bridge.startComfyUIBridge();
  assert.equal(h.calls.length, 4);
});

test('escalates termination only for its own unresponsive child', async (t) => {
  const h = await harness(t, { ignoreTerm: true });
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  await h.bridge.stopComfyUIBridge();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.ended, true);
});

test('shutdown cancels an in-flight startup and leaves no interpreter running', async (t) => {
  const h = await harness(t, { probe: () => 'hang' });
  const starting = h.bridge.startComfyUIBridge({ config: h.config });
  const rejection = assert.rejects(starting, /startup was stopped/);
  await until(() => h.calls.length === 1);
  await h.bridge.stopComfyUIBridge();
  await rejection;
  assert.equal(h.calls.length, 1, 'no further interpreter or bridge launches after shutdown');
  assert.equal(h.children[0].ended, true);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
});

test('shutdown during bridge readiness reaps the child only once', async (t) => {
  const h = await harness(t, { noServer: true });
  const starting = h.bridge.startComfyUIBridge({ config: h.config });
  const rejection = assert.rejects(starting, /startup was stopped/);
  await until(() => h.calls.length === 2);
  await h.bridge.stopComfyUIBridge();
  await rejection;
  assert.deepEqual(h.children.at(-1).signals, ['SIGTERM']);
  assert.equal(h.children.at(-1).ended, true);
  assert.equal(h.parentProcess.listenerCount('exit'), 0);
});

test('parent exit synchronously signals only children owned by this manager', async (t) => {
  const h = await harness(t);
  await h.bridge.startComfyUIBridge({ config: h.config });
  const child = h.children.at(-1);
  h.parentProcess.emit('exit', 0);
  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal(h.children[0].signals.length, 0, 'already-exited version probe is not signaled');
  await child.die(0);
});

function serverHarness(options = {}) {
  const source = fs.readFileSync(path.join(BACKEND_DIR, 'src', 'server.js'), 'utf8');
  const parentProcess = new EventEmitter();
  parentProcess.env = {};
  const calls = { listen: 0, closeHttp: 0, closeDb: 0, stopBridge: 0, exits: [], logs: [], timers: new Set() };
  const logger = Object.fromEntries(['info', 'warn'].map((level) => [level, (...args) => calls.logs.push({ level, args })]));
  parentProcess.exit = (code) => calls.exits.push(code);
  const config = { app: { name: 'test' }, server: {}, database: { path: 'unused.db' } };
  const dependencies = {
    './config/index.js': { loadConfig: () => config },
    './app.js': { createApp: () => ({
      app: { listen(_port, _host, onListen) {
        calls.listen += 1;
        queueMicrotask(onListen);
        return {
          close(callback) { calls.closeHttp += 1; queueMicrotask(() => callback()); },
          closeIdleConnections() {},
        };
      } }, config, db: {},
    }) },
    './db/index.js': { closeDb: () => { calls.closeDb += 1; } },
    './logger.js': logger,
    './services/comfyUIBridgeProcess.js': {
      startComfyUIBridge: options.startBridge || (async () => { throw new Error('Python is unavailable'); }),
      stopComfyUIBridge: async () => { calls.stopBridge += 1; options.onStop?.(); },
    },
    path,
  };
  const script = new vm.Script(source, {
    filename: path.join(BACKEND_DIR, 'src', 'server.js'),
    importModuleDynamically: async () => { throw new Error('test assistant is unavailable'); },
  });
  script.runInNewContext({
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected require: ${name}`);
      return dependencies[name];
    },
    process: parentProcess,
    console: { warn() {} },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      calls.timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { calls.timers.delete(timer); },
  });
  return { parentProcess, calls };
}

test('backend remains available after bridge startup failure and closes HTTP and child on shutdown', async () => {
  const h = serverHarness();
  await until(() => h.calls.listen === 1);
  assert.equal(h.calls.logs.some((entry) => entry.level === 'warn' && entry.args[1].error === 'Python is unavailable'), true);
  h.parentProcess.emit('SIGTERM');
  h.parentProcess.emit('SIGINT');
  await until(() => h.calls.exits.length === 1);
  assert.equal(h.calls.closeHttp, 1);
  assert.equal(h.calls.stopBridge, 1);
  assert.equal(h.calls.closeDb, 1);
  assert.deepEqual(h.calls.exits, [0]);
  assert.equal(h.calls.timers.size, 0);
});

test('backend shutdown before HTTP startup is safe and prevents late listen', async () => {
  let rejectStartup;
  const h = serverHarness({
    startBridge: () => new Promise((_resolve, reject) => { rejectStartup = reject; }),
    onStop: () => rejectStartup(new Error('startup stopped')),
  });
  h.parentProcess.emit('SIGINT');
  await until(() => h.calls.exits.length === 1);
  assert.equal(h.calls.listen, 0);
  assert.equal(h.calls.closeHttp, 0);
  assert.equal(h.calls.stopBridge, 1);
  assert.equal(h.calls.closeDb, 1);
  assert.deepEqual(h.calls.exits, [0]);
  assert.equal(h.calls.timers.size, 0);
});
