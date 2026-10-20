import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMonthlyLimit,
  idleManagedSession,
  idleManagedUsage,
  validateAccessResponse,
  validateManagedModel,
  validateManagedModels,
  validateManagedPolicySource,
  validateManagedUsage,
  validateMonthlyLimit,
  validateUsageResponse,
} from '../managedTypes';

const CAPS = { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false };

void test('models: complete eligible registries larger than 200 are retained', () => {
  const models = Array.from({ length: 651 }, (_, i) => ({ modelKey: `mdl_${i}`, displayName: `Model ${i}`, capabilities: CAPS }));
  assert.equal(validateManagedModels(models)?.length, 651);
});

void test('access: agent readiness survives validation without exposing rollout data', () => {
  assert.deepEqual(validateAccessResponse({ allowed: true, agentAvailable: false, testUids: ['private'] }), { allowed: true, agentAvailable: false });
  assert.equal(validateAccessResponse({ allowed: true, agentAvailable: 'yes' }), null);
});

void test('models: terminal compatibility is a strict optional enum', () => {
  const verified = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentTerminal: 'verified' },
  });
  assert.equal(verified?.capabilities.agentTerminal, 'verified');
  const unsupported = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentTerminal: 'unsupported' },
  });
  assert.equal(unsupported?.capabilities.agentTerminal, 'unsupported');
  const unknown = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentTerminal: 'sometimes' },
  });
  assert.equal(unknown?.capabilities.agentTerminal, undefined);
  const absent = validateManagedModel({ modelKey: 'mdl_1', displayName: 'One', capabilities: CAPS });
  assert.equal(absent?.capabilities.agentTerminal, undefined);
});

void test('models: verify compatibility is a strict optional enum incl. unknown', () => {
  const verified = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentVerify: 'verified' },
  });
  assert.equal(verified?.capabilities.agentVerify, 'verified');
  const unsupported = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentVerify: 'unsupported' },
  });
  assert.equal(unsupported?.capabilities.agentVerify, 'unsupported');
  const unknown = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentVerify: 'unknown' },
  });
  assert.equal(unknown?.capabilities.agentVerify, 'unknown');
  const bogus = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentVerify: 'sometimes' },
  });
  assert.equal(bogus?.capabilities.agentVerify, undefined);
  // agentTerminal=verified never implies agentVerify.
  const terminalOnly = validateManagedModel({
    modelKey: 'mdl_1', displayName: 'One',
    capabilities: { ...CAPS, toolCalling: true, agentTerminal: 'verified' },
  });
  assert.equal(terminalOnly?.capabilities.agentTerminal, 'verified');
  assert.equal(terminalOnly?.capabilities.agentVerify, undefined);
});

void test('policy source accepts only the coarse safe allowlist', () => {
  assert.equal(validateManagedPolicySource('school'), 'school');
  assert.equal(validateManagedPolicySource('individual'), 'individual');
  assert.equal(validateManagedPolicySource('none'), 'none');
  assert.equal(validateManagedPolicySource(undefined), undefined);
  assert.equal(validateManagedPolicySource('individual_custom'), null);
});

void test('access: allowed passes through', () => {
  assert.deepEqual(validateAccessResponse({ allowed: true }), { allowed: true });
  assert.deepEqual(validateAccessResponse({ allowed: true, agentFile: 'plan' }), {
    allowed: true,
    agentFile: 'plan',
  });
  assert.deepEqual(validateAccessResponse({ allowed: true, agentFile: 'build' }), {
    allowed: true,
    agentFile: 'build',
  });
  assert.deepEqual(validateAccessResponse({ allowed: true, agentFile: 'invalid' }), {
    allowed: true,
  });
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
  // Live-sync repair: one unsafe record no longer nukes the whole effective
  // list (a malformed newly-assigned record must not hide every model).
  assert.deepEqual(validateManagedModels([good, { ...good, upstreamModelId: 'x' }]), [
    { modelKey: 'mdl_1', displayName: 'One', capabilities: CAPS },
  ]);
  // Total corruption still fails closed (non-empty input, zero valid).
  assert.equal(validateManagedModels([{ ...good, upstreamModelId: 'x' }]), null);
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
    usage: { status: 'idle', chatAvailable: false },
    agentFileCapability: 'none',
  });
  assert.deepEqual(emptyMonthlyLimit(), {
    configured: false,
    monthlyTokenLimit: null,
    period: 'calendar_month',
  });
  assert.deepEqual(idleManagedUsage(), { status: 'idle', chatAvailable: false });
});

void test('usage: valid snapshot accepted with server fields only', () => {
  assert.deepEqual(
    validateManagedUsage({
      configured: true,
      period: '2026-09',
      monthlyTokenLimit: 1500000,
      usedTokens: 26823,
      remainingTokens: 1473177,
      uid: 'u1',
      mode: 'test',
    }),
    {
      configured: true,
      period: '2026-09',
      monthlyTokenLimit: 1500000,
      usedTokens: 26823,
      remainingTokens: 1473177,
    }
  );
});

void test('usage: invalid shapes rejected', () => {
  const good = {
    configured: true,
    period: '2026-09',
    monthlyTokenLimit: 100,
    usedTokens: 10,
    remainingTokens: 90,
  };
  assert.equal(validateManagedUsage({ ...good, usedTokens: -1 }), null);
  assert.equal(validateManagedUsage({ ...good, usedTokens: 1.5 }), null);
  assert.equal(validateManagedUsage({ ...good, period: 'Sep 2026' }), null);
  assert.equal(validateManagedUsage({ ...good, monthlyTokenLimit: -1 }), null);
  assert.equal(validateManagedUsage({ ...good, remainingTokens: -2 }), null);
  assert.equal(validateManagedUsage({ ...good, configured: 'yes' }), null);
  assert.equal(validateManagedUsage(null), null);
  assert.equal(validateManagedUsage([]), null);
});

void test('usage response: denied carries safe code, capability closed', () => {
  assert.deepEqual(validateUsageResponse({ allowed: false, code: 'SUBI_ACCESS_DISABLED' }), {
    allowed: false,
    code: 'SUBI_ACCESS_DISABLED',
    chatAvailable: false,
  });
});

void test('usage response: missing chatAvailable fails closed', () => {
  const parsed = validateUsageResponse({
    allowed: true,
    usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100, usedTokens: 10, remainingTokens: 90 },
  });
  assert.deepEqual(parsed, {
    allowed: true,
    usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100, usedTokens: 10, remainingTokens: 90 },
    chatAvailable: false,
  });
  assert.equal(validateUsageResponse({ allowed: true, usage: null, chatAvailable: true }), null);
  assert.equal(validateUsageResponse({ nope: 1 }), null);
});
