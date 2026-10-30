const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const Database = require('better-sqlite3');
const ffmpegPaths = require('../src/utils/ffmpegPath');
const config = require('../src/config');
const adopted = require('../src/services/adoptedVideoService');
const planning = require('../src/services/videoPlanningService');
const merge = require('../src/services/videoMergeService');
const post = require('../src/services/mergedEpisodePostProcess');
const tail = require('../src/services/tailFrameLinkService');
const drama = require('../src/services/dramaService');
const log = { info() {}, warn() {}, error() {}, debug() {} };
let root;
let canRunMedia;

function command(bin, args) {
  const r = childProcess.spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  return r;
}
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopted-media-test-'));
  canRunMedia = ffmpegPaths.hasLocalFfmpeg() && childProcess.spawnSync(ffmpegPaths.getFfprobePath(), ['-version']).status === 0;
  if (!canRunMedia) return;
  // Last display frame is blue; every earlier frame is red. Newest unselected media is yellow.
  command(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=128x96:r=4:d=1',
    '-vf', "drawbox=color=blue:t=fill:enable='eq(n,3)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(root, 'selected.mp4')]);
  command(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=128x96:r=4:d=0.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(root, 'newest.mp4')]);
  command(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=128x96:r=10:d=0.4',
    '-vf', "drawbox=color=blue:t=fill:enable='eq(n,3)',setpts='if(eq(N,3),17,N)'", '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(root, 'vfr.mp4')]);
  command(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '0.4', '-c:a', 'libmp3lame', '-y', path.join(root, 'narr.mp3')]);
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function mediaAvailable(t) { if (canRunMedia) return true; t.skip('ffmpeg/ffprobe unavailable'); return false; }

