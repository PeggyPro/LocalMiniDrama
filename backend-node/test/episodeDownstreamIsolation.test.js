const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiClient = require('../src/services/aiClient');
const taskService = require('../src/services/taskService');
const config = require('../src/config');
const cfg = { app: { name: 'test' }, style: { default_style: '', default_video_ratio: '16:9' } };
// Capture a deterministic config in the service without touching the user's config or database.
const originalLoadConfig = config.loadConfig;
config.loadConfig = () => cfg;
const storyboardService = require('../src/services/episodeStoryboardService');
config.loadConfig = originalLoadConfig;
const propExtraction = require('../src/services/propExtractionService');
const log = { info() {}, warn() {}, error() {} };

function createDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, title TEXT, script_content TEXT,
      description TEXT, duration INTEGER, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, appearance TEXT, deleted_at TEXT);
    CREATE TABLE episode_characters (episode_id INTEGER, character_id INTEGER);
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT,
      prompt TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, episode_id INTEGER, name TEXT,
      type TEXT, description TEXT, prompt TEXT, negative_prompt TEXT, image_url TEXT, local_path TEXT,
      extra_images TEXT, ref_image TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER,
      dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT,
      image_prompt TEXT, video_prompt TEXT, characters TEXT, shot_type TEXT, angle TEXT,
      angle_h TEXT, angle_v TEXT, angle_s TEXT, movement TEXT, lighting_style TEXT, depth_of_field TEXT,
      segment_index INTEGER, segment_title TEXT, creation_mode TEXT, universal_segment_text TEXT,
      status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (id INTEGER PRIMARY KEY, storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER, UNIQUE (storyboard_id, prop_id));
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER DEFAULT 0, message TEXT,
      error TEXT, result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT
    );
    INSERT INTO dramas (id, title) VALUES (1, '本剧'), (2, '其他剧');
    INSERT INTO episodes (id, drama_id, title, script_content, description, duration)
      VALUES (1, 1, '本集', '本集独立剧本正文。', '本集构思，不是剧本', 12),
             (2, 1, '另集', '另集独立剧本正文。', '另集构思', 34),
             (3, 2, '其他剧集', '其他剧集正文。', '', 56);
  `);
  return db;
}

function rows(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function seedProps(db) {
  db.exec(`
    INSERT INTO props (id, drama_id, episode_id, name, prompt, image_url, local_path, extra_images, ref_image, updated_at)
      VALUES (1, 1, 2, '钥匙', '另集提示词', '/other-key.png', '/other-key-local.png', '["other"]', 'other-ref', 'old-other'),
             (2, 1, 1, '钥匙', '本集旧提示词', '/key.png', '/key-local.png', '["local"]', 'local-ref', 'old-local'),
             (3, 1, 1, '旧道具', '旧道具提示词', '/old.png', NULL, NULL, NULL, 'old'),
             (4, 1, NULL, '共享道具', '共享提示词', '/shared.png', NULL, NULL, NULL, 'old-shared'),
             (5, 1, 1, '新道具', '已删除提示词', '/deleted.png', NULL, NULL, NULL, 'deleted'),
             (6, 2, 3, '钥匙', '其他剧提示词', '/other-drama.png', NULL, NULL, NULL, 'other-drama');
    UPDATE props SET deleted_at = 'already-deleted' WHERE id = 5;
  `);
}

async function extract(t, db, response, duringAi) {
  const task = taskService.createTask(db, log, 'prop_extraction', '1');
  t.mock.method(aiClient, 'generateText', async () => {
    if (duringAi) await duringAi(task.id);
    return response;
  });
  await propExtraction.processPropExtraction(db, log, task.id, 1, cfg);
  return taskService.getTask(db, task.id);
}

function seedStoryboards(db) {
  db.exec(`
    INSERT INTO characters (id, drama_id, name, appearance, deleted_at) VALUES
      (11, 1, '本集主角', '本集造型', NULL), (12, 1, '共享角色', '共享造型', NULL),
      (13, 1, '异集角色', '异集造型', NULL), (14, 1, '已有角色', '已有造型', NULL),
      (15, 1, '关联角色', '关联造型', NULL), (16, 1, '未关联角色', '未关联造型', NULL),
      (17, 1, '已删角色', '已删造型', 'deleted'), (21, 2, '跨剧角色', '跨剧造型', NULL);
    INSERT INTO episode_characters VALUES (1, 11), (1, 12), (2, 12), (2, 13), (1, 17), (1, 21);
    INSERT INTO scenes (id, drama_id, episode_id, location, time, prompt, image_url, deleted_at) VALUES
      (31, 1, 1, '本集场景', '日', '本集场景提示词', '/local-scene.png', NULL),
      (32, 1, 2, '异集场景', '夜', '异集场景提示词', '/other-scene.png', NULL),
      (33, 1, NULL, '共享场景', '日', '共享场景提示词', '/shared-scene.png', NULL),
      (34, 1, NULL, '未关联场景', '日', '未关联场景提示词', NULL, NULL),
      (35, 1, 2, '明确共享场景', '夜', '明确共享场景提示词', '/explicit-scene.png', NULL),
      (36, 2, 3, '跨剧场景', '日', '跨剧提示词', NULL, NULL),
      (37, 1, 1, '已删场景', '日', '已删提示词', NULL, 'deleted');
    INSERT INTO props (id, drama_id, episode_id, name, prompt, image_url, deleted_at) VALUES
      (41, 1, 1, '本集道具', '本集道具提示词', '/local-prop.png', NULL),
      (42, 1, 2, '异集道具', '异集道具提示词', '/other-prop.png', NULL),
      (43, 1, NULL, '明确共享道具', '共享提示词', '/shared-prop.png', NULL),
      (44, 1, NULL, '未关联道具', '未关联提示词', NULL, NULL),
      (45, 1, 2, '另集共享道具', '明确共享提示词', '/explicit-prop.png', NULL),
      (46, 2, 3, '跨剧道具', '跨剧提示词', NULL, NULL);
    INSERT INTO storyboards (id, episode_id, scene_id, storyboard_number, title, action, characters, image_prompt, video_prompt, status)
      VALUES (100, 1, 33, 1, '旧分镜一', '旧动作', '[{"id":14,"name":"已有角色"}]', '旧图词', '旧视频词', 'completed'),
             (101, 1, 35, 2, '旧分镜二', '旧动作二', '[]', '旧图词二', '旧视频词二', 'completed'),
             (102, 1, 36, 3, '跨剧旧关联', '旧动作三', '[{"id":21}]', NULL, NULL, 'pending'),
             (200, 2, 32, 1, '另集分镜', '异集角色站立', '[{"id":13,"name":"异集角色"}]', '另集图词', '另集视频词', 'completed');
    INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (101, 15);
    INSERT INTO storyboard_props VALUES (100, 43), (101, 45), (102, 46), (200, 42);
  `);
}

async function generate(t, db, response, duringAi) {
  t.mock.method(aiClient, 'generateText', async (...args) => {
    if (duringAi) await duringAi(args);
    return response;
  });
  const pending = storyboardService.generateStoryboard(db, log, 1);
  // All mocked AI calls finish in this event-loop turn; no server or polling interval is needed.
  await new Promise(setImmediate);
  const task = taskService.getTask(db, pending.task_id);
  assert.ok(['completed', 'failed'].includes(task.status), 'mocked generation should settle');
  return task;
}

describe('episode-local prop extraction', () => {
  it('reuses this episode IDs/assets, creates local rows, and retires only absent local props', async (t) => {
    const db = createDb(t);
    seedProps(db);
    const before = rows(db, 'props');
    const task = await extract(t, db, JSON.stringify([
      { name: ' 钥匙 ', type: '钥匙', description: '本集新描述', image_prompt: '本集新提示词' },
      { name: '新道具', image_prompt: '新道具提示词' },
      { name: '共享道具', description: '本集自己的同名版本' },
    ]));
    assert.equal(task.status, 'completed', task.error);
    const result = JSON.parse(task.result);
    assert.equal(result.count, 3);
    assert.equal(result.props[0].id, 2);
    const after = rows(db, 'props');
    const reused = after.find((p) => p.id === 2);
    assert.equal(reused.prompt, '本集新提示词');
    for (const field of ['image_url', 'local_path', 'extra_images', 'ref_image']) assert.equal(reused[field], before[1][field]);
    assert.ok(after.find((p) => p.id === 3).deleted_at);
    for (const id of [1, 4, 5, 6]) assert.deepEqual(after.find((p) => p.id === id), before.find((p) => p.id === id));
    for (const prop of result.props.slice(1)) {
      const row = after.find((p) => p.id === prop.id);
      assert.equal(row.episode_id, 1);
      assert.equal(row.drama_id, 1);
      assert.ok(row.id > 6);
    }
  });

  it('keeps this episode prompt when AI omits it and never adopts another episode same-name row', async (t) => {
    const db = createDb(t);
    seedProps(db);
    const task = await extract(t, db, '```json\n{"props":[{"name":"钥匙"}]}\n```');
    assert.equal(task.status, 'completed', task.error);
    assert.equal(db.prepare('SELECT prompt FROM props WHERE id = 2').get().prompt, '本集旧提示词');
    assert.equal(db.prepare('SELECT prompt FROM props WHERE id = 1').get().prompt, '另集提示词');
  });

  for (const response of ['', 'not JSON', '{}', '[', '[{"name":"钥匙"}', '[null]', '["钥匙"]', '[{"name":" "}]',
    '[{"name":"钥匙"},{"name":2}]', '[{"name":"钥匙","image_prompt":{}}]', '{"props":{}}']) {
    it(`leaves all props untouched on invalid response ${JSON.stringify(response)}`, async (t) => {
      const db = createDb(t);
      seedProps(db);
      const before = rows(db, 'props');
      const task = await extract(t, db, response);
      assert.equal(task.status, 'failed');
      assert.deepEqual(rows(db, 'props'), before);
    });
  }

  for (const response of ['[]', '{"props":[]}']) {
    it(`preserves existing assets and warns for explicit empty response ${response}`, async (t) => {
      const db = createDb(t);
      seedProps(db);
      const before = rows(db, 'props');
      const task = await extract(t, db, response);
      assert.equal(task.status, 'completed', task.error);
      assert.equal(JSON.parse(task.result).preserved_existing, true);
      assert.ok(JSON.parse(task.result).warning);
      assert.deepEqual(rows(db, 'props'), before);
    });
  }

  it('copies changed shared own props and preserves shared rows absent from the new extraction', async (t) => {
    const db = createDb(t);
    seedProps(db);
    db.exec(`
      INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (200, 2, 1, '引用本集道具');
      INSERT INTO storyboard_props VALUES (200, 2), (200, 3);
    `);
    const before = rows(db, 'props');
    const task = await extract(t, db, '[{"name":"钥匙","image_prompt":"仅本集更新提示词"}]');
    assert.equal(task.status, 'completed', task.error);
    const after = rows(db, 'props');
    for (const id of [1, 2, 3, 4, 5, 6]) assert.deepEqual(after.find((p) => p.id === id), before.find((p) => p.id === id));
    const result = JSON.parse(task.result);
    assert.equal(result.preserved_shared, 2);
    assert.ok(result.warning);
    const copy = after.find((p) => p.id === result.props[0].id);
    assert.ok(copy.id > 6);
    assert.equal(copy.episode_id, 1);
    assert.equal(copy.prompt, '仅本集更新提示词');
    for (const field of ['image_url', 'local_path', 'extra_images', 'ref_image']) assert.equal(copy[field], before[1][field]);
    assert.deepEqual(db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = 200 ORDER BY prop_id').all(), [{ prop_id: 2 }, { prop_id: 3 }]);
  });

  it('reuses an unchanged shared prop without mutating its original row', async (t) => {
    const db = createDb(t);
    seedProps(db);
    db.exec(`
      INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (200, 2, 1, '共享引用');
      INSERT INTO storyboard_props VALUES (200, 2);
    `);
    const before = db.prepare('SELECT * FROM props WHERE id = 2').get();
    const task = await extract(t, db, '[{"name":"钥匙"}]');
    assert.equal(task.status, 'completed', task.error);
    assert.equal(JSON.parse(task.result).props[0].id, 2);
    assert.deepEqual(db.prepare('SELECT * FROM props WHERE id = 2').get(), before);
  });

  it('rolls back all local changes when a later insert fails', async (t) => {
    const db = createDb(t);
    seedProps(db);
    db.exec("CREATE TRIGGER reject_prop BEFORE INSERT ON props WHEN NEW.name = '拒绝' BEGIN SELECT RAISE(ABORT, 'test insert rejected'); END;");
    const before = rows(db, 'props');
    const task = await extract(t, db, '[{"name":"钥匙","image_prompt":"不能部分保存"},{"name":"拒绝"}]');
    assert.equal(task.status, 'failed');
    assert.match(task.error, /test insert rejected/);
    assert.deepEqual(rows(db, 'props'), before);
  });

  for (const mutation of ['episode deleted', 'drama deleted', 'script changed', 'task canceled']) {
    it(`ignores late AI extraction after ${mutation}`, async (t) => {
      const db = createDb(t);
      seedProps(db);
      const before = rows(db, 'props');
      const task = await extract(t, db, '[{"name":"钥匙","image_prompt":"迟到提示词"}]', async (taskId) => {
        await Promise.resolve();
        if (mutation === 'episode deleted') db.prepare("UPDATE episodes SET deleted_at = 'deleted' WHERE id = 1").run();
        if (mutation === 'drama deleted') db.prepare("UPDATE dramas SET deleted_at = 'deleted' WHERE id = 1").run();
        if (mutation === 'script changed') db.prepare("UPDATE episodes SET script_content = '新正文' WHERE id = 1").run();
        if (mutation === 'task canceled') taskService.cancelTask(db, log, taskId);
      });
      assert.equal(task.status, 'failed');
      if (mutation === 'task canceled') assert.equal(task.error, taskService.USER_CANCEL_TASK_MSG);
      assert.deepEqual(rows(db, 'props'), before);
    });
  }

  it('requires actual script text before queuing extraction', (t) => {
    const db = createDb(t);
    db.prepare("UPDATE episodes SET script_content = '  ' WHERE id = 1").run();
    assert.throws(() => propExtraction.extractPropsForEpisode(db, log, 1, cfg), /剧本内容为空/);
    assert.equal(rows(db, 'async_tasks').length, 0);
  });
});

describe('episode-local storyboard generation', () => {
  it('allows long reasoning and stream pauses for initial generation and truncated continuation', async (t) => {
    const db = createDb(t);
    seedStoryboards(db);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(aiClient, 'generateText', async (...args) => {
      requests.push(args[5]);
      // A complete first item followed by a broken next item exercises real continuation.
      if (requests.length === 1) return '[{"shot_number":1,"title":"首镜","action":"走进房间"},{"shot_number":2,"action":"';
      return '[{"shot_number":2,"title":"续写","action":"坐下"}]';
    });
    const pending = storyboardService.generateStoryboard(db, log, 1);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    t.mock.timers.tick(3000);
    await new Promise(setImmediate);
    const task = taskService.getTask(db, pending.task_id);
    assert.equal(task.status, 'completed', task.error);
    assert.equal(requests.length, 2, 'truncated output must actually request continuation');
    for (const options of requests) {
      assert.equal(options.scene_key, 'storyboard_extraction');
      assert.equal(options.first_response_timeout_ms, 20 * 60 * 1000);
      assert.equal(options.silence_timeout_ms, 10 * 60 * 1000);
      assert.equal(typeof options.streamCallback, 'function');
    }
    assert.equal(JSON.parse(task.result).storyboards.length, 2);
  });

  for (const streaming of [false, true]) {
    it(`scopes prompt, appearances, saved relations and name matching${streaming ? ' during streaming' : ''}`, async (t) => {
      const db = createDb(t);
      seedStoryboards(db);
      const resourcesBefore = ['characters', 'scenes', 'props'].map((table) => rows(db, table));
      const otherBoard = db.prepare('SELECT * FROM storyboards WHERE id = 200').get();
      const response = JSON.stringify([
        { shot_number: 1, title: '本集新镜头', scene_id: 32, characters: [
          { id: 11, name: '本集主角' }, { name: '共享角色' }, { id: 14 }, { id: 15 },
          { id: 13 }, { id: 16 }, { id: 17 }, { id: 21 },
        ], props: [41, 42, 43, 44, 45, 46], action: '本集主角走进房间。' + '镜头缓推。'.repeat(100), duration: 5 },
        { shot_number: 2, title: '本集后续', scene_id: 35, characters: [], props: [45],
          action: '本集主角和共享角色遇到已有角色与关联角色。异集角色与未关联角色、跨剧角色不应自动关联。', duration: 5 },
      ]);
      const task = await generate(t, db, response, async (args) => {
        const prompt = args[3];
        for (const name of ['本集主角', '共享角色', '已有角色', '关联角色', '本集场景', '共享场景', '明确共享场景', '本集道具', '明确共享道具', '另集共享道具']) {
          assert.ok(prompt.includes(name), `prompt should include ${name}`);
        }
        for (const name of ['异集角色', '未关联角色', '跨剧角色', '已删角色', '异集场景', '未关联场景', '跨剧场景', '已删场景', '异集道具', '未关联道具', '跨剧道具']) {
          assert.ok(!prompt.includes(name), `prompt should exclude ${name}`);
        }
        assert.equal(db.prepare('SELECT deleted_at FROM storyboards WHERE id = 100').get().deleted_at, null);
        if (streaming) {
          args[5].streamCallback(response);
          assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id = 100').get().deleted_at);
        }
      });
      assert.equal(task.status, 'completed', task.error);
      const boards = db.prepare('SELECT * FROM storyboards WHERE episode_id = 1 AND deleted_at IS NULL ORDER BY storyboard_number').all();
      assert.equal(boards.length, 2);
      assert.equal(boards[0].scene_id, null);
      assert.equal(boards[1].scene_id, 35);
      for (const board of boards) {
        assert.deepEqual(JSON.parse(board.characters).map((c) => c.id).sort((a, b) => a - b), [11, 12, 14, 15]);
        assert.doesNotMatch(board.video_prompt, /异集造型|未关联造型|跨剧造型|已删造型/);
      }
      assert.match(boards[0].video_prompt, /本集造型/);
      assert.deepEqual(db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id').all(boards[0].id).map((p) => p.prop_id), [41, 43, 45]);
      assert.deepEqual(db.prepare('SELECT * FROM storyboards WHERE id = 200').get(), otherBoard);
      assert.deepEqual(['characters', 'scenes', 'props'].map((table) => rows(db, table)), resourcesBefore);
      assert.equal(JSON.parse(task.result).storyboards.length, 2);
    });
  }

  for (const response of ['', 'not JSON', '{}', '[]', '[null]', '[{"shot_number":1}]', '[{"title":"没有镜号"}]']) {
    it(`preserves old storyboards on invalid/empty response ${JSON.stringify(response)}`, async (t) => {
      const db = createDb(t);
      seedStoryboards(db);
      const before = rows(db, 'storyboards');
      const task = await generate(t, db, response);
      assert.equal(task.status, 'failed');
      assert.deepEqual(rows(db, 'storyboards'), before);
      assert.equal(db.prepare('SELECT duration FROM episodes WHERE id = 1').get().duration, 12);
    });
  }

  it('does not use an episode premise as its script', (t) => {
    const db = createDb(t);
    db.prepare("UPDATE episodes SET script_content = NULL, description = '本集构思里有角色、场景、台词也仍然不是正文。' WHERE id = 1").run();
    assert.throws(() => storyboardService.generateStoryboard(db, log, 1), /剧本内容为空/);
    assert.equal(rows(db, 'async_tasks').length, 0);
  });

  for (const mutation of ['episode deleted', 'drama deleted', 'script changed', 'task canceled']) {
    it(`does not persist a late streamed/final response after ${mutation}`, async (t) => {
      const db = createDb(t);
      seedStoryboards(db);
      const before = rows(db, 'storyboards');
      const response = JSON.stringify([{ shot_number: 1, title: '迟到分镜', action: '不能写入。'.repeat(100), characters: [{ id: 11 }] }]);
      const task = await generate(t, db, response, async (args) => {
        await Promise.resolve();
        if (mutation === 'episode deleted') db.prepare("UPDATE episodes SET deleted_at = 'deleted' WHERE id = 1").run();
        if (mutation === 'drama deleted') db.prepare("UPDATE dramas SET deleted_at = 'deleted' WHERE id = 1").run();
        if (mutation === 'script changed') db.prepare("UPDATE episodes SET script_content = '新正文' WHERE id = 1").run();
        if (mutation === 'task canceled') {
          const pendingTask = db.prepare("SELECT id FROM async_tasks WHERE type = 'storyboard_generation'").get();
          taskService.cancelTask(db, log, pendingTask.id);
        }
        args[5].streamCallback(response);
      });
      assert.equal(task.status, 'failed');
      if (mutation === 'task canceled') assert.equal(task.error, taskService.USER_CANCEL_TASK_MSG);
      assert.deepEqual(rows(db, 'storyboards'), before);
    });
  }

  it('drops references to resources deleted while awaiting AI', async (t) => {
    const db = createDb(t);
    seedStoryboards(db);
    const response = JSON.stringify([{ shot_number: 1, title: '删除后的结果', scene_id: 31, props: [41], characters: [{ id: 11 }], action: '本集主角进门。' }]);
    const task = await generate(t, db, response, () => {
      db.prepare("UPDATE characters SET deleted_at = 'deleted' WHERE id = 11").run();
      db.prepare("UPDATE scenes SET deleted_at = 'deleted' WHERE id = 31").run();
      db.prepare("UPDATE props SET deleted_at = 'deleted' WHERE id = 41").run();
    });
    assert.equal(task.status, 'completed', task.error);
    const board = db.prepare('SELECT * FROM storyboards WHERE episode_id = 1 AND deleted_at IS NULL').get();
    assert.equal(board.scene_id, null);
    assert.deepEqual(JSON.parse(board.characters), []);
    assert.deepEqual(db.prepare('SELECT * FROM storyboard_props WHERE storyboard_id = ?').all(board.id), []);
  });

  it('rolls back replacement when a later storyboard insert fails', async (t) => {
    const db = createDb(t);
    seedStoryboards(db);
    db.exec("CREATE TRIGGER reject_storyboard BEFORE INSERT ON storyboards WHEN NEW.title = '拒绝' BEGIN SELECT RAISE(ABORT, 'test storyboard rejected'); END;");
    const before = rows(db, 'storyboards');
    const task = await generate(t, db, '[{"shot_number":1,"title":"不能部分保存"},{"shot_number":2,"title":"拒绝"}]');
    assert.equal(task.status, 'failed');
    assert.match(task.error, /test storyboard rejected/);
    assert.deepEqual(rows(db, 'storyboards'), before);
  });
});
