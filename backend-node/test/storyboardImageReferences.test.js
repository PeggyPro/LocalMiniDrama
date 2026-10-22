const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { mergeStoryboardReferences } = require('../src/services/storyboardImageReferences');
const imageService = require('../src/services/imageService');
const imageClient = require('../src/services/imageClient');
const aiClient = require('../src/services/aiClient');
const appConfig = require('../src/config');

const noopLog = { info() {}, warn() {}, error() {} };
const FIRST = 'images/first.png';
const SCENE = 'scenes/current.png';
const CHARACTER = 'characters/xumu-current.png';
const LIBRARY = 'characters/xumu-stale.png';
const PROP = 'props/current.png';
const INSPIRATION = 'props/inspiration.png';
const MANUAL = 'https://manual.example/reference.png?version=2';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER, characters TEXT,
      angle_s TEXT, shot_type TEXT, action TEXT, dialogue TEXT, result TEXT,
      first_frame_image_id INTEGER, image_url TEXT, local_path TEXT,
      last_frame_image_url TEXT, last_frame_local_path TEXT, polished_prompt TEXT,
      error_msg TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY, storyboard_id INTEGER, drama_id INTEGER, character_id INTEGER,
      scene_id INTEGER, status TEXT, model TEXT, prompt TEXT, description TEXT,
      negative_prompt TEXT, frame_type TEXT, reference_images TEXT,
      use_first_frame_layout_lock INTEGER, local_path TEXT, image_url TEXT,
      size TEXT, updated_at TEXT, error_msg TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, image_url TEXT, local_path TEXT,
      appearance TEXT, identity_anchors TEXT, deleted_at TEXT
    );
    CREATE TABLE character_libraries (
      id INTEGER PRIMARY KEY, name TEXT, four_view_image_url TEXT, image_url TEXT,
      local_path TEXT, appearance TEXT, identity_anchors TEXT, deleted_at TEXT
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, location TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, local_path TEXT,
      ref_image TEXT, extra_images TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE ai_service_configs (id INTEGER PRIMARY KEY, service_type TEXT, deleted_at TEXT);
  `);
  return db;
}

async function captureRequest(t, options = {}) {
  const db = createTestDb();
  t.after(() => db.close());
  const charactersJson = options.charactersJson === undefined ? '[4]' : options.charactersJson;
  db.prepare('INSERT INTO dramas (id) VALUES (1)').run();
  db.prepare('INSERT INTO episodes (id, drama_id) VALUES (1, 1)').run();
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, scene_id, characters, first_frame_image_id, local_path, image_url)
    VALUES (7, 1, 2, ?, 10, ?, ?)`).run(charactersJson, FIRST, '/static/' + FIRST);
  db.prepare('INSERT INTO scenes (id, location, local_path) VALUES (2, ?, ?)').run('Courtyard', SCENE);
  db.prepare('INSERT INTO characters (id, drama_id, name, local_path) VALUES (4, 1, ?, ?)')
    .run('徐牧', options.missingCharacterImage ? null : CHARACTER);
  db.prepare('INSERT INTO character_libraries (id, name, four_view_image_url) VALUES (99, ?, ?)')
    .run(' 徐牧 ', LIBRARY);
  db.prepare('INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (7, 99)').run();
  db.prepare('INSERT INTO props (id, name, local_path, ref_image) VALUES (3, ?, ?, ?)')
    .run('Sword', options.missingPropImage ? null : PROP, INSPIRATION);
  if (!options.withoutProp) {
    db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (7, 3)').run();
  }
  db.prepare(`INSERT INTO image_generations (id, status, local_path, image_url)
    VALUES (10, 'completed', ?, ?)`).run(FIRST, '/static/' + FIRST);
  db.prepare(`INSERT INTO image_generations
    (id, storyboard_id, drama_id, status, model, prompt, frame_type, reference_images, use_first_frame_layout_lock)
    VALUES (20, 7, 1, 'pending', 'gpt-image-test', ?, ?, ?, ?)`)
    .run(options.prompt || 'A man opens the courtyard door.', options.frameType || 'first',
      JSON.stringify(options.manualRefs || []), options.layoutLock === false ? 0 : 1);

  t.mock.method(appConfig, 'loadConfig', () => ({
    storage: { local_path: './unused-test-storage', base_url: 'http://localhost:5680/static' },
  }));
  t.mock.method(imageClient, 'getDefaultImageConfig', () => ({
    service_type: 'storyboard_image',
    provider: options.protocol === 'kling' ? 'kling' : 'openai',
    api_protocol: options.protocol || 'openai', model: 'gpt-image-test',
  }));
  t.mock.method(aiClient, 'generateText', async () => assert.fail('Unexpected text generation'));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network request'));
  let captured;
  t.mock.method(imageClient, 'callImageApi', async (_db, _log, request) => {
    captured = request;
    // Stop at the API boundary: no downloads, generated files or runtime state are touched.
    return { error: 'isolated reference capture' };
  });
  await imageService.processImageGeneration(db, noopLog, 20);
  assert.ok(captured, 'generation must reach the mocked image API');
  assert.equal(db.prepare('SELECT error_msg FROM image_generations WHERE id = 20').get().error_msg,
    'isolated reference capture');
  return captured;
}

