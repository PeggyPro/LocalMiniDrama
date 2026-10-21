const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const videoService = require('../src/services/videoService');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      storyboard_id INTEGER,
      provider TEXT,
      prompt TEXT,
      model TEXT,
      status TEXT,
      task_id TEXT,
      provider_task_id TEXT,
      error_msg TEXT,
      video_url TEXT,
      local_path TEXT,
      image_gen_id INTEGER,
      image_url TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

const silentLog = { info() {}, warn() {}, error() {} };

describe('videoService.resumeFailedVideoPoll', () => {
  afterEach(async () => {
    // 让 setImmediate 里的恢复逻辑跑完，避免污染后续用例
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
  });

  it('exposes can_resume_poll only for failed rows with provider_task_id', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, status, task_id, provider_task_id, error_msg, created_at, updated_at)
       VALUES (1, 10, 'relay', 'p', 'failed', 't1', 'task_upstream_1', '超时', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, status, task_id, provider_task_id, error_msg, created_at, updated_at)
       VALUES (1, 10, 'relay', 'p', 'failed', 't2', NULL, '提交失败', ?, ?)`
    ).run(now, now);

    const withId = videoService.getById(db, 1);
    const withoutId = videoService.getById(db, 2);
    assert.equal(withId.can_resume_poll, true);
    assert.equal(withoutId.can_resume_poll, false);
    assert.equal(withId.provider_task_id, undefined);
  });

  it('rejects when missing provider_task_id', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, status, error_msg, created_at, updated_at)
       VALUES (1, 10, 'relay', 'p', 'failed', '无 task', ?, ?)`
    ).run(now, now);
    const result = videoService.resumeFailedVideoPoll(db, silentLog, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  it('resumes with a new tracking task and leaves terminal task history unchanged', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks
        (id, type, status, progress, message, error, resource_id, created_at, updated_at, completed_at)
       VALUES ('task-uuid-1', 'video_generation', 'failed', 0, '', '超时或失败', '1', ?, ?, ?)`
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO video_generations
        (drama_id, storyboard_id, provider, prompt, model, status, task_id, provider_task_id, error_msg, created_at, updated_at)
       VALUES (1, 10, 'relay', 'p', 'm', 'failed', 'task-uuid-1', 'task_KOcn_demo', '超时或失败', ?, ?)`
    ).run(now, now);

    const result = videoService.resumeFailedVideoPoll(db, silentLog, 1);
    assert.equal(result.ok, true);
    assert.equal(result.item.status, 'processing');
    assert.equal(result.item.error_msg, '');
    assert.equal(result.item.can_resume_poll, false);
    assert.notEqual(result.item.task_id, 'task-uuid-1');

    const previous = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get('task-uuid-1');
    assert.equal(previous.status, 'failed');
    assert.equal(previous.error, '超时或失败');
    const task = db.prepare('SELECT status, progress, message, error FROM async_tasks WHERE id = ?').get(result.item.task_id);
    assert.equal(task.status, 'processing');
    assert.equal(task.progress, 10);
    assert.equal(task.error, null);
    assert.match(String(task.message || ''), /继续查询/);
    // Repeated clicks before the scheduled poll starts do not allocate another attempt.
    assert.equal(videoService.resumeFailedVideoPoll(db, silentLog, 1).item.task_id, result.item.task_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 2);
  });

  it('startup recovery creates a new tracking attempt after orphaned tasks were failed', async () => {
    const db = createTestDb();
    const videoClient = require('../src/services/videoClient');
    const getConfig = videoClient.getDefaultVideoConfig;
    videoClient.getDefaultVideoConfig = () => null;
    try {
      db.prepare(`INSERT INTO async_tasks (id, type, status, error, resource_id)
        VALUES ('before-restart', 'video_generation', 'failed', '服务重启后任务中断', '1')`).run();
      db.prepare(`INSERT INTO video_generations (drama_id, status, task_id, provider_task_id)
        VALUES (1, 'processing', 'before-restart', 'existing-provider-task')`).run();
      videoService.resumeProcessingVideoGenerations(db, silentLog);
      await new Promise((resolve) => setImmediate(resolve));
      const video = db.prepare('SELECT * FROM video_generations WHERE id = 1').get();
      assert.notEqual(video.task_id, 'before-restart');
      const previous = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get('before-restart');
      assert.equal(previous.status, 'failed');
      assert.equal(previous.error, '服务重启后任务中断');
      const current = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(video.task_id);
      assert.equal(current.type, 'video_generation');
      assert.equal(current.error, '未配置视频模型');
    } finally {
      videoClient.getDefaultVideoConfig = getConfig;
      db.close();
    }
  });
});
