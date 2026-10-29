const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLatentArtifact, artifactEligibility } = require('../src/services/videoExecutionLatent');
const { inspectFile, inspectRemote } = require('../src/services/videoExecutionSafetensors');
const { createExecutionProvider, snapshotConnection } = require('../src/services/videoExecutionProvider');
const { createExecutionMedia } = require('../src/services/videoExecutionMedia');
const catalog = require('../src/services/videoWorkflowCatalog');
const task = 'lmd-comfy-' + '1'.repeat(32), prompt = 'prompt-1';
const prefix = `latents/localminidrama/${task}/latent`;
const filename = prefix + '_00001.safetensors';
const workflow = { ...catalog.getVideoWorkflow('h3-long-drama-first'), ...catalog.getVideoWorkflowDefinition('h3-long-drama-first') };
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-exec-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function tensor() {
  const json = JSON.stringify({ latent: { dtype: 'F32', shape: [1, 2], data_offsets: [0, 8] } });
  const header = Buffer.from(json.padEnd(Math.ceil(json.length / 8) * 8, ' ')), len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length)); return Buffer.concat([len, header, Buffer.alloc(8)]);
}
function writeTensor(root, name = filename) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, tensor()); return file; }
function provenance(overrides = {}) {
  return { task_id: task, prompt_id: prompt, workflow, metadata: { latent_output: { filename_prefix: prefix, directory: 'output' } },
    connection_identity: 'connection', iteration: 0, ...overrides };
}
function history(names = [filename], overrides = {}) {
  return { [prompt]: { prompt: [0, prompt, { 910: { class_type: 'H3SaveLatent', inputs: { filename_prefix: prefix } } }],
    outputs: { 910: { latents: names } }, ...overrides } };
}

test('exact registered save-node history resolves exact loader ref and exposes no GPU loadability claim', async t => {
  const root = temp(t); writeTensor(root);
  const artifact = await resolveLatentArtifact(provenance({ output_root: root, history: history() }));
  assert.equal(artifact.state, 'ready'); assert.equal(artifact.loader_ref, filename + ' [output]');
  assert.equal(artifact.evidence, 'prompt_history_save_node'); assert.equal(artifact.structure_verified, true); assert.equal(artifact.loadability_verified, false);
  const segment = { task_id: task, prompt_id: prompt, connection_identity: 'connection', iteration: 0, workflow };
  assert.deepEqual(artifactEligibility(artifact, segment), []);
  assert.deepEqual(artifactEligibility(artifact, { ...segment, prompt_id: 'wrong' }), ['latent_provenance_mismatch']);
  fs.writeFileSync(path.join(root, filename), 'corrupted');
  assert.deepEqual(artifactEligibility(artifact, segment), ['latent_missing_or_outside_root']);
});

test('task-exclusive fallback never chooses newest output and refuses ambiguity, missing file or malformed safetensors', async t => {
  const root = temp(t); writeTensor(root);
  writeTensor(root, 'latents/localminidrama/lmd-comfy-' + '2'.repeat(32) + '/latent_00099.safetensors');
  let artifact = await resolveLatentArtifact(provenance({ output_root: root }));
  assert.equal(artifact.state, 'ready'); assert.equal(artifact.filename, filename); assert.equal(artifact.evidence, 'task_exclusive_root');
  writeTensor(root, prefix + '_00002.safetensors');
  artifact = await resolveLatentArtifact(provenance({ output_root: root })); assert.deepEqual(artifact.blocking_reasons, ['latent_ambiguous']);
  artifact = await resolveLatentArtifact(provenance({ output_root: root, history: history([prefix + '_missing.safetensors']) }));
  assert.deepEqual(artifact.blocking_reasons, ['latent_missing'], 'a missing exact history result must not fall back to another file');
  fs.writeFileSync(path.join(root, filename), 'not-a-tensor');
  artifact = await resolveLatentArtifact(provenance({ output_root: root, history: history() }));
  assert.deepEqual(artifact.blocking_reasons, ['latent_invalid_safetensors']);
});

