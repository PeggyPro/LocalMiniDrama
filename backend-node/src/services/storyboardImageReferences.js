const path = require('path');

/** Compare storage aliases without rewriting explicit user references or merging unrelated remote URLs. */
function referenceKey(ref) {
  let value = String(ref || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (!isLocal || !url.pathname.startsWith('/static/')) return value;
      value = url.pathname;
    } catch (_) {
      return value;
    }
  }
  if (value.startsWith('data:')) return value;
  if (/^\/?static\//.test(value)) {
    value = value.replace(/^\/?static\//, '').split(/[?#]/)[0];
    try { value = decodeURIComponent(value); } catch (_) {}
  }
  return path.posix.normalize(value.replace(/^(?:\.\/)+/, ''));
}

/** Keep each label attached to its image through priority ordering, deduplication and limiting. */
function mergeStoryboardReferences(groups, limit) {
  const refs = [];
  const labels = [];
  const seen = new Set();
  for (const group of groups) {
    const groupLabels = Array.isArray(group.labels) ? group.labels : (group.labels || '').split('\n');
    for (let index = 0; index < (group.refs || []).length; index++) {
      const ref = group.refs[index];
      const key = referenceKey(ref);
      if (!key || seen.has(key)) continue;
      if (refs.length >= limit) break;
      seen.add(key);
      refs.push(ref);
      const description = String(groupLabels[index] || 'user-provided reference image')
        .replace(/^Image\s+\d+:\s*/i, '').trim();
      labels.push(`Image ${refs.length}: ${description}`);
    }
  }
  return { refs, contextNote: labels.join('\n') };
}

module.exports = { mergeStoryboardReferences };