function labels(request) {
  const values = (request.system_prompt || '').split('\n');
  assert.equal(values.length, request.reference_image_urls.length);
  values.forEach((value, index) => assert.match(value, new RegExp(`^Image ${index + 1}: `)));
  return values;
}

describe('storyboard reference merge', () => {
  it('deduplicates local first-frame aliases before limiting and keeps layout priority', () => {
    const result = mergeStoryboardReferences([
      { refs: [FIRST], labels: ['Image 1: LAYOUT_LOCK: first frame layout lock'] },
      { refs: ['/static/' + FIRST, 'http://localhost:5680/static/' + FIRST, MANUAL] },
      { refs: [SCENE, CHARACTER], labels: ['Image 1: scene', 'Image 2: character'] },
    ], 4);
    assert.deepEqual(result.refs, [FIRST, MANUAL, SCENE, CHARACTER]);
    assert.deepEqual(result.contextNote.split('\n'), [
      'Image 1: LAYOUT_LOCK: first frame layout lock',
      'Image 2: user-provided reference image', 'Image 3: scene', 'Image 4: character',
    ]);
  });

  it('keeps unrelated remote static URLs, user ordering and complete data URLs distinct', () => {
    const dataPrefix = 'data:image/png;base64,' + 'A'.repeat(130);
    const refs = ['https://one.example/static/' + FIRST, 'https://two.example/static/' + FIRST,
      MANUAL, dataPrefix + 'B', dataPrefix + 'C'];
    const result = mergeStoryboardReferences([{ refs }], 10);
    assert.deepEqual(result.refs, refs);
  });
});

