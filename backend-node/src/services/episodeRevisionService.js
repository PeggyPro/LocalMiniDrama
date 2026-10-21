// All episode content writes share these transactions and optimistic revisions.
function apiError(statusCode, code, message, details) {
  const error = new Error(message);
  Object.assign(error, { statusCode, code, details });
  return error;
}

function positiveInteger(value, name) {
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw apiError(400, 'BAD_REQUEST', `${name} 必须为正整数`);
  }
  return Number(text);
}

function revision(value, name = 'expected_revision') {
  if (value === undefined || value === null) throw apiError(400, 'BAD_REQUEST', `${name} 必填`);
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw apiError(400, 'BAD_REQUEST', `${name} 必须为非负整数`);
  }
  return Number(text);
}

function assertRevision(actual, expected, collection = false) {
  if (actual !== expected) {
    throw apiError(409, 'REVISION_CONFLICT', '分集已被修改，请刷新后重试', collection
      ? { episodes_revision: actual }
      : { current_revision: actual });
  }
}

function getDrama(db, dramaId) {
  const id = positiveInteger(dramaId, 'drama_id');
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!drama) throw apiError(404, 'NOT_FOUND', '项目不存在');
  return drama;
}

function getEpisode(db, dramaId, episodeId) {
  const drama = getDrama(db, dramaId);
  const id = positiveInteger(episodeId, 'episode_id');
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(id, drama.id);
  if (!episode) throw apiError(404, 'NOT_FOUND', '分集不存在或不属于当前项目');
  return episode;
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;

function contentFields(input, withDuration = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'BAD_REQUEST', '分集必须为对象');
  const fields = {};
  for (const key of ['title', 'description', 'script_content']) {
    if (!has(input, key)) continue;
    if (input[key] !== null && typeof input[key] !== 'string') throw apiError(400, 'BAD_REQUEST', `${key} 必须为文本或 null`);
    fields[key] = key === 'title' ? input[key] ?? '' : input[key];
  }
  if (withDuration && has(input, 'duration')) {
    if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0) throw apiError(400, 'BAD_REQUEST', 'duration 必须为非负数');
    fields.duration = input.duration;
  }
  return fields;
}

function normalizeEpisodes(episodes) {
  if (!Array.isArray(episodes)) throw apiError(400, 'BAD_REQUEST', 'episodes 必填且为数组');
  const numbers = new Set();
  const ids = new Set();
  return episodes.map((item) => {
    const fields = contentFields(item, true);
    const number = positiveInteger(item.episode_number, 'episode_number');
    if (numbers.has(number)) throw apiError(400, 'BAD_REQUEST', 'episode_number 不能重复');
    numbers.add(number);
    const id = item.id == null ? null : positiveInteger(item.id, 'episode.id');
    if (id != null && ids.has(id)) throw apiError(400, 'BAD_REQUEST', 'episode.id 不能重复');
    if (id != null) ids.add(id);
    return { ...fields, episode_number: number, ...(id != null ? { id } : {}) };
  });
}

function touchCollection(db, dramaId, now) {
  db.prepare(`UPDATE dramas SET episodes_revision = episodes_revision + 1,
    total_episodes = (SELECT COUNT(*) FROM episodes WHERE drama_id = ? AND deleted_at IS NULL), updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`).run(dramaId, now, dramaId);
  return getDrama(db, dramaId).episodes_revision;
}

function insertEpisode(db, dramaId, number, fields, now) {
  const info = db.prepare(`INSERT INTO episodes
    (drama_id, episode_number, title, description, script_content, duration, status, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`)
    .run(dramaId, number, fields.title ?? `第${number}集`, fields.description ?? null, fields.script_content ?? null, fields.duration ?? 0, now, now);
  return Number(info.lastInsertRowid);
}

