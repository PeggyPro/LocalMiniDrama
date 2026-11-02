const commonModels = ['h3-standard', 'h3-drama', 'h3-action', 'h3-long-drama-first', 'h3-long-drama-continue', 'h3-long-action-first', 'h3-long-action-continue'];
function seedVideoConfigs(db, models = commonModels) {
  db.exec(`CREATE TABLE ai_service_configs(id INTEGER PRIMARY KEY, name TEXT, service_type TEXT, provider TEXT, api_protocol TEXT,
    base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, settings TEXT, endpoint TEXT, query_endpoint TEXT,
    is_active INTEGER, is_default INTEGER, priority INTEGER, deleted_at TEXT);`);
  const insert = db.prepare(`INSERT INTO ai_service_configs(id,name,service_type,provider,api_protocol,base_url,api_key,model,is_active,is_default,priority)
    VALUES(?,?,'video','ComfuUI','comfyui','http://comfy-test:8188','test-secret',?,1,?,?)`);
  models.forEach((model, i) => insert.run(i + 1, `Configured ${model}`, JSON.stringify([model]), Number(model === 'h3-standard'), 10 + i));
}
module.exports = { seedVideoConfigs, commonModels };
