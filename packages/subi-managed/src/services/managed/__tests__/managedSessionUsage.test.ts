import test from 'node:test';
import assert from 'node:assert/strict';
import type { SafeLearnSmartUser } from '../../../types';
import { ManagedError } from '../learnsmartManagedService';
import { ManagedSessionController, toManagedWebviewState } from '../managedSessionController';
import type { ManagedModel, ManagedMonthlyLimit, ManagedUsageResponse } from '../managedTypes';

const USER: SafeLearnSmartUser = { uid: 'u1', email: 'a@school.edu', role: 'student', schoolId: 's1' };
const MODELS: ManagedModel[] = [
  {
    modelKey: 'mdl_1',
    displayName: 'Subi One',
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
    contextLength: 1000,
  },
];
const LIMIT: ManagedMonthlyLimit = { configured: true, monthlyTokenLimit: 100000, period: 'calendar_month' };
const USAGE: ManagedUsageResponse = {
  allowed: true,
  usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100000, usedTokens: 1200, remainingTokens: 98800 },
  chatAvailable: true,
};

function fakeService(overrides: Record<string, () => Promise<never>> = {}) {
  const calls = { access: 0, models: 0, limit: 0, usage: 0 };
  return {
    calls,
    port: {
      getAccessStatus: () => {
        calls.access += 1;
        return Promise.resolve({ allowed: true });
      },
      getModels: () => {
        calls.models += 1;
        return Promise.resolve(MODELS);
      },
      getMonthlyLimit: () => {
        calls.limit += 1;
        return Promise.resolve(LIMIT);
      },
      getUsage: () => {
        calls.usage += 1;
        return Promise.resolve(USAGE);
      },
      ...overrides,
    },
  };
}

function fakeAuth(user: SafeLearnSmartUser | null = USER) {
  return {
    getCurrentUser: () => user,
    getIdToken: () => Promise.resolve('tok'),
  };
}

function memStore() {
  return { loadSelectedModelKey: () => undefined, saveSelectedModelKey: () => undefined };
}

void test('bootstrap loads usage after allowed session', async () => {
  const svc = fakeService();
  const controller = new ManagedSessionController(fakeAuth(), svc.port, memStore());
  const seen: string[] = [];
  controller.onStateChanged = (state) => seen.push(`${state.status}/${state.usage.status}`);
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.equal(state.usage.status, 'ready');
  assert.equal(state.usage.chatAvailable, true);
  assert.deepEqual(state.usage.usage, USAGE.usage);
  assert.equal(svc.calls.usage, 1);
  assert.ok(state.usage.lastUpdatedAt !== undefined);
  assert.ok(seen.includes('allowed/ready'));
});

void test('usage loading state is observable via refresh', async () => {
  let release!: (value: ManagedUsageResponse) => void;
  const gate = new Promise<ManagedUsageResponse>((resolve) => {
    release = resolve;
  });
  const svc = fakeService();
  const usagePort = { ...svc.port, getUsage: () => gate };
  const controller = new ManagedSessionController(fakeAuth(), usagePort, memStore());
  const run = controller.bootstrap();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.getState().usage.status, 'loading');
  release(USAGE);
  await run;
  assert.equal(controller.getState().usage.status, 'ready');
});

void test('usage failure keeps allowed session with closed capability', async () => {
  const svc = fakeService();
  const failing = {
    ...svc.port,
    getUsage: () => Promise.reject(new ManagedError('managed_timeout', 'slow')),
  };
  const controller = new ManagedSessionController(fakeAuth(), failing, memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.equal(state.usage.status, 'error');
  assert.equal(state.usage.chatAvailable, false);
  assert.equal(state.usage.errorCode, 'managed_timeout');
  assert.equal(state.models.length, 1);
});

void test('usage denied exposes no quota, closes capability', async () => {
  const svc = fakeService();
  const denied = {
    ...svc.port,
    getUsage: () => Promise.resolve({ allowed: false as const, code: 'SUBI_ACCESS_DISABLED', chatAvailable: false as const }),
  };
  const controller = new ManagedSessionController(fakeAuth(), denied, memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.equal(state.usage.status, 'error');
  assert.equal(state.usage.chatAvailable, false);
  assert.equal(state.usage.usage, undefined);
});

void test('stale usage result never overwrites newer state', async () => {
  let release!: (value: ManagedUsageResponse) => void;
  const gate = new Promise<ManagedUsageResponse>((resolve) => {
    release = resolve;
  });
  const svc = fakeService();
  const hanging = { ...svc.port, getUsage: () => gate };
  const controller = new ManagedSessionController(fakeAuth(), hanging, memStore());
  const first = controller.bootstrap();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.clear();
  release(USAGE);
  await first;
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.usage.status, 'idle');
});

void test('retry reloads usage; clear resets usage', async () => {
  const svc = fakeService();
  const controller = new ManagedSessionController(fakeAuth(), svc.port, memStore());
  await controller.bootstrap();
  assert.equal(svc.calls.usage, 1);
  await controller.refreshUsage();
  assert.equal(svc.calls.usage, 2);
  assert.equal(controller.getState().usage.status, 'ready');
  controller.clear();
  const cleared = controller.getState();
  assert.equal(cleared.status, 'idle');
  assert.equal(cleared.usage.status, 'idle');
  assert.equal(cleared.usage.chatAvailable, false);
});

void test('access denied never calls usage', async () => {
  const svc = fakeService();
  const denied = {
    ...svc.port,
    getAccessStatus: () => Promise.resolve({ allowed: false, code: 'SUBI_ACCESS_DISABLED' }),
  };
  const controller = new ManagedSessionController(fakeAuth(), denied, memStore());
  await controller.bootstrap();
  assert.equal(controller.getState().status, 'blocked');
  assert.equal(svc.calls.usage, 0);
});

void test('webview projection carries usage and fail-closed sendState', async () => {
  const svc = fakeService();
  const controller = new ManagedSessionController(fakeAuth(), svc.port, memStore());
  await controller.bootstrap();
  const wire = toManagedWebviewState(controller.getState());
  assert.equal(wire.usage.status, 'ready');
  assert.equal(wire.usage.chatAvailable, true);
  assert.equal(wire.usage.usage?.usedTokens, 1200);
  assert.deepEqual(wire.sendState, { canSend: false, reason: 'build_disabled' });
  const blob = JSON.stringify(wire);
  for (const banned of ['upstreamModelId', 'testUids', 'reservation', 'Authorization', 'apiKey', 'secret']) {
    assert.ok(!blob.includes(banned), `projection leaks ${banned}`);
  }
});
