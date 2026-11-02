'use strict';

// Routing policy, not a quality benchmark or a statement about GPU availability.
const WORKFLOW_GUIDANCE = {
  'h3-standard': '通用单镜：环境建立、空镜、道具细节、简单走位；无明显表演或高强度动作重点。',
  'h3-drama': '文戏单镜：对白、表情反应、情绪变化、人物关系与细小叙事动作。',
  'h3-action': '武戏单镜：实际发生的打斗、追逐、快速攻防、冲撞、跌扑等高强度身体运动。',
  'h3-long-drama-first': '文戏连续镜头首段：后续有明确连续续拍需求时保存 latent；不是按秒数升级。',
  'h3-long-drama-continue': '接文戏配对首段或续段的末状态，无切镜、时间跳跃或机位重置。',
  'h3-long-action-first': '武戏连续镜头首段：连续打斗或追逐需要续拍时保存 latent。',
  'h3-long-action-continue': '接武戏配对首段或续段的末状态，延续同一连续动作与运镜。',
};
const RECOMMENDATION_INSTRUCTION = [
  '选择顺序：先判断独立镜头还是同镜头续拍，再按实际画面重心选标准/文戏/武戏。不得为了分布均匀而轮流使用模型，也不得把所有独立镜头都归标准。',
  '标准适合空镜、环境建立、道具细节、简单走位；文戏适合对白、表情反应、情绪和人物关系，包括扶人、递物、藏饼等细小叙事动作；武戏适合正在发生的打斗、追逐、冲撞、快速攻防。普通走路、拿物、战斗对白或回忆中的战斗字样，不足以判为武戏。',
  '续集、同角色、同地点、相近剧情或长时长不等于连续镜头。正反打、重新构图/机位重置、场景切换、时间跳跃、蒙太奇用独立 single；连续推拉摇移本身不是切镜。duration 不决定 first/continue，first 不会自动拆分长视频。',
  '只有明确从来源末帧的姿态、位置、运动方向、机位和时间状态继续拍摄，且无切镜，才选 continue 并写 continuous_shot:true。同地点只能佐证，不能代替衔接依据；信息不足用 single，并在 reason 说明缺少什么。',
  'first 只用于确有后续连续段或明确预留续拍需求的起始段。无来源但确需连续多段时，第一段用配对 first，后面才用 continue；文戏和武戏续接必须严格配对，不能偷偷把已选武戏首段改成文戏或反向换族。',
  '来源必须是允许候选或本批较早镜号；本批分镜用 draft_shot，不引用它的旧 source_key。手动锁定选择不变，若锁定 single 无 latent 或来源型号不兼容，放弃该续接并说明原因，不假设它会升级。',
  '既有视频有 MP4、尾帧图片或相同参考图，不代表有可续接 latent。source_key 候选仍须执行时验证产物、连接、尺寸及迭代链；候选的当前分镜文案不是已生成视频末帧的视觉验证。',
  '综合 video_prompt、universal_segment_text、creation_mode、action、dialogue、场景时间和运镜；全能模式主要看 universal_segment_text。正文被截断或内容互相矛盾时，不猜测续接。参考图数量和单段时长不决定文武类别。',
  'reason 必须引用本镜具体画面/动作，说明为何选该类别、独立或续拍；续拍说明具体来源和衔接状态，first 说明后续哪一镜需要续拍。不要只写“适合叙事/通用性好”，不要声称已验证画质或 GPU。',
].join('\n');

