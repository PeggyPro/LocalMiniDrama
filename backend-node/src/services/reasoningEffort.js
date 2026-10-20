const { isDeepSeekOfficialConfig, parseSettings } = require('./deepseekConfig');

/** Apply only the selected default; reasoning_efforts is UI metadata. */
function applyReasoningEffort(config, body) {
  // Official DeepSeek owns thinking mode and high/max normalization.
  if (isDeepSeekOfficialConfig(config)) return body;

  const value = parseSettings(config?.settings).reasoning_effort;
  if (typeof value !== 'string') return body;
  const effort = value.trim().toLowerCase();
  if (!effort || /^(auto|default)$/i.test(effort)) return body;

  return { ...body, reasoning_effort: effort };
}

module.exports = { applyReasoningEffort };