test('wrong prompt/save node/prefix, foreign task files, traversal and symlinks never become source artifacts', async t => {
  const root = temp(t); writeTensor(root);
  for (const malicious of ['../latent_00001.safetensors', prefix + '/../../other.safetensors', prefix + '_%2e%2e.safetensors', 'C:/outside.safetensors', `latents/localminidrama/lmd-comfy-${'2'.repeat(32)}/latent_1.safetensors`]) {
    const artifact = await resolveLatentArtifact(provenance({ output_root: root, history: history([malicious]) }));
    assert.equal(artifact.state, 'blocked', malicious);
  }
  const wrongPrompt = history(); wrongPrompt[prompt].prompt[1] = 'other';
  assert.deepEqual((await resolveLatentArtifact(provenance({ output_root: root, history: wrongPrompt }))).blocking_reasons, ['latent_history_provenance_mismatch']);
  const wrongNode = history(); wrongNode[prompt].prompt[2]['910'].class_type = 'SaveImage';
  assert.equal((await resolveLatentArtifact(provenance({ output_root: root, history: wrongNode }))).state, 'blocked');
  const outside = path.join(root, 'different-task'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'latent_1.safetensors'), tensor());
  const task2 = 'lmd-comfy-' + '3'.repeat(32), prefix2 = `latents/localminidrama/${task2}/latent`;
  fs.symlinkSync(outside, path.join(root, 'latents/localminidrama', task2), 'junction');
  const artifact = await resolveLatentArtifact(provenance({ task_id: task2, output_root: root, metadata: { latent_output: { filename_prefix: prefix2, directory: 'output' } } }));
  assert.deepEqual(artifact.blocking_reasons, ['latent_outside_task_root']);
});

test('safetensors validation rejects huge header, noncontiguous offsets, truncated payload and non-file remote responses', async t => {
  const root = temp(t), file = writeTensor(root);
  assert.equal(inspectFile(file).structure_verified, true);
  const bytes = tensor();
  assert.equal((await inspectRemote(async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))).structure_verified, true);
  await assert.rejects(inspectRemote(async () => new Response('<html>not a file</html>', { headers: { 'content-type': 'text/html', 'content-length': '23' } })), /latent_invalid_response/);
  await assert.rejects(inspectRemote(async () => new Response(bytes.subarray(0, 20), { headers: { 'content-length': String(bytes.length) } })), /latent_truncated_response/);
  const large = Buffer.alloc(8); large.writeBigUInt64LE(9007199254740993n); fs.writeFileSync(file, Buffer.concat([large, bytes]));
  assert.throws(() => inspectFile(file), /latent_invalid_safetensors/);
  fs.writeFileSync(file, bytes.subarray(0, -1)); assert.throws(() => inspectFile(file), /latent_invalid_safetensors/);
});

function runtimeValidation(node) {
  const graph = { [node.workflow.output]: { class_type: 'VHS_VideoCombine' }, [node.workflow.latent_output]: { class_type: 'H3SaveLatent' } };
  return { valid: true, model: node.model_id, workflow: graph, metadata: { source_workflow: node.workflow.workflow, source_sha256: 'a'.repeat(64), seed: 123, width: 832, height: 480, fps: 24 } };
}
const connection = snapshotConnection({ id: 5, api_protocol: 'comfyui', base_url: 'http://original:8188', api_key: 'upstream-secret', settings: '{}' });

test('real provider uses managed adapter protocol and retains original upstream/token for submission, poll and history', async () => {
  const calls = [], node = { model_id: workflow.model_id, workflow, inputs: { prompt: 'hello', duration: 5, reference_image_urls: ['data:image/png;base64,AQID'] } };
  const response = { task_id: task, prompt_id: prompt, model: node.model_id, status: 'processing' };
  const provider = createExecutionProvider({ getBridgeConnection: async () => ({ baseUrl: 'http://managed:5681', token: 'transport-secret' }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/video/validate')) return Response.json(runtimeValidation(node));
      if (url.includes('/video/')) return Response.json(response);
      if (url.includes('/history/')) return Response.json(history());
      if (url.includes('/view?')) { const bytes = tensor(); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); }
      throw new Error('unexpected test request');
    } });
  const prepared = await provider.preflight(connection, node, null);
  assert.equal(prepared.body.comfyui_url, 'http://original:8188'); assert.equal(prepared.body.comfyui_token, 'upstream-secret');
  assert.deepEqual(prepared.body.reference_urls, ['data:image/png;base64,AQID']); assert.equal(prepared.body.seed, 123);
  const taskResult = await provider.submit(connection, node, prepared, { operation_id: 'local-operation' });
  await provider.poll(connection, node, taskResult);
  const artifact = await provider.resolveLatent(connection, node, taskResult, { metadata: provenance().metadata }, 0);
  assert.equal(artifact.state, 'ready'); assert.equal(artifact.loadability_verified, false);
  assert.ok(calls.filter(c => c.url.startsWith('http://managed')).every(c => c.options.headers.Authorization === 'Bearer transport-secret'));
  assert.equal(calls.find(c => c.url.includes('/video/task/')).options.headers['X-ComfyUI-Token'], 'upstream-secret');
  assert.ok(calls.filter(c => c.url.startsWith('http://original')).every(c => c.options.headers.Authorization === 'Bearer upstream-secret'));
});

