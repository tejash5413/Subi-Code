const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../src/services/managedAgentValidator');
const service = require('../src/services/managedAgentService');
const png = { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
const body = (images = [png]) => ({ protocolVersion: 1, modelKey: 'mdl_a', agentMode: 'ask', clientRunId: 'images', providerRequestIndex: 0, toolCapabilityVersion: 'read_v1', canonicalTurns: [{ role: 'user', content: 'Inspect image and attached file: const a = 1;', images }] });

test('managed image contract preserves file text and sends image content to provider', () => {
  const v = validator.validateAgentBody(body());
  assert.deepEqual(v.canonicalTurns[0].images, [png]);
  assert.deepEqual(service.toOpenRouterMessages(v.canonicalTurns, 'server system')[1], { role: 'user', content: [{ type: 'text', text: body().canonicalTurns[0].content }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.base64}` } }] });
});

test('managed images reject spoofing, URLs, unknown fields, malformed encoding and non-user turns', () => {
  for (const image of [{ ...png, mimeType: 'image/jpeg' }, { ...png, base64: 'https://example.test/image.png' }, { ...png, url: 'https://example.test/' }, { ...png, base64: 'a===' }, { mimeType: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') }]) {
    assert.throws(() => validator.validateAgentBody(body([image])), e => e.code === 'INVALID_REQUEST');
  }
  const b = body(); b.canonicalTurns.unshift({ role: 'assistantText', content: 'hidden', images: [png] });
  assert.throws(() => validator.validateAgentBody(b), e => e.code === 'INVALID_REQUEST');
});

test('managed image count and aggregate decoded-byte limits apply across turns', () => {
  assert.throws(() => validator.validateAgentBody(body(Array(5).fill(png))), e => e.code === 'REQUEST_TOO_LARGE');
  const data = Buffer.alloc(3 * 1024 * 1024); Buffer.from(png.base64, 'base64').copy(data);
  const image = { mimeType: 'image/png', base64: data.toString('base64') };
  assert.throws(() => validator.validateAgentBody(body([image, image])), e => e.code === 'REQUEST_TOO_LARGE');
});
