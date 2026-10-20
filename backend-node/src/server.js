const { loadConfig } = require('./config/index.js');

const preConfig = loadConfig();
const tlsFlag = preConfig.server?.insecure_tls ?? preConfig.server?.INSECURE_TLS;
const insecureTlsOn =
  tlsFlag === true ||
  tlsFlag === 1 ||
  tlsFlag === '1' ||
  String(tlsFlag).toLowerCase() === 'true';
if (insecureTlsOn) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[config] server.insecure_tls 已启用：全局跳过 TLS 证书校验，仅用于测试');
}

const { createApp } = require('./app.js');
const { closeDb } = require('./db/index.js');
const logger = require('./logger.js');
const { startComfyUIBridge, stopComfyUIBridge } = require('./services/comfyUIBridgeProcess.js');

const path = require('path');
const { app, config, db } = createApp();
const port = Number(process.env.PORT) || config.server?.port || 5680;
const host = config.server?.host || '0.0.0.0';

let server;
let shuttingDown = false;
async function start() {
  try {
    await startComfyUIBridge({ config, log: logger });
  } catch (err) {
    logger.warn('ComfyUI bridge 未就绪，本地视频生成暂不可用', { error: err.message });
  }
  if (shuttingDown) return;
  try {
    const { initAgent } = await import('./mastra/index.mjs');
    const dataDir = path.resolve(path.dirname(config.database.path));
    await initAgent({ db, log: logger, config, dataDir });
  } catch (err) {
    logger.warn('助手未就绪', { error: err.message });
  }
  if (shuttingDown) return;
  server = app.listen(port, host, () => {
    logger.info('Server starting', { port, host });
    logger.info('Frontend:  http://localhost:' + port);
    logger.info('API:       http://localhost:' + port + '/api/v1');
    logger.info('Health:    http://localhost:' + port + '/health');
    logger.info('Server is ready!');
  });
}
start();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down server...');
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  const closeHttp = server
    ? new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    })
    : Promise.resolve();
  const results = await Promise.allSettled([closeHttp, stopComfyUIBridge()]);
  let failed = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      failed = true;
      logger.warn('Server shutdown cleanup failed', { error: result.reason.message });
    }
  }
  try {
    closeDb();
  } catch (err) {
    failed = true;
    logger.warn('Database shutdown failed', { error: err.message });
  }
  clearTimeout(deadline);
  logger.info('Server exited');
  process.exit(failed ? 1 : 0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