test('real provider rejects missing finite-segment contract and redacts both tokens even at truncation boundary', async () => {
  const node = { model_id: workflow.model_id, workflow, inputs: { prompt: 'hello' } };
  const p = createExecutionProvider({ getBridgeConnection: async () => ({ baseUrl: 'http://managed', token: 'transport-secret' }),
    fetch: async () => Response.json({ error: 'x'.repeat(490) + 'transport-secret upstream-secret' }, { status: 400 }) });
  await assert.rejects(p.preflight(connection, node, null), error => !error.message.includes('transport') && !error.message.includes('upstream') && error.definitive_rejection);
  const bad = createExecutionProvider({ getBridgeConnection: async () => ({ baseUrl: 'http://managed', token: 'secret' }), fetch: async () => Response.json({ valid: true, model: node.model_id }) });
  await assert.rejects(bad.preflight(connection, node, null), /workflow_contract_mismatch/);
});

test('media adapter rejects foreign downloads, verifies playback, publishes once and reuses local media-only recovery', async t => {
  const root = temp(t); let downloads = 0;
  const media = createExecutionMedia({ fetch: async () => { downloads++; return new Response('fixture-mp4'); },
    runProcess: async () => JSON.stringify({ streams: [{ codec_type: 'video', width: 832, height: 480 }], format: { duration: '5' } }) });
  const snapshot = { ...connection, storage_local_path: root, files_base_url: '/static' };
  await assert.rejects(media.materialize(snapshot, {}, { video_url: 'http://foreign/view?filename=clip.mp4' }, 'bad'), /origin_mismatch/);
  const output = await media.materialize(snapshot, {}, { video_url: connection.base_url + '/view?filename=clip.mp4' }, 'segment-test');
  assert.equal(output.local_path, 'video-plans/segment-test.mp4'); assert.equal(downloads, 1);
  await media.materialize(snapshot, {}, { video_url: connection.base_url + '/view?filename=clip.mp4' }, 'segment-test');
  assert.equal(downloads, 1); assert.equal(fs.readFileSync(path.join(root, output.local_path), 'utf8'), 'fixture-mp4');
  assert.deepEqual(fs.readdirSync(path.join(root, 'video-plans')), ['segment-test.mp4']);
});

test('explicit media composition checks duration, normalizes streams and refuses duplicate immutable publication', async t => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'video-plans')); fs.writeFileSync(path.join(root, 'a.mp4'), 'a'); fs.writeFileSync(path.join(root, 'b.mp4'), 'b');
  let composed = 0;
  const media = createExecutionMedia({ runProcess: async (command, args) => {
    if (args.includes('-filter_complex')) { composed++; assert.ok(args.includes('-n')); assert.match(args[args.indexOf('-filter_complex') + 1], /concat=n=2/); fs.writeFileSync(args.at(-1), 'composed'); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 832, height: 480 }], format: { duration: /version/.test(args.at(-1)) ? '10' : '5' } });
  } });
  const snapshot = { ...connection, storage_local_path: root }, segments = [{ local_path: 'a.mp4', duration: 5 }, { local_path: 'b.mp4', duration: 5 }];
  const output = await media.compose(snapshot, segments, 'version-test'); assert.equal(output.duration, 10);
  await media.compose(snapshot, segments, 'version-test'); assert.equal(composed, 1);
  const outside = { local_path: '../escape.mp4', duration: 5 }; await assert.rejects(media.compose(snapshot, [outside, segments[0]], 'other-version'), /unsafe_path/);
});