function writeFields(db, episodeId, fields, now) {
  const entries = Object.entries(fields);
  db.prepare(`UPDATE episodes SET ${entries.map(([key]) => `${key} = ?, `).join('')}
    revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(...entries.map(([, value]) => value), now, episodeId);
}

function createEpisode(db, dramaId, input = {}) {
  const fields = contentFields(input, true);
  return db.transaction(() => {
    const drama = getDrama(db, dramaId);
    if (has(input, 'expected_collection_revision')) assertRevision(drama.episodes_revision, revision(input.expected_collection_revision, 'expected_collection_revision'), true);
    // Include deleted history when allocating numbers; a create never revives an old row.
    const max = db.prepare('SELECT MAX(episode_number) AS number FROM episodes WHERE drama_id = ?').get(drama.id).number;
    const number = positiveInteger(Number(max || 0) + 1, 'episode_number');
    const now = new Date().toISOString();
    const id = insertEpisode(db, drama.id, number, fields, now);
    const episodesRevision = touchCollection(db, drama.id, now);
    return { ...getEpisode(db, drama.id, id), episodes_revision: episodesRevision };
  })();
}

function updateEpisode(db, dramaId, episodeId, input = {}) {
  const fields = contentFields(input);
  const expected = revision(input.expected_revision);
  return db.transaction(() => {
    const episode = getEpisode(db, dramaId, episodeId);
    assertRevision(episode.revision, expected);
    let episodesRevision = getDrama(db, dramaId).episodes_revision;
    if (Object.keys(fields).length) {
      const now = new Date().toISOString();
      writeFields(db, episode.id, fields, now);
      episodesRevision = touchCollection(db, episode.drama_id, now);
    }
    return { ...getEpisode(db, dramaId, episode.id), episodes_revision: episodesRevision };
  })();
}

function deleteEpisode(db, dramaId, episodeId, input = {}) {
  const expected = revision(input.expected_revision);
  return db.transaction(() => {
    const episode = getEpisode(db, dramaId, episodeId);
    assertRevision(episode.revision, expected);
    const now = new Date().toISOString();
    db.prepare('UPDATE episodes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL').run(now, now, episode.id);
    return { episode_id: episode.id, revision: episode.revision + 1, episodes_revision: touchCollection(db, episode.drama_id, now) };
  })();
}

function saveEpisodes(db, dramaId, input = {}) {
  const episodes = normalizeEpisodes(input.episodes);
  const mode = input.mode === undefined ? 'replace' : input.mode;
  if (!['append', 'replace'].includes(mode)) throw apiError(400, 'BAD_REQUEST', 'mode 必须为 append 或 replace');
  // Mode-less PUT is the legacy replacement contract. Explicit bulk writes require a version.
  const expected = input.mode !== undefined || has(input, 'expected_collection_revision')
    ? revision(input.expected_collection_revision, 'expected_collection_revision') : null;
  return db.transaction(() => {
    const drama = getDrama(db, dramaId);
    if (expected !== null) assertRevision(drama.episodes_revision, expected, true);
    const live = db.prepare('SELECT * FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').all(drama.id);
    const byNumber = new Map();
    for (const row of live) {
      const number = Number(row.episode_number);
      if (byNumber.has(number)) throw apiError(409, 'EPISODE_NUMBER_CONFLICT', '现有分集编号重复，请先修正后保存');
      byNumber.set(number, row);
    }
    // Validate all supplied identities before the first write.
    for (const item of episodes) {
      if (mode === 'append' && byNumber.has(item.episode_number)) throw apiError(409, 'EPISODE_NUMBER_CONFLICT', '追加分集编号已存在，请刷新后重试');
      if (item.id != null && byNumber.get(item.episode_number)?.id !== item.id) {
        throw apiError(400, 'BAD_REQUEST', 'episode.id 必须属于当前项目的有效分集且编号一致');
      }
    }
    const now = new Date().toISOString();
    const kept = new Set();
    for (const item of episodes) {
      const { episode_number: number, id, ...fields } = item;
      const existing = byNumber.get(number);
      if (existing) {
        writeFields(db, existing.id, fields, now);
        kept.add(existing.id);
      } else {
        kept.add(insertEpisode(db, drama.id, number, fields, now));
      }
    }
    if (mode === 'replace') {
      const remove = db.prepare('UPDATE episodes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL');
      for (const row of live) if (!kept.has(row.id)) remove.run(now, now, row.id);
    }
    const episodesRevision = touchCollection(db, drama.id, now);
    return {
      episodes: db.prepare('SELECT * FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number, id').all(drama.id),
      episodes_revision: episodesRevision,
    };
  })();
}

module.exports = { apiError, positiveInteger, revision, assertRevision, getDrama, getEpisode, contentFields, normalizeEpisodes, createEpisode, updateEpisode, deleteEpisode, saveEpisodes };
