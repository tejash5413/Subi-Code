import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMonthlyLimit,
  idleManagedSession,
  validateAccessResponse,
  validateManagedModel,
  validateManagedModels,
  validateMonthlyLimit,
} from '../managedTypes';

const CAPS = { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false };

void test('access: allowed passes through', () => {
  assert.deepEqual(validateAccessResponse({ allowed: true }), { allowed: true });
});

void test('access: disabled code passes through', () => {
  assert.deepEqual(validateAccessResponse({ allowed: false, code: 'SUBI_ACCESS_DISABLED' }), {
    allowed: false,
    code: 'SUBI_ACCESS_DISABLED',
  });
});

void test('access: disabled without code defaults closed', () => {
  assert.deepEqual(validateAccessResponse({ allowed: false }), {
    allowed: false,
    code: 'SUBI_ACCESS_DISABLED',
  });
});

void test('access: malformed rejected', () => {
  assert.equal(validateAccessResponse(null), null);
  assert.equal(validateAccessResponse({}), null);
  assert.equal(validateAccessResponse({ allowed: 'yes' }), null);
  assert.equal(validateAccessResponse([]), null);
});

void test('model: valid record accepted', () => {
  assert.deepEqual(
    validateManagedModel({ modelKey: 'mdl_1', displayName: 'Subi One', capabilities: CAPS, contextLength: 128000 }),
    { modelKey: 'mdl_1', displayName: 'Subi One', capabilities: CAPS, contextLength: 128000 }
  );
});

void test('model: upstreamModelId rejected, never accepted', () => {
  assert.equal(
    validateManagedModel({
      modelKey: 'mdl_1',
      displayName: 'Subi One',
      capabilities: CAPS,
      upstreamModelId: 'x-ai/grok',
    }),
    null
  );
});

void test('model: malformed records rejected', () => {
  assert.equal(validateManagedModel(null), null);
  assert.equal(validateManagedModel({}), null);
  assert.equal(validateManagedModel({ modelKey: '', displayName: 'x', capabilities: CAPS }), null);
  assert.equal(validateManagedModel({ modelKey: 'a', displayName: 'x', capabilities: null }), null);
  assert.equal(
    validateManagedModel({ modelKey: 'a', displayName: 'x', capabilities: { ...CAPS, toolCalling: 'yes' } }),
    null
  );
  assert.equal(
    validateManagedModel({ modelKey: 'a', displayName: 'x', capabilities: CAPS, contextLength: -5 }),
    null
  );
});

void test('models: array validated strictly', () => {
  const good = { modelKey: 'mdl_1', displayName: 'One', capabilities: CAPS };
  assert.deepEqual(validateManagedModels([]), []);
  assert.deepEqual(validateManagedModels([good]), [
    { modelKey: 'mdl_1', displayName: 'One', capabilities: CAPS },
  ]);
  assert.equal(validateManagedModels('nope'), null);
  assert.equal(validateManagedModels([good, { ...good, upstreamModelId: 'x' }]), null);
});

void test('limit: configured value accepted', () => {
  assert.deepEqual(validateMonthlyLimit({ configured: true, monthlyTokenLimit: 100000, period: 'calendar_month' }), {
    configured: true,
    monthlyTokenLimit: 100000,
    period: 'calendar_month',
  });
});

void test('limit: zero means zero allowance', () => {
  assert.deepEqual(validateMonthlyLimit({ configured: true, monthlyTokenLimit: 0, period: 'calendar_month' }), {
    configured: true,
    monthlyTokenLimit: 0,
    period: 'calendar_month',
  });
});

void test('limit: malformed values rejected', () => {
  const base = { configured: true, period: 'calendar_month' };
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: -1 }), null);
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: 1.5 }), null);
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: '100000' }), null);
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: 100_000_001 }), null);
  assert.equal(validateMonthlyLimit({ ...base, monthlyTokenLimit: null }), null);
});

void test('limit: not-configured shape enforced', () => {
  assert.deepEqual(validateMonthlyLimit({ configured: false, monthlyTokenLimit: null, period: 'calendar_month' }), {
    configured: false,
    monthlyTokenLimit: null,
    period: 'calendar_month',
  });
  assert.equal(validateMonthlyLimit({ configured: false, monthlyTokenLimit: 0, period: 'calendar_month' }), null);
  assert.equal(
    validateMonthlyLimit({ configured: true, monthlyTokenLimit: 100, period: 'monthly' }),
    null
  );
  assert.equal(validateMonthlyLimit({ configured: 'yes', monthlyTokenLimit: null, period: 'calendar_month' }), null);
});

void test('idle/empty snapshots are fail-closed', () => {
  assert.deepEqual(idleManagedSession(), {
    status: 'idle',
    models: [],
    monthlyLimit: { configured: false, monthlyTokenLimit: null, period: 'calendar_month' },
  });
  assert.deepEqual(emptyMonthlyLimit(), {
    configured: false,
    monthlyTokenLimit: null,
    period: 'calendar_month',
  });
});
