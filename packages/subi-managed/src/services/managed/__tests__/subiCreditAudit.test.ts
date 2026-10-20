import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedSessionController, toManagedWebviewState } from '../managedSessionController';
import type { ManagedServicePort } from '../managedSessionController';

void test('expired individual bootstrap retains credit mode and renewal state without granting send access', async () => {
  const unexpected = () => { throw new Error('denied session must not load managed resources'); };
  const service: ManagedServicePort = {
    getAccessStatus: async () => ({ allowed: false, code: 'SUBI_PLAN_EXPIRED' }),
    getSubiCodeStatus: async () => ({ active: false, tier: null, renewalDateMs: 1790000000000,
      source: 'individual_subscription', quotaMode: 'individual_credits', code: 'SUBI_PLAN_EXPIRED' }),
    getModels: unexpected, getMonthlyLimit: unexpected, getUsage: unexpected,
  };
  const controller = new ManagedSessionController({
    getCurrentUser: () => ({ uid: 'expired-user', email: 'u@example.invalid', role: 'student', accountType: 'individual' }),
    getIdToken: async () => 'synthetic-token',
  }, service, { loadSelectedModelKey: () => undefined, saveSelectedModelKey: () => undefined });
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'blocked');
  assert.deepEqual(state.models, []);
  assert.equal(state.agentFileCapability, 'none');
  const wire = toManagedWebviewState(state);
  assert.equal(wire.monthlyLimit.quotaMode, 'individual_credits');
  assert.equal(wire.creditSummary?.health, 'expired');
  assert.equal(state.subscription?.active, false);
  assert.equal(wire.creditSummary?.totalAvailableMilli, null);
});

void test('account refresh after renewal rechecks access and restores the managed session', async () => {
  let active = false;
  const controller = new ManagedSessionController({
    getCurrentUser: () => ({ uid: 'expired-user', email: 'u@example.invalid', role: 'student', accountType: 'individual' }),
    getIdToken: async () => 'synthetic-token',
  }, {
    getAccessStatus: async () => active ? { allowed: true } : { allowed: false, code: 'SUBI_PLAN_EXPIRED' },
    getSubiCodeStatus: async () => ({ active, tier: null, renewalDateMs: 1790000000000,
      source: 'individual_subscription', quotaMode: 'individual_credits' }),
    getModels: async () => ({ models: [{ modelKey: 'approved-model', displayName: 'Approved', capabilities: { toolCalling: true, inputModalities: ['text'], outputModalities: ['text'] } }] }),
    getMonthlyLimit: async () => ({ configured: true, monthlyTokenLimit: null, period: 'calendar_month', quotaMode: 'individual_credits' }),
    getUsage: async () => ({ allowed: true, quotaMode: 'individual_credits', chatAvailable: true,
      usage: { quotaMode: 'individual_credits', configured: true, credits: { totalAvailableMilli: 1000000 } } }),
  }, { loadSelectedModelKey: () => undefined, saveSelectedModelKey: () => undefined });
  await controller.bootstrap();
  assert.equal(controller.getState().status, 'blocked');
  active = true;
  await controller.refreshAccount();
  assert.equal(controller.getState().status, 'allowed');
  assert.equal(controller.getState().selectedModelKey, 'approved-model');
  assert.equal(controller.getState().subscription?.active, true);
});
