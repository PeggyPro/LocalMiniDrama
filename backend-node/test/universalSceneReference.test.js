const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildUniversalSegmentUserPromptBundle } = require('../src/services/universalSegmentPromptBundle');
const { buildFallbackUniversalMultiBeatText } = require('../src/services/universalOmniMultiBeatFormat');

function fixture(t, location) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, title TEXT, script_content TEXT, deleted_at TEXT);
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, location TEXT, time TEXT, prompt TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, scene_id INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, action TEXT, dialogue TEXT,
      narration TEXT, result TEXT, atmosphere TEXT, image_prompt TEXT, polished_prompt TEXT,
      video_prompt TEXT, universal_segment_text TEXT, shot_type TEXT, angle TEXT, angle_h TEXT,
      angle_v TEXT, angle_s TEXT, movement TEXT, lighting_style TEXT, depth_of_field TEXT,
      characters TEXT, local_path TEXT, duration REAL, segment_index INTEGER, segment_title TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT, local_path TEXT, image_url TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_characters (id INTEGER PRIMARY KEY, storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE props (id INTEGER PRIMARY KEY, name TEXT, local_path TEXT, image_url TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    INSERT INTO dramas (id, title, genre, style) VALUES (1, '一品布衣', '古装', 'historical');
    INSERT INTO episodes (id, drama_id, title, script_content) VALUES (1, 1, '第一集', '徐牧走过街巷，回到破屋。');
    INSERT INTO characters (id, name, local_path) VALUES (1, '徐牧', 'characters/xumu.png');
  `);
  db.prepare('INSERT INTO scenes (id, location, local_path) VALUES (1, ?, ?)').run(location, 'scenes/scene.png');
  db.prepare(`INSERT INTO storyboards (id, episode_id, storyboard_number, scene_id, title, location, action, characters, duration)
    VALUES (1, 1, 1, 1, '测试镜头', ?, '徐牧向前走', '[1]', 5)`).run(location);
  return db;
}

for (const location of ['城南街巷（室外）', '破旧泥屋内室（室内）']) {
  test(`scene-reference instructions respect the shot location: ${location}`, (t) => {
    const db = fixture(t, location);
    const bundle = buildUniversalSegmentUserPromptBundle(db, 1, {});
    assert.equal(bundle.ok, true);
    assert.ok(bundle.userPrompt.includes(`LOCATION: ${location}`));
    assert.match(bundle.userPrompt, /@图片1 = 场景/);
    assert.match(bundle.userPrompt, /@图片2 = 角色「徐牧」/);
    assert.doesNotMatch(bundle.userPrompt, /统一的室内空间|imperial palace|classical garden|rich warm color grading/);
    const required = bundle.userPrompt.split('LINE3_REQUIRED（第3行必须与下面整句完全一致，含标点）:\n')[1].split('\n')[0];
    assert.match(required, /室内或室外以本镜描述为准/);
    assert.match(required, /禁止成片复刻其分格或并列布局/);
    const fallback = buildFallbackUniversalMultiBeatText({ location }, { durationSec: 5, action: '徐牧向前走' }, '古装');
    assert.equal(fallback.split('\n')[2], required);
    assert.ok(fallback.includes(location));
  });
}

test('a character-only first image is not relabeled as a scene reference', (t) => {
  const db = fixture(t, '室外街巷');
  db.prepare('UPDATE storyboards SET scene_id=NULL WHERE id=1').run();
  const bundle = buildUniversalSegmentUserPromptBundle(db, 1, {});
  assert.equal(bundle.ok, true);
  assert.match(bundle.userPrompt, /@图片1 = 角色「徐牧」/);
  assert.match(bundle.userPrompt, /本片段以首张参考图 @图片1 作为画面锚点展开/);
  assert.doesNotMatch(bundle.userPrompt, /环境、光影与陈设定性参考 @图片1/);
});

test('explicit no-reference mode does not claim a scene image was supplied', (t) => {
  const db = fixture(t, '室外街巷');
  db.prepare("UPDATE storyboards SET scene_id=NULL, characters='[]' WHERE id=1").run();
  const blocked = buildUniversalSegmentUserPromptBundle(db, 1, {});
  assert.equal(blocked.ok, false);
  const forced = buildUniversalSegmentUserPromptBundle(db, 1, { force_without_reference_images: true });
  assert.equal(forced.ok, true);
  assert.match(forced.userPrompt, /当前尚未上传参考图/);
  assert.doesNotMatch(forced.userPrompt, /环境、光影与陈设定性参考 @图片1/);
});
