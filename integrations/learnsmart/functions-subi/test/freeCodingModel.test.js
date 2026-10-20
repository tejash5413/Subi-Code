const test = require('node:test');
const assert = require('node:assert/strict');
const { isFreeCodingModel } = require('../src/services/freeCodingModel');
test('free fallback admission requires an enabled tool model, free upstream SKU and explicit zero token prices', () => {
  const model = { enabled: true, upstreamModelId: 'provider/model:free', capabilities: { toolCalling: true }, pricing: { input: '0', output: '0' } };
  assert.equal(isFreeCodingModel(model), true);
  for (const patch of [{ enabled: false }, { pricing: null }, { pricing: { input: '0', output: '.00001' } }, { pricing: { input: null, output: 0 } }, { upstreamModelId: 'provider/model' }, { capabilities: { toolCalling: false } }]) assert.equal(isFreeCodingModel({ ...model, ...patch }), false);
});