function database(t, withPlans = true) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, metadata TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, status TEXT, video_url TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, duration REAL,
      video_url TEXT, local_path TEXT, image_url TEXT, first_frame_image_id INTEGER, dialogue TEXT, narration TEXT,
      audio_local_path TEXT, narration_audio_local_path TEXT, video_selection_source TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY, storyboard_id INTEGER, status TEXT, video_url TEXT, local_path TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT);
    CREATE TABLE video_plan_versions (id TEXT PRIMARY KEY, storyboard_id INTEGER, model_id TEXT, tail_segment_id TEXT,
      segment_ids TEXT, video_url TEXT, local_path TEXT, duration REAL, status TEXT, created_at TEXT);
    CREATE TABLE video_merges (id INTEGER PRIMARY KEY, episode_id INTEGER, drama_id INTEGER, title TEXT, provider TEXT, model TEXT,
      status TEXT, scenes TEXT, merge_options TEXT, task_id TEXT, merged_url TEXT, duration REAL, error_msg TEXT,
      created_at TEXT, completed_at TEXT, deleted_at TEXT);
    CREATE TABLE async_tasks (id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER, message TEXT, error TEXT,
      result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT);
    CREATE TABLE image_generations (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, storyboard_id INTEGER,
      prompt TEXT, provider TEXT, model TEXT, status TEXT, image_url TEXT, local_path TEXT, width INTEGER, height INTEGER,
      created_at TEXT, updated_at TEXT, completed_at TEXT);
    INSERT INTO dramas (id,title,metadata,created_at) VALUES (1,'fixture','{}','2026-01-01');
    INSERT INTO episodes (id,drama_id,episode_number,status) VALUES (1,1,1,'draft');
    INSERT INTO storyboards (id,episode_id,storyboard_number,duration,video_url,local_path,updated_at)
      VALUES (11,1,1,99,'https://media.invalid/selected.mp4','selected.mp4','2020-01-01'),
      (12,1,2,88,'https://media.invalid/newest.mp4','newest.mp4','2020-01-01');
    INSERT INTO video_generations (id,storyboard_id,status,video_url,local_path,created_at,completed_at)
      VALUES (1,11,'completed','https://media.invalid/selected.mp4','selected.mp4','2020-01-01','2020-01-01'),
      (2,11,'completed','https://media.invalid/newest.mp4','newest.mp4','2099-01-01','2099-01-01');
    INSERT INTO video_plan_versions VALUES
      ('chosen',11,'test','tail1','["tail1"]','https://media.invalid/selected.mp4','selected.mp4',1,'completed','2020-01-01'),
      ('latest',11,'test','tail2','["tail2"]','https://media.invalid/newest.mp4','newest.mp4',0.5,'completed','2099-01-01');
  `);
  if (withPlans) planning.ensureVideoPlanningSchema(db);
  return db;
}
function choose(db, versionId = 'chosen') {
  db.prepare('INSERT OR REPLACE INTO storyboard_video_plans (storyboard_id,selected_version_id,adoption_revision) VALUES (11,?,4)').run(versionId);
}
function mergeConfig(t) { t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root } })); }
function scenes() { return [{ scene_id: 11, video_url: 'selected.mp4', duration: 99 }, { scene_id: 12, video_url: 'newest.mp4', duration: 88 }]; }
function startMerge(db, sceneList = scenes(), options = {}) {
  return merge.create(db, log, { episode_id: 1, drama_id: 1, scenes: sceneList, merge_options: options });
}
function failed(db, created) {
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'failed');
  assert.equal(record.merged_url, null);
  assert.equal(record.duration, null);
  assert.ok(record.error_msg);
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id=?').get(created.task_id).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM episodes WHERE id=1').get().status, 'failed');
  return record;
}
function response() {
  return { statusCode: 200, data: null, status(value) { this.statusCode = value; return this; }, json(value) { this.data = value; return this; } };
}
async function link(db) {
  const res = response();
  await tail(db, { storage: { local_path: root, base_url: 'http://fixture/static' } }, log)
    .linkTailFrame({ params: { id: '11' }, body: { drama_id: 1 } }, res);
  return res;
}
function assertBlue(file) {
  const r = childProcess.spawnSync(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-i', file, '-frames:v', '1',
    '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 30000 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(r.stdout[2] > 180 && r.stdout[0] < 60 && r.stdout[1] < 60, `expected blue final frame, got ${[...r.stdout]}`);
}

test('explicit adoption uses the exact older completed version, through the planning getter', (t) => {
  const db = database(t); choose(db);
  const getter = t.mock.method(planning, 'getStoryboardVideoPlan');
  const selected = adopted.resolveAdoptedVideo(db, 11, { baseUrl: 'http://fixture/static' });
  assert.equal(getter.mock.callCount(), 1);
  assert.equal(selected.version_id, 'chosen');
  assert.equal(selected.duration, 1);
  assert.equal(selected.adoption_revision, 4);
  assert.equal(selected.url, 'http://fixture/static/selected.mp4');
});
test('no adoption keeps legacy selection despite newer completed generations; old DB reads never migrate', (t) => {
  const db = database(t, false);
  const selected = adopted.resolveAdoptedVideo(db, 11);
  assert.equal(selected.local_path, 'selected.mp4');
  assert.equal(selected.duration, null);
  assert.equal(selected.version_id, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='storyboard_video_plans'").get().n, 0);
});
test('an unselected latest completed plan version becomes the default when the storyboard has no video', (t) => {
  const db = database(t);
  db.exec("UPDATE storyboards SET video_url=NULL,local_path='image.png' WHERE id=11");
  const selected = adopted.resolveAdoptedVideo(db, 11);
  assert.equal(selected.version_id, 'latest');
  assert.equal(selected.source, 'planned');
  assert.equal(selected.local_path, 'newest.mp4');
  assert.equal(selected.duration, 0.5);
});

test('an automatic legacy cache does not block a newer completed generation', (t) => {
  const db = database(t, false);
  db.exec("DELETE FROM video_plan_versions; UPDATE storyboards SET video_selection_source='automatic' WHERE id=11");
  const selected = adopted.resolveAdoptedVideo(db, 11);
  assert.equal(selected.source, 'legacy_latest');
  assert.equal(selected.video_url, 'https://media.invalid/newest.mp4');
});

test('the latest completed legacy generation becomes the default when no plan versions exist', (t) => {
  const db = database(t, false);
  db.exec("DELETE FROM video_plan_versions; UPDATE storyboards SET video_url=NULL,local_path='image.png' WHERE id=11");
  const selected = adopted.resolveAdoptedVideo(db, 11);
  assert.equal(selected.source, 'legacy_latest');
  assert.equal(selected.video_url, 'https://media.invalid/newest.mp4');
  assert.equal(selected.local_path, 'newest.mp4');
});
test('legacy image path never overrides video URL; only an exact generation URL can locate its download', (t) => {
  const db = database(t);
  db.exec("UPDATE storyboards SET local_path='portrait.png' WHERE id=11");
  assert.equal(adopted.resolveAdoptedVideo(db, 11).local_path, 'selected.mp4');
  db.exec("UPDATE storyboards SET video_url='https://media.invalid/unknown.mp4' WHERE id=11");
  const selected = adopted.resolveAdoptedVideo(db, 11);
  assert.equal(selected.local_path, null);
  assert.equal(selected.url, 'https://media.invalid/unknown.mp4');
});
for (const absolute of [false, true]) {
  test(`local-only legacy ${absolute ? 'absolute' : 'relative'} selection survives image input and drives merge/tail`, async (t) => {
    if (!mediaAvailable(t)) return;
    const db = database(t, false); mergeConfig(t);
    const localPath = absolute ? path.join(root, 'selected.mp4') : 'selected.mp4';
    const identity = absolute ? localPath.replace(/\\/g, '/') : '/static/selected.mp4';
    db.prepare('UPDATE video_generations SET video_url=NULL,local_path=? WHERE id=1').run(localPath);
    db.prepare("UPDATE storyboards SET video_url=?,local_path='portrait.png' WHERE id=11").run(identity);
    const selected = adopted.resolveAdoptedVideo(db, 11);
    assert.equal(selected.video_url, identity);
    assert.equal(selected.local_path, localPath);
    t.mock.method(global, 'fetch', () => { throw new Error('selected local video must not fetch'); });
    t.mock.method(global, 'setImmediate', () => 0);
    const created = drama.finalizeEpisode(db, log, 1, 'http://fixture/static');
    await merge.processVideoMerge(db, log, created.merge_id, 'http://fixture/static');
    const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
    assert.equal(record.status, 'completed', record.error_msg);
    assert.equal(record.duration, 1.5);
    const res = await link(db);
    assert.equal(res.statusCode, 200, JSON.stringify(res.data));
    assertBlue(path.join(root, res.data.local_path));
    assert.equal(db.prepare('SELECT local_path FROM storyboards WHERE id=11').get().local_path, 'portrait.png');
  });
}
test('local-only relative Windows path matches only its normalized selection URL', (t) => {
  const db = database(t, false);
  db.prepare('UPDATE video_generations SET video_url=NULL,local_path=? WHERE id=1').run('clips\\selected.mp4');
  db.exec("UPDATE storyboards SET video_url='/static/clips/selected.mp4',local_path='portrait.png' WHERE id=11");
  assert.equal(adopted.resolveAdoptedVideo(db, 11).local_path, 'clips\\selected.mp4');
});
for (const [label, sql] of [
  ['foreign storyboard', 'UPDATE video_generations SET storyboard_id=12 WHERE id=1'],
  ['nonmatching original URL', "UPDATE video_generations SET video_url='https://media.invalid/other.mp4' WHERE id=1"],
  ['unfinished', "UPDATE video_generations SET status='processing' WHERE id=1"],
  ['deleted', "UPDATE video_generations SET deleted_at='2026-01-01' WHERE id=1"],
  ['different identity', "UPDATE video_generations SET local_path='other.mp4' WHERE id=1"],
]) {
  test(`local-only selection ignores ${label} history and never substitutes latest`, (t) => {
    const db = database(t, false);
    db.exec("UPDATE video_generations SET video_url=NULL WHERE id=1; UPDATE storyboards SET video_url='/static/selected.mp4',local_path='portrait.png' WHERE id=11");
    db.exec(sql);
    const selected = adopted.resolveAdoptedVideo(db, 11);
    assert.equal(selected.video_url, '/static/selected.mp4');
    assert.equal(selected.local_path, null);
  });
}
for (const [label, sql] of [
  ['missing', "DELETE FROM video_plan_versions WHERE id='chosen'"],
  ['foreign storyboard', "UPDATE video_plan_versions SET storyboard_id=12 WHERE id='chosen'"],
  ['incomplete', "UPDATE video_plan_versions SET status='failed' WHERE id='chosen'"],
  ['unmeasured', "UPDATE video_plan_versions SET duration=NULL WHERE id='chosen'"],
  ['no media', "UPDATE video_plan_versions SET video_url=NULL,local_path=NULL WHERE id='chosen'"],
]) {
  test(`invalid adopted version (${label}) fails without falling back to legacy or latest`, (t) => {
    const db = database(t); choose(db); db.exec(sql);
    assert.throws(() => adopted.resolveAdoptedVideo(db, 11), { code: 'INVALID_VIDEO_ADOPTION', statusCode: 409 });
  });
}
test('finalize snapshots the adopted media and measured duration; legacy duration remains unmeasured', (t) => {
  const db = database(t); choose(db);
  t.mock.method(global, 'setImmediate', () => 0);
  const result = drama.finalizeEpisode(db, log, 1, 'http://fixture/static');
  const frozen = JSON.parse(db.prepare('SELECT scenes FROM video_merges WHERE id=?').get(result.merge_id).scenes);
  assert.equal(frozen[0].version_id, 'chosen');
  assert.equal(frozen[0].duration, 1);
  assert.equal(frozen[0].local_path, 'selected.mp4');
  assert.equal(frozen[1].duration, null);
});
test('finalize rejects any missing storyboard video before creating a task', (t) => {
  const db = database(t);
  db.exec('UPDATE storyboards SET video_url=NULL,local_path=NULL WHERE id=12');
  assert.throws(() => drama.finalizeEpisode(db, log, 1, ''), { code: 'INCOMPLETE_EPISODE' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_merges').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM async_tasks').get().n, 0);
});
test('finalize rejects empty episodes and invalid adoptions before creating a task', (t) => {
  const db = database(t); choose(db, 'absent');
  assert.throws(() => drama.finalizeEpisode(db, log, 1, ''), { code: 'INVALID_VIDEO_ADOPTION' });
  db.exec('DELETE FROM storyboards');
  assert.throws(() => drama.finalizeEpisode(db, log, 1, ''), { code: 'INCOMPLETE_EPISODE' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM async_tasks').get().n, 0);
});

test('real concat includes every selected clip and uses measured fractional duration', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  const created = startMerge(db);
  await merge.processVideoMerge(db, log, created.merge_id, '');
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'completed', record.error_msg);
  assert.equal(record.duration, 1.5);
  assert.notEqual(record.merged_url, 'selected.mp4');
  assert.deepEqual(JSON.parse(record.scenes).map((s) => s.duration), [1, 0.5]);
  const evidence = tail.probeLastFrame(path.join(root, record.merged_url));
  assert.equal(evidence.frame_count, 6);
  assert.equal(evidence.last_pts, 1.25);
});

test('non-fatal ffprobe stderr does not reject a valid merge', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (bin, args, options) => {
    const result = spawn(bin, args, options);
    if (bin === ffmpegPaths.getFfprobePath() && result.status === 0) {
      return { ...result, stderr: '[hevc] non-fatal decoder warning' };
    }
    return result;
  });
  const created = startMerge(db);
  await merge.processVideoMerge(db, log, created.merge_id, '');
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'completed', record.error_msg);
  assert.equal(record.duration, 1.5);
  assert.equal(record.error_msg, null);
});
for (const variant of ['missing middle clip', 'download rejection', 'download HTTP failure', 'corrupt clip', 'missing storyboard', 'duplicate storyboard']) {
  test(`whole merge fails: ${variant}`, async (t) => {
    if (!mediaAvailable(t)) return;
    const db = database(t); mergeConfig(t);
    db.exec("UPDATE episodes SET video_url='previous-complete.mp4' WHERE id=1");
    const inputs = scenes();
    if (variant === 'missing middle clip') inputs[1].video_url = 'absent.mp4';
    if (variant === 'download rejection' || variant === 'download HTTP failure') {
      inputs[1].video_url = 'https://media.invalid/unavailable.mp4';
      t.mock.method(global, 'fetch', variant === 'download rejection'
        ? async () => { throw new Error('offline fixture'); }
        : async () => ({ ok: false, status: 503 }));
    }
    if (variant === 'corrupt clip') { fs.writeFileSync(path.join(root, 'corrupt.mp4'), 'not a video'); inputs[1].video_url = 'corrupt.mp4'; }
    if (variant === 'missing storyboard') inputs.pop();
    if (variant === 'duplicate storyboard') inputs[1].scene_id = 11;
    const created = startMerge(db, inputs);
    await merge.processVideoMerge(db, log, created.merge_id, '');
    failed(db, created);
    assert.equal(db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url, 'previous-complete.mp4');
  });
}
test('no ffmpeg fails without downloading or falling back to the first clip', async (t) => {
  const db = database(t); mergeConfig(t);
  const moduleId = require.resolve('../src/services/videoMergeService');
  const originalModule = require.cache[moduleId];
  t.mock.method(ffmpegPaths, 'hasLocalFfmpeg', () => false);
  delete require.cache[moduleId];
  const withoutFfmpeg = require(moduleId);
  require.cache[moduleId] = originalModule;
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected download'); });
  const created = startMerge(db);
  await withoutFfmpeg.processVideoMerge(db, log, created.merge_id, '');
  assert.match(failed(db, created).error_msg, /ffmpeg/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
test('concat failure removes partial output and fails the episode/task', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  const spawn = childProcess.spawnSync;
  const partials = [];
  t.mock.method(childProcess, 'spawnSync', (bin, args, options) => {
    if (args.includes('concat')) {
      const output = args.at(-1); fs.writeFileSync(output, 'partial'); partials.push(output);
      return { status: 1, stderr: 'forced concat failure' };
    }
    return spawn(bin, args, options);
  });
  const created = startMerge(db);
  await merge.processVideoMerge(db, log, created.merge_id, '');
  assert.match(failed(db, created).error_msg, /拼接失败/);
  assert.equal(partials.length, 2);
  assert.ok(partials.every((file) => !fs.existsSync(file)));
});
test('successful concat exit cannot publish missing frames even when total duration matches', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  const partial = path.join(root, 'stretched-partial.mp4');
  command(ffmpegPaths.getFfmpegPath(), ['-v', 'error', '-i', path.join(root, 'selected.mp4'),
    '-vf', "setpts='if(eq(N,3),1.25/TB,N*0.25/TB)'", '-fps_mode', 'passthrough', '-c:v', 'libx264', '-y', partial]);
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (bin, args, options) => {
    if (args.includes('concat')) { fs.copyFileSync(partial, args.at(-1)); return { status: 0, stderr: '' }; }
    return spawn(bin, args, options);
  });
  const created = startMerge(db);
  await merge.processVideoMerge(db, log, created.merge_id, '');
  assert.match(failed(db, created).error_msg, /帧数/);
});
test('unavailable ffprobe fails before publishing any media', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  const spawn = childProcess.spawnSync;
  const probe = ffmpegPaths.getFfprobePath();
  t.mock.method(childProcess, 'spawnSync', (bin, args, options) => bin === probe
    ? { status: null, error: new Error('ENOENT ffprobe') } : spawn(bin, args, options));
  const created = startMerge(db);
  await merge.processVideoMerge(db, log, created.merge_id, '');
  failed(db, created);
});
test('variable frame rate watermark preserves all original display frames', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  db.exec('DELETE FROM storyboards WHERE id=12');
  const created = startMerge(db, [{ scene_id: 11, video_url: 'vfr.mp4' }], { watermark_text: 'TEST' });
  await merge.processVideoMerge(db, log, created.merge_id, '');
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'completed', record.error_msg);
  const evidence = tail.probeLastFrame(path.join(root, record.merged_url));
  assert.equal(evidence.frame_count, 4);
  assert.equal(evidence.last_pts, 1.7);
});
test('post failure is fatal; narration/subtitles/watermark receive measured scene durations', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  let received;
  t.mock.method(post, 'runMergedEpisodePostProcess', async (_db, _log, opts) => { received = opts; return { ok: false, error: 'forced post failure' }; });
  const created = startMerge(db, scenes(), { burn_narration_subtitles: true, watermark_text: 'TEST' });
  await merge.processVideoMerge(db, log, created.merge_id, '');
  failed(db, created);
  assert.deepEqual(received.scenes.map((s) => s.duration), [1, 0.5]);
  assert.ok(received.scenes.every((s) => s.duration_source === 'ffprobe'));
  assert.equal(fs.existsSync(received.mergedAbsPath), false);
});
test('real narration subtitles and watermark follow measured boundaries without remote TTS', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  db.exec("UPDATE storyboards SET narration='Local fixture' WHERE episode_id=1");
  const synth = t.mock.method(require('../src/services/ttsService'), 'synthesize', async () => ({ local_path: 'narr.mp3' }));
  const created = startMerge(db, scenes(), { burn_narration_subtitles: true, watermark_text: 'TEST' });
  await merge.processVideoMerge(db, log, created.merge_id, '');
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'completed', record.error_msg);
  assert.equal(synth.mock.callCount(), 2);
  assert.ok(Math.abs(record.duration - 1.5) < 0.12);
  const subtitle = fs.readFileSync(path.join(root, record.merged_url.replace(/_post\.mp4$/, '_narration.srt')), 'utf8');
  assert.match(subtitle, /00:00:00,000 --> 00:00:01,000/);
  assert.match(subtitle, /00:00:01,000 --> 00:00:01,500/);
  assert.doesNotMatch(subtitle, /00:01:39/);
});
test('missing legacy local download recovers only the same selected remote URL for full merge', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); mergeConfig(t);
  db.exec("UPDATE storyboards SET local_path='removed.mp4' WHERE id=11");
  t.mock.method(global, 'setImmediate', () => 0);
  const fetched = t.mock.method(global, 'fetch', async (url) => {
    assert.equal(url, 'https://media.invalid/selected.mp4');
    return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(root, 'selected.mp4')) };
  });
  const created = drama.finalizeEpisode(db, log, 1, 'http://fixture/static');
  await merge.processVideoMerge(db, log, created.merge_id, 'http://fixture/static');
  const record = db.prepare('SELECT * FROM video_merges WHERE id=?').get(created.merge_id);
  assert.equal(record.status, 'completed', record.error_msg);
  assert.equal(record.duration, 1.5);
  assert.equal(fetched.mock.callCount(), 1);
});
test('post processing rejects unmeasured planned durations', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t);
  const result = await post.runMergedEpisodePostProcess(db, log, {
    mergedAbsPath: path.join(root, 'selected.mp4'), storageRoot: root, episodeId: 1,
    scenes: scenes(), mergeOpts: { watermark_text: 'TEST' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /实际时长/);
});

test('tail link uses the adopted version and verified true last frame, never the newer completed result', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); choose(db);
  const res = await link(db);
  assert.equal(res.statusCode, 200, JSON.stringify(res.data));
  assert.equal(res.data.source.version_id, 'chosen');
  assert.equal(res.data.source.frame_count, 4);
  assert.equal(res.data.source.frame_index, 3);
  assert.equal(res.data.source.last_pts, 0.75);
  assertBlue(path.join(root, res.data.local_path));
  const next = db.prepare('SELECT * FROM storyboards WHERE id=12').get();
  assert.equal(next.first_frame_image_id, res.data.new_first_frame_image_id);
  assert.match(db.prepare('SELECT prompt FROM image_generations').get().prompt, /"frame_index":3/);
});
test('tail link keeps legacy selection without planning schema', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t, false);
  const res = await link(db);
  assert.equal(res.statusCode, 200, JSON.stringify(res.data));
  assert.equal(res.data.source.version_id, null);
  assertBlue(path.join(root, res.data.local_path));
});
test('tail link recovers a missing local file only from the same legacy selected URL', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t, false);
  db.exec("UPDATE storyboards SET local_path='removed.mp4' WHERE id=11");
  const fetched = t.mock.method(global, 'fetch', async (url) => {
    assert.equal(url, 'https://media.invalid/selected.mp4');
    return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(root, 'selected.mp4')) };
  });
  const res = await link(db);
  assert.equal(res.statusCode, 200, JSON.stringify(res.data));
  assert.equal(fetched.mock.callCount(), 1);
  assertBlue(path.join(root, res.data.local_path));
});
test('tail link rejects adoption changes while the selected video is downloading', async (t) => {
  if (!mediaAvailable(t)) return;
  const db = database(t); choose(db);
  db.exec("UPDATE video_plan_versions SET local_path='removed.mp4' WHERE id='chosen'");
  t.mock.method(global, 'fetch', async () => {
    choose(db, 'latest');
    return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(root, 'selected.mp4')) };
  });
  const res = await link(db);
  assert.equal(res.statusCode, 409);
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=12').get().first_frame_image_id, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM image_generations').get().n, 0);
});
test('VFR tail extraction uses decoded display index and last PTS', (t) => {
  if (!mediaAvailable(t)) return;
  const output = path.join(root, 'vfr-tail.jpg');
  const evidence = tail.extractLastFrame(path.join(root, 'vfr.mp4'), output);
  assert.equal(evidence.frame_count, 4);
  assert.equal(evidence.last_pts, 1.7);
  assertBlue(output);
});
for (const variant of ['missing file', 'invalid version', 'corrupt selected file']) {
  test(`tail failure does not select latest or mutate next storyboard: ${variant}`, async (t) => {
    if (!mediaAvailable(t)) return;
    const db = database(t); choose(db);
    if (variant === 'missing file') {
      db.exec("UPDATE video_plan_versions SET local_path='absent.mp4' WHERE id='chosen'");
      t.mock.method(global, 'fetch', async () => { throw new Error('selected URL unavailable'); });
    }
    if (variant === 'invalid version') db.exec("UPDATE video_plan_versions SET status='failed' WHERE id='chosen'");
    if (variant === 'corrupt selected file') {
      fs.writeFileSync(path.join(root, 'bad-selected.mp4'), 'broken');
      db.exec("UPDATE video_plan_versions SET local_path='bad-selected.mp4' WHERE id='chosen'");
    }
    const beforeNext = db.prepare('SELECT * FROM storyboards WHERE id=12').get();
    const res = await link(db);
    assert.ok(res.statusCode >= 400);
    assert.deepEqual(db.prepare('SELECT * FROM storyboards WHERE id=12').get(), beforeNext);
    assert.equal(db.prepare('SELECT count(*) AS n FROM image_generations').get().n, 0);
  });
}
