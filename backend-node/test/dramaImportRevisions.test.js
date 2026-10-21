const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { importDrama } = require('../src/services/dramaImportService');
const dramaRoutes = require('../src/routes/drama');
const { createEpisodeTestDb, contentSnapshot, log, makeResponse } = require('./helpers/episodeTestDb');

function archive(data, withMedia = false) {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(data)));
  if (withMedia) zip.addFile('media/character.png', Buffer.from('test image bytes'));
  return zip.toBuffer();
}

function prohibitFileWrites(t) {
  const writes = [];
  t.mock.method(fs, 'mkdirSync', (...args) => { writes.push(args); throw new Error('unexpected directory creation'); });
  t.mock.method(fs, 'writeFileSync', (...args) => { writes.push(args); throw new Error('unexpected media write'); });
  return writes;
}

test('ZIP import validates all episode numbers/content before any DB or media writes', (t) => {
  const db = createEpisodeTestDb(t);
  const writes = prohibitFileWrites(t);
  const before = contentSnapshot(db);
  const episodeCases = [
    null, {},
    [{ episode_number: 1 }, { episode_number: '01' }],
    ...[undefined, 0, -1, '1.5', '', true].map((number) => [{ episode_number: number }]),
    [{ episode_number: 1 }, { episode_number: 2, script_content: {} }],
    [{ episode_number: 1 }, { episode_number: 2, duration: -1 }],
  ];
  const routes = dramaRoutes(db, {}, log);
  for (const episodes of episodeCases) {
    const buffer = archive({ drama: { title: '不能导入' }, episodes, characters: [{ name: '不要创建', image_file: 'media/character.png' }] }, true);
    assert.throws(() => importDrama(db, {}, log, buffer), { statusCode: 400, code: 'BAD_REQUEST' });
    const response = makeResponse();
    routes.importDrama({ file: { buffer } }, response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(contentSnapshot(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM characters').get().count, 0);
  }
  assert.deepEqual(writes, []);
});

test('ZIP restore allocates fresh IDs/revisions and preserves unsorted episode asset associations', (t) => {
  const db = createEpisodeTestDb(t);
  const writes = prohibitFileWrites(t);
  const before = contentSnapshot(db);
  const result = importDrama(db, {}, log, archive({
    drama: { title: '导入项目', description: '共享背景', episodes_revision: 999 },
    characters: [{ name: '同一角色' }],
    episodes: [
      { id: 10, episode_number: '005', title: '第五集', description: '第五集梗概', script_content: '第五集原文', revision: 999,
        storyboards: [{ storyboard_number: 1, title: '第五集分镜', dialogue: '第五集台词' }] },
      { id: 11, episode_number: 2, title: '第二集', description: '第二集梗概', script_content: '第二集原文', duration: 32, revision: 888,
        storyboards: [{ storyboard_number: 1, title: '第二集分镜', dialogue: '第二集台词' }] },
    ],
    scenes: [
      { episode_index: 0, location: '第五集地点', time: '白天' },
      { episode_index: 1, location: '第二集地点', time: '夜晚' },
    ],
    props: [{ episode_index: 1, name: '第二集道具' }],
  }));
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(result.drama_id);
  const episodes = db.prepare('SELECT * FROM episodes WHERE drama_id = ? ORDER BY episode_number').all(result.drama_id);
  assert.equal(drama.episodes_revision, 1);
  assert.equal(drama.total_episodes, 2);
  assert.equal(drama.description, '共享背景');
  assert.deepEqual(episodes.map((episode) => [episode.episode_number, episode.revision]), [[2, 1], [5, 1]]);
  assert.ok(episodes.every((episode) => ![1, 10, 11].includes(episode.id)));
  assert.deepEqual(episodes.map((episode) => episode.description), ['第二集梗概', '第五集梗概']);
  assert.equal(episodes[0].script_content, '第二集原文');
  assert.equal(episodes[0].duration, 32);
  const shots = db.prepare(`SELECT e.episode_number, s.title FROM storyboards s JOIN episodes e ON e.id = s.episode_id
    WHERE e.drama_id = ? ORDER BY e.episode_number`).all(result.drama_id);
  assert.deepEqual(shots, [{ episode_number: 2, title: '第二集分镜' }, { episode_number: 5, title: '第五集分镜' }]);
  const scenes = db.prepare(`SELECT e.episode_number, s.location FROM scenes s JOIN episodes e ON e.id = s.episode_id
    WHERE s.drama_id = ? ORDER BY e.episode_number`).all(result.drama_id);
  assert.deepEqual(scenes, [{ episode_number: 2, location: '第二集地点' }, { episode_number: 5, location: '第五集地点' }]);
  assert.equal(db.prepare(`SELECT e.episode_number FROM props p JOIN episodes e ON e.id = p.episode_id WHERE p.drama_id = ?`).get(result.drama_id).episode_number, 2);
  assert.deepEqual(db.prepare('SELECT * FROM episodes WHERE drama_id IN (1, 2) ORDER BY id').all(), before.episodes);
  assert.deepEqual(writes, []);
});

test('ZIP restore rolls back all DB rows on failure and initializes an empty collection at zero', (t) => {
  const db = createEpisodeTestDb(t);
  const writes = prohibitFileWrites(t);
  const before = contentSnapshot(db);
  db.exec(`CREATE TRIGGER fail_import_episode BEFORE INSERT ON episodes WHEN NEW.title = '失败集'
    BEGIN SELECT RAISE(ABORT, 'blocked import episode'); END`);
  assert.throws(() => importDrama(db, {}, log, archive({
    drama: { title: '回滚项目' }, episodes: [{ episode_number: 3, title: '正常集' }, { episode_number: 4, title: '失败集' }],
  })), /blocked import episode/);
  assert.deepEqual(contentSnapshot(db), before);
  const empty = importDrama(db, {}, log, archive({ drama: { title: '空项目' } }));
  const restored = db.prepare('SELECT episodes_revision, total_episodes FROM dramas WHERE id = ?').get(empty.drama_id);
  assert.deepEqual(restored, { episodes_revision: 0, total_episodes: 0 });
  assert.deepEqual(writes, []);
});
