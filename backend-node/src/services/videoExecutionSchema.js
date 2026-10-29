// Explicit migration hook only. Read APIs never create or alter tables.
function ensureVideoExecutionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_execution_plans (
      id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, drama_id INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT
    );
    CREATE TABLE IF NOT EXISTS video_execution_nodes (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, position INTEGER NOT NULL,
      storyboard_id INTEGER NOT NULL, model_id TEXT NOT NULL,
      choice_revision INTEGER NOT NULL, content_fingerprint TEXT NOT NULL,
      choice_snapshot TEXT NOT NULL, inputs TEXT NOT NULL, workflow_snapshot TEXT NOT NULL,
      connection_snapshot TEXT NOT NULL, source_ref TEXT, source_node_id TEXT,
      source_version_id TEXT, source_segment_id TEXT, append_version_id TEXT,
      status TEXT NOT NULL, blocking_reasons TEXT NOT NULL DEFAULT '[]',
      version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(plan_id, storyboard_id)
    );
    CREATE INDEX IF NOT EXISTS idx_video_execution_nodes_plan ON video_execution_nodes(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_video_execution_nodes_source ON video_execution_nodes(source_node_id);
    CREATE TABLE IF NOT EXISTS video_execution_attempts (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, connection_snapshot TEXT NOT NULL,
      task_id TEXT, prompt_id TEXT, response TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_segments (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL UNIQUE, storyboard_id INTEGER NOT NULL,
      model_id TEXT NOT NULL, attempt_id TEXT NOT NULL, parent_segment_id TEXT,
      connection_identity TEXT NOT NULL, workflow_snapshot TEXT NOT NULL,
      task_id TEXT, prompt_id TEXT, iteration INTEGER NOT NULL DEFAULT 0,
      video_url TEXT NOT NULL, local_path TEXT, duration REAL,
      latent_artifact TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_plan_versions (
      id TEXT PRIMARY KEY, storyboard_id INTEGER NOT NULL, model_id TEXT NOT NULL,
      tail_segment_id TEXT NOT NULL, segment_ids TEXT NOT NULL,
      video_url TEXT NOT NULL, local_path TEXT, duration REAL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, append_version_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_plan_versions_storyboard ON video_plan_versions(storyboard_id, created_at);
  `);
}
function hasExecutionSchema(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_execution_plans'").get();
}
module.exports = { ensureVideoExecutionSchema, hasExecutionSchema };
