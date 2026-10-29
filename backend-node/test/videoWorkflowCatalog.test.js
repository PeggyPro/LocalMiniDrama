'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/services/videoWorkflowCatalog');

test('catalog reflects read-only registry exactly and never claims real-machine verification', () => {
  const file = path.resolve(__dirname, '../scripts/comfyui-models.json');
  const before = fs.readFileSync(file, 'utf8');
  const registry = JSON.parse(before);
  const result = catalog.getVideoWorkflowCatalog();
  assert.deepEqual(result.items.map((item) => item.model_id), registry.models.map((entry) => entry.id));
  assert.ok(result.version);
  for (const item of result.items) {
    assert.equal(item.availability, 'registered_unverified');
    assert.equal(item.runtime_verified, false);
    assert.equal(item.requires_latent, item.stage === 'continue');
  }
  assert.equal(catalog.getVideoWorkflow('huobao_minimax_h3_reference_turbo_api').model_id, 'h3-standard');
  assert.equal(catalog.getVideoWorkflow('unknown'), null);
  assert.equal(catalog.getVideoWorkflow('h3-digital-human').input_supported, false);
  assert.equal(catalog.getVideoWorkflow('h3-long-drama-first').input_supported, true);
  assert.ok(catalog.getVideoWorkflow('h3-video-redraw').blocking_reasons.includes('unsupported_video_input'));
  result.items[0].model_id = 'mutated';
  assert.equal(catalog.getVideoWorkflowCatalog().items[0].model_id, 'h3-standard');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('continuation is explicit compatible lineage, not shared family or same model name', () => {
  assert.equal(catalog.isContinuationCompatible('h3-long-drama-first', 'h3-long-drama-continue'), true);
  assert.equal(catalog.isContinuationCompatible('h3-long-drama-continue', 'h3-long-drama-continue'), true);
  assert.equal(catalog.isContinuationCompatible('h3-long-action-first', 'h3-long-drama-continue'), false);
  assert.equal(catalog.isContinuationCompatible('h3-standard', 'h3-standard'), false);
  assert.equal(catalog.getVideoWorkflowDefinition('h3-long-drama-continue').latent_output, '910');
});

test('broken or ambiguous registrations fail closed', () => {
  assert.throws(() => catalog.buildVideoWorkflowCatalog({ models: [{ id: 'a' }, { id: 'a' }] }));
  const result = catalog.buildVideoWorkflowCatalog({ models: [{ id: 'a', kind: 'h3', stage: 'first', continuation_model: 'missing' }] });
  assert.equal(result.items[0].availability, 'blocked');
  assert.equal(result.items[0].recommendable, false);
});