describe('imageService storyboard reference payloads (in-memory database and mocked APIs)', () => {
  it('sends tail layout, scene, XuMu and current prop exactly once with matching numbered labels', async (t) => {
    const request = await captureRequest(t, { frameType: 'last', manualRefs: ['/static/' + FIRST] });
    assert.deepEqual(request.reference_image_urls, [FIRST, SCENE, CHARACTER, PROP]);
    const values = labels(request);
    assert.match(values[0], /LAYOUT_LOCK: first frame layout lock/);
    assert.match(values[1], /scene background.*Courtyard/);
    assert.match(values[2], /character appearance.*徐牧/);
    assert.match(values[3], /prop\/object.*Sword/);
    assert.ok(!request.reference_image_urls.includes(INSPIRATION));
  });

  it('preserves an unlabeled manual reference without shifting automatic scene and character labels', async (t) => {
    const request = await captureRequest(t, { manualRefs: [MANUAL] });
    assert.deepEqual(request.reference_image_urls, [MANUAL, SCENE, CHARACTER, PROP]);
    const values = labels(request);
    assert.match(values[0], /user-provided reference image/);
    assert.match(values[1], /scene background/);
    assert.match(values[2], /character appearance.*徐牧/);
    assert.match(values[3], /prop\/object/);
  });

  it('uses the current selected character image without a competing same-name library image', async (t) => {
    const request = await captureRequest(t, { withoutProp: true });
    assert.deepEqual(request.reference_image_urls, [SCENE, CHARACTER]);
    assert.match(labels(request)[1], /current character image/);
  });

  it('uses the linked character library when the selected character has no image', async (t) => {
    const request = await captureRequest(t, { missingCharacterImage: true, withoutProp: true });
    assert.deepEqual(request.reference_image_urls, [SCENE, LIBRARY]);
    assert.match(labels(request)[1], /character appearance.*徐牧.*four-view/);
  });

  it('honors an explicit empty character selection despite stale links and a name in the prompt', async (t) => {
    const request = await captureRequest(t, { charactersJson: '[]', prompt: '徐牧 opens a door.' });
    assert.deepEqual(request.reference_image_urls, [SCENE, PROP]);
    assert.ok(labels(request).every((value) => !/character appearance/.test(value)));
  });

  it('does not inject the first frame when layout locking is disabled', async (t) => {
    const request = await captureRequest(t, { frameType: 'last', layoutLock: false });
    assert.deepEqual(request.reference_image_urls, [SCENE, CHARACTER, PROP]);
    assert.doesNotMatch(request.system_prompt, /LAYOUT_LOCK/);
    labels(request);
  });

  it('preserves an explicit first-frame image as manual input when automatic locking is disabled', async (t) => {
    const request = await captureRequest(t, {
      frameType: 'last', layoutLock: false, manualRefs: ['/static/' + FIRST],
    });
    assert.deepEqual(request.reference_image_urls, ['/static/' + FIRST, SCENE, CHARACTER, PROP]);
    assert.match(labels(request)[0], /user-provided reference image/);
    assert.doesNotMatch(request.system_prompt, /LAYOUT_LOCK/);
  });

  it('preserves all native Qwen references and ordered labels through the sixteenth socket', async (t) => {
    const manualRefs = Array.from({ length: 13 }, (_, index) => `https://manual.example/ref-${index}.png`);
    const request = await captureRequest(t, { protocol: 'comfyui', manualRefs });
    assert.deepEqual(request.reference_image_urls, [...manualRefs, SCENE, CHARACTER, PROP]);
    assert.equal(request.reference_image_urls.length, 16);
    assert.match(labels(request)[15], /prop\/object/);
  });

  it('retains native overflow including tail layout so validation can reject it without dropping selected images', async (t) => {
    const manualRefs = Array.from({ length: 13 }, (_, index) => `https://manual.example/ref-${index}.png`);
    const request = await captureRequest(t, { frameType: 'last', protocol: 'comfyui', manualRefs });
    assert.deepEqual(request.reference_image_urls, [FIRST, ...manualRefs, SCENE, CHARACTER, PROP]);
    assert.equal(request.reference_image_urls.length, 17);
    assert.match(labels(request)[0], /LAYOUT_LOCK/);
    assert.match(labels(request)[16], /prop\/object/);
  });

  it('preserves the one-image protocol cap and gives the tail layout reference priority', async (t) => {
    const request = await captureRequest(t, {
      frameType: 'last', protocol: 'kling', manualRefs: [MANUAL, '/static/' + FIRST],
    });
    assert.deepEqual(request.reference_image_urls, [FIRST]);
    assert.match(labels(request)[0], /LAYOUT_LOCK/);
  });

  it('retains correct labels and manual images after legacy prompt-based character filtering', async (t) => {
    const request = await captureRequest(t, { charactersJson: null, manualRefs: [MANUAL] });
    assert.deepEqual(request.reference_image_urls, [MANUAL, SCENE, PROP]);
    const values = labels(request);
    assert.match(values[0], /user-provided reference image/);
    assert.match(values[1], /scene background/);
    assert.match(values[2], /prop\/object/);
  });

  it('uses uploaded prop inspiration only when no current prop main image exists', async (t) => {
    const request = await captureRequest(t, { missingPropImage: true });
    assert.deepEqual(request.reference_image_urls, [SCENE, CHARACTER, INSPIRATION]);
    assert.match(labels(request)[2], /prop\/object/);
  });
});