function workflowGuidance(modelId) {
  return WORKFLOW_GUIDANCE[modelId] || '专用工作流，仅在其专门用途和所需输入均明确满足时选择；不要作为普通短剧镜头默认项。';
}
function promptText(row) {
  return [row.video_prompt, row.universal_segment_text].filter(Boolean).join('\n');
}
function hasCutInstructions(row) {
  const prompt = promptText(row)
    .replace(/(?:不得|不要|不能|禁止|避免|没有|无|不)(?:任何)?(?:硬切|切镜|切换镜头|镜头切换|剪辑|转场|跳切|正反打|反打镜头|机位重置|时间跳跃)/g, '')
    .replace(/\b(?:no|without|avoid)\s+(?:(?:hard|jump)\s+)?(?:cuts?|cutting|montage|transitions?)\b/gi, '');
  return /硬切|切镜|切换镜头|镜头切换|多镜头|蒙太奇|剪辑|转场|跳切|切至|(?:镜头|画面)切到|切到(?:另一|远处|近景|特写|全景)|正反打|反打镜头|机位重置|时间跳跃|\bcut\s+to\b|\b(?:hard|jump)\s+cut\b|\bmontage\b|\bscene\s+cuts?\b|<cut>|\[cut\]/i.test(prompt);
}
const ACTION = /打斗|追逐|追赶|武打|战斗|搏斗|格斗|厮打|殴打|挥拳|出拳|拳打|踢踹|踢打|飞踢|挥刀|劈砍|刺杀|挥剑|厮杀|冲撞|飞扑|翻滚|摔倒|跌扑|狂奔|奔逃|\b(?:fight(?:s|ing)?|combat|chase|chasing|punch(?:es|ing)?|kick(?:s|ing)?|sprint(?:s|ing)?|tackl(?:e|ing))\b/i;
const DRAMA = /对白|对话|交谈|争辩|争吵|质问|低语|耳语|哭泣|落泪|含泪|哽咽|悲伤|恐惧|惊恐|愤怒|犹豫|迟疑|不安|焦虑|表情|神情|眼神|情绪|反应|凝视|沉默|微笑|点头|摇头|搀扶|扶起|扶人|递给|递物|藏饼|拥抱|\b(?:dialogue|conversation|whisper|crying|tears|emotion|reaction|hesitat\w*|smil\w*)\b/i;
function positiveVisualText(text) {
  // Quoted speech and explicitly negated clauses do not prove on-screen combat.
  return String(text || '').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, '')
    .split(/[，,。.!?！？；;\n]/).filter((clause) => !/(?:没有|禁止|避免|不得|不要|并非|无需|不涉及|不含|无|不)(?:出现|发生|进行|任何|实际|激烈|的|地|再|是)*\s*(?:打斗|追逐|追赶|武打|战斗|搏斗|格斗|挥拳|出拳|踢踹|冲撞|翻滚|摔倒)|\b(?:no|without|avoid|not)\b.*\b(?:fight\w*|combat|chas\w*|punch\w*|kick\w*)\b/i.test(clause)).join(' ');
}
function effectivePromptText(row) {
  return String(row.creation_mode === 'universal' ? row.universal_segment_text || row.video_prompt || '' : row.video_prompt || row.universal_segment_text || '');
}
function classifyShot(row) {
  const primary = effectivePromptText(row);
  const text = positiveVisualText([row.action, primary].filter(Boolean).join(' ') || [row.title, row.description].filter(Boolean).join(' '));
  const action = text.match(ACTION);
  if (action) return { category: 'action', evidence: `画面包含“${action[0]}”等高强度身体动作` };
  const emotion = text.match(DRAMA);
  const dialogue = String(row.dialogue || '').trim();
  if (emotion || (dialogue && !/^(?:无|无对白|无对话|无台词|none|null|n\/a)[。.]?$/i.test(dialogue))) {
    return { category: 'drama', evidence: emotion ? `画面以“${emotion[0]}”等人物表演/叙事动作为重心` : '本镜有实际对白，优先人物表演' };
  }
  return { category: 'standard', evidence: text.trim() ? '未识别到明显表演或高强度动作重点，按通用单镜处理' : '画面信息不足，暂用通用单镜，需补充内容后复核' };
}
function explicitPreviousTail(row) {
  const text = effectivePromptText(row);
  if (/(?:无需|不需要|不必|没有|不要|不得|禁止|不)(?:再)?(?:从|承接|衔接|接续|延续|接上)|\b(?:not|never|don't|mustn't|shouldn't|needn't|avoid|no\s+need\s+to)\s+(?:\w+\s+){0,3}(?:continue|resume|continuing|resuming)\b/i.test(text)) return false;
  return /(?:从|承接|衔接|接续|延续|接上)(?:上(?:一|个)(?:镜头|镜|段)|前(?:一)?(?:镜头|镜|段))(?:的)?(?:末帧|尾帧|结束姿态)|\b(?:continue|resume)\s+from\s+(?:the\s+)?(?:previous|preceding)\s+(?:shot|segment)(?:'s)?\s+(?:last|final)\s+frame\b/i.test(text);
}
function sameKnownSpaceTime(a, b) {
  const sameScene = a.scene_id != null && b.scene_id != null ? a.scene_id === b.scene_id
    : !!String(a.location || '').trim() && String(a.location).trim() === String(b.location || '').trim();
  const locationsConflict = a.location && b.location && String(a.location).trim() !== String(b.location).trim();
  return sameScene && !locationsConflict && !!String(a.time || '').trim() && String(a.time).trim() === String(b.time || '').trim();
}
function heuristicRecommendations(rows, choices = new Map(), allowedModels = new Set(Object.keys(WORKFLOW_GUIDANCE))) {
  const classified = rows.map(classifyShot);
  const result = rows.map((row, index) => {
    const preferred = `h3-${classified[index].category}`;
    const selected = allowedModels.has(preferred) ? preferred : allowedModels.has('h3-standard') ? 'h3-standard' : null;
    const availability = selected === preferred ? '' : selected ? `；${preferred} 未配置或未启用，降级使用已配置的通用标准模型` : `；${preferred} 与通用标准模型均未配置或未启用，需补充视频配置`;
    return { model_id: selected, continuous_shot: false,
      reason: `规则推荐（非 AI）：${classified[index].evidence}；无已确认的连续续拍关系，按独立单段处理；时长不作为首段或续接依据${availability}` };
  });
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1];
    // A suggestion for a locked target will not activate, so cannot justify a first segment upstream.
    if (choices.get(row.id)?.manual_locked || !explicitPreviousTail(row)) continue;
    const family = classified[i].category === 'action' ? 'action' : 'drama';
    const first = `h3-long-${family}-first`, continuation = `h3-long-${family}-continue`;
    const parentLock = choices.get(previous.id);
    const parentModel = parentLock?.manual_locked ? parentLock.model_id : result[i - 1].model_id;
    let rejection;
    if (!allowedModels.has(continuation) || !allowedModels.has(parentModel) || (!parentLock?.manual_locked && ![first, continuation].includes(parentModel) && !allowedModels.has(first))) rejection = '配对首段、续接或来源模型未配置或未启用';
    else if (Number(row.storyboard_number) !== Number(previous.storyboard_number) + 1) rejection = '本批未包含紧邻前镜';
    else if (!sameKnownSpaceTime(previous, row)) rejection = '前后镜场景/时间不一致或信息不足';
    else if (hasCutInstructions(previous) || hasCutInstructions(row)) rejection = '前后镜包含切镜或时间/机位重置要求';
    else if (['shot_type', 'angle', 'angle_h', 'angle_v'].some((key) => previous[key] && row[key] && previous[key] !== row[key])) rejection = '前后镜景别/机位不同，规则无法确认是连续运镜还是机位重置';
    else if ((classified[i - 1].category === 'action') !== (family === 'action')) rejection = '前后镜文武类别不同，不能自动跨族续接';
    else if (parentLock?.manual_locked && (!['ready', 'waiting_dependency'].includes(parentLock.validation_state) || ![first, continuation].includes(parentModel))) rejection = '前镜手动锁定的选择不具备可用的配对续接能力';
    else if (parentModel.startsWith('h3-long-') && ![first, continuation].includes(parentModel)) rejection = '前镜续接族不兼容';
    if (rejection) {
      result[i].reason += `；虽有续拍描述，但${rejection}，未自动绑定来源`;
      continue;
    }
    if (!parentLock?.manual_locked && ![first, continuation].includes(parentModel)) {
      result[i - 1].model_id = first;
      result[i - 1].reason = `规则推荐（非 AI）：${classified[i - 1].evidence}；第${row.storyboard_number}镜明确承接本镜末帧，改用配对首段保存 latent，等待执行验证`;
    }
    result[i] = { model_id: continuation, continuous_shot: true, predecessor: { kind: 'draft_shot', shot_number: previous.storyboard_number },
      reason: `规则推荐（非 AI）：${classified[i].evidence}；明确承接第${previous.storyboard_number}镜末帧，已知场景/时间相同且未发现切镜指令；使用${family === 'action' ? '武戏' : '文戏'}配对续接，须等待来源 latent 与运行条件验证` };
  }
  if (rows[0] && explicitPreviousTail(rows[0])) result[0].reason += '；本批未包含前镜，未猜测既有版本来源，请通过 AI 或手动选择核对来源';
  return result;
}
function storyboardPromptDetails(row, maxPrompt = 12000) {
  const limits = { title: 200, description: 1800, action: 1800, dialogue: 1800, narration: 1000, result: 800, atmosphere: 400,
    location: 300, time: 100, shot_type: 100, angle: 200, angle_h: 100, angle_v: 100, movement: 500, creation_mode: 40,
    video_prompt: maxPrompt, universal_segment_text: maxPrompt };
  const out = { shot_number: row.storyboard_number, duration: row.duration, scene_id: row.scene_id ?? null };
  const truncated = [];
  for (const [key, limit] of Object.entries(limits)) {
    const value = String(row[key] || '');
    out[key] = value.slice(0, limit);
    if (value.length > limit) truncated.push(key);
  }
  out.truncated_fields = truncated;
  return out;
}
module.exports = { workflowGuidance, RECOMMENDATION_INSTRUCTION, hasCutInstructions, classifyShot, heuristicRecommendations, storyboardPromptDetails };
