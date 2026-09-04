import test from 'node:test';
import assert from 'node:assert/strict';
import type { SafeLearnSmartUser } from '../../../types';
import { ManagedError } from '../learnsmartManagedService';
import {
  MANAGED_SELECTION_KEY,
  ManagedSessionController,
  toManagedWebviewState,
} from '../managedSessionController';
import type { ManagedModel, ManagedMonthlyLimit } from '../managedTypes';

const USER: SafeLearnSmartUser = { uid: 'u1', email: 'a@school.edu', role: 'student', schoolId: 's1' };
const MODELS: ManagedModel[] = [
  {
    modelKey: 'mdl_1',
    displayName: 'Subi One',
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
    contextLength: 1000,
  },
  {
    modelKey: 'mdl_2',
    displayName: 'Subi Two',
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
  },
];
const LIMIT: ManagedMonthlyLimit = { configured: true, monthlyTokenLimit: 100000, period: 'calendar_month' };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeService {
  accessCalls: number;
  modelCalls: number;
  limitCalls: number;
  accessImpl: () => Promise<{ allowed: boolean; code?: string }>;
  modelsImpl: () => Promise<ManagedModel[]>;
  limitImpl: () => Promise<ManagedMonthlyLimit>;
}

function fakeService(overrides: Partial<Pick<FakeService, 'accessImpl' | 'modelsImpl' | 'limitImpl'>> = {}): FakeService {
  const fake: FakeService = {
    accessCalls: 0,
    modelCalls: 0,
    limitCalls: 0,
    accessImpl: () => Promise.resolve({ allowed: true }),
    modelsImpl: () => Promise.resolve(MODELS),
    limitImpl: () => Promise.resolve(LIMIT),
    ...overrides,
  };
  return fake;
}

function servicePort(fake: FakeService): {
  getAccessStatus: (t: string, s?: AbortSignal) => Promise<{ allowed: boolean; code?: string }>;
  getModels: (t: string, s?: AbortSignal) => Promise<ManagedModel[]>;
  getMonthlyLimit: (t: string, s?: AbortSignal) => Promise<ManagedMonthlyLimit>;
} {
  return {
    getAccessStatus: () => {
      fake.accessCalls += 1;
      return fake.accessImpl();
    },
    getModels: () => {
      fake.modelCalls += 1;
      return fake.modelsImpl();
    },
    getMonthlyLimit: () => {
      fake.limitCalls += 1;
      return fake.limitImpl();
    },
  };
}

function fakeAuth(user: SafeLearnSmartUser | null = USER, tokenFails = false): {
  getCurrentUser: () => SafeLearnSmartUser | null;
  getIdToken: () => Promise<string>;
  tokenCalls: number;
} {
  const auth = {
    tokenCalls: 0,
    getCurrentUser: () => user,
    getIdToken: () => {
      auth.tokenCalls += 1;
      return tokenFails ? Promise.reject(new Error('expired')) : Promise.resolve('tok');
    },
  };
  return auth;
}

function memStore(initial?: string): {
  loadSelectedModelKey: () => string | undefined;
  saveSelectedModelKey: (key: string | undefined) => void;
  saved: (string | undefined)[];
  current: string | undefined;
} {
  const store = {
    current: initial,
    saved: [] as (string | undefined)[],
    loadSelectedModelKey: () => store.current,
    saveSelectedModelKey: (key: string | undefined) => {
      store.current = key;
      store.saved.push(key);
    },
  };
  return store;
}

void test('successful bootstrap builds allowed session', async () => {
  const auth = fakeAuth();
  const fake = fakeService();
  const store = memStore();
  const controller = new ManagedSessionController(auth, servicePort(fake), store);
  const seen: string[] = [];
  controller.onStateChanged = (state) => seen.push(state.status);
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.deepEqual(state.user, { uid: 'u1', role: 'student' });
  assert.equal(state.models.length, 2);
  assert.equal(state.selectedModelKey, 'mdl_1');
  assert.deepEqual(state.monthlyLimit, LIMIT);
  assert.ok(seen.includes('loading'));
  assert.ok(seen.includes('allowed'));
  assert.equal(auth.tokenCalls, 1);
});

void test('access denial stops before models and limit', async () => {
  const fake = fakeService({ accessImpl: () => Promise.resolve({ allowed: false, code: 'SUBI_ACCESS_DISABLED' }) });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'blocked');
  assert.equal(state.errorCode, 'SUBI_ACCESS_DISABLED');
  assert.equal(fake.modelCalls, 0);
  assert.equal(fake.limitCalls, 0);
  assert.deepEqual(state.models, []);
});

void test('access unavailable stops and fails closed', async () => {
  const fake = fakeService({
    accessImpl: () => Promise.reject(new ManagedError('SUBI_ACCESS_UNAVAILABLE', 'down')),
  });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  await controller.bootstrap();
  assert.equal(controller.getState().status, 'unavailable');
  assert.equal(controller.getState().errorCode, 'SUBI_ACCESS_UNAVAILABLE');
  assert.equal(fake.modelCalls, 0);
  assert.equal(fake.limitCalls, 0);
});

void test('models and limit run only after access, in parallel', async () => {
  const accessGate = deferred<{ allowed: boolean }>();
  const modelsGate = deferred<ManagedModel[]>();
  const limitGate = deferred<ManagedMonthlyLimit>();
  const fake = fakeService({
    accessImpl: () => accessGate.promise,
    modelsImpl: () => modelsGate.promise,
    limitImpl: () => limitGate.promise,
  });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  const run = controller.bootstrap();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.accessCalls, 1);
  assert.equal(fake.modelCalls, 0);
  assert.equal(fake.limitCalls, 0);
  accessGate.resolve({ allowed: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.modelCalls, 1);
  assert.equal(fake.limitCalls, 1);
  modelsGate.resolve(MODELS);
  limitGate.resolve(LIMIT);
  await run;
  assert.equal(controller.getState().status, 'allowed');
});

void test('models failure fails closed as unavailable', async () => {
  const fake = fakeService({ modelsImpl: () => Promise.reject(new ManagedError('managed_timeout', 'slow')) });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'unavailable');
  assert.equal(state.errorCode, 'managed_timeout');
  assert.deepEqual(state.models, []);
});

void test('limit failure fails closed as unavailable', async () => {
  const fake = fakeService({
    limitImpl: () => Promise.reject(new ManagedError('managed_invalid_response', 'bad')),
  });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  await controller.bootstrap();
  assert.equal(controller.getState().status, 'unavailable');
  assert.deepEqual(controller.getState().models, []);
});

void test('empty model list stays allowed with no selection', async () => {
  const fake = fakeService({ modelsImpl: () => Promise.resolve([]) });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.deepEqual(state.models, []);
  assert.equal(state.selectedModelKey, undefined);
});

void test('new bootstrap invalidates the old one', async () => {
  const gate1 = deferred<{ allowed: boolean }>();
  const user2: SafeLearnSmartUser = { uid: 'u2', email: 'b@school.edu', role: 'teacher' };
  let current: SafeLearnSmartUser | null = USER;
  const auth = { getCurrentUser: () => current, getIdToken: () => Promise.resolve('tok') };
  const fake = fakeService({ accessImpl: () => gate1.promise });
  const controller = new ManagedSessionController(auth, servicePort(fake), memStore());
  const first = controller.bootstrap();
  current = user2;
  // Second bootstrap uses immediate success; the first resolves late.
  fake.accessImpl = () => Promise.resolve({ allowed: true });
  fake.modelsImpl = () => Promise.resolve(MODELS);
  fake.limitImpl = () => Promise.resolve(LIMIT);
  await controller.bootstrap();
  gate1.resolve({ allowed: true });
  await first;
  const state = controller.getState();
  assert.equal(state.status, 'allowed');
  assert.equal(state.user?.uid, 'u2');
});

void test('clear during bootstrap leaves idle state', async () => {
  const gate = deferred<{ allowed: boolean }>();
  const fake = fakeService({ accessImpl: () => gate.promise });
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fake), memStore());
  const run = controller.bootstrap();
  controller.clear();
  gate.resolve({ allowed: true });
  await run;
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.models, []);
});

void test('token failure surfaces auth unavailable', async () => {
  const controller = new ManagedSessionController(fakeAuth(USER, true), servicePort(fakeService()), memStore());
  await controller.bootstrap();
  const state = controller.getState();
  assert.equal(state.status, 'unavailable');
  assert.equal(state.errorCode, 'managed_auth');
});

void test('saved selection restored only when still eligible', async () => {
  const store = memStore('mdl_2');
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fakeService()), store);
  await controller.bootstrap();
  assert.equal(controller.getState().selectedModelKey, 'mdl_2');
  assert.equal(store.current, 'mdl_2');
});

void test('stale saved selection cleared and replaced', async () => {
  const store = memStore('mdl_gone');
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fakeService()), store);
  await controller.bootstrap();
  assert.equal(controller.getState().selectedModelKey, 'mdl_1');
  assert.ok(store.saved.includes(undefined));
  assert.equal(store.current, 'mdl_1');
});

void test('setSelectedModelKey validates against current list', async () => {
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fakeService()), memStore());
  assert.equal(await controller.setSelectedModelKey('mdl_1'), false);
  await controller.bootstrap();
  assert.equal(await controller.setSelectedModelKey('nope'), false);
  assert.equal(await controller.setSelectedModelKey('mdl_2'), true);
  assert.equal(controller.getState().selectedModelKey, 'mdl_2');
  assert.equal(await controller.setSelectedModelKey(''), false);
});

void test('clear empties managed state and getState returns copies', async () => {
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fakeService()), memStore());
  await controller.bootstrap();
  controller.clear();
  const state = controller.getState();
  assert.equal(state.status, 'idle');
  state.models.push(MODELS[0]);
  assert.deepEqual(controller.getState().models, []);
});

void test('selection key constant uses managed-only namespace', () => {
  assert.equal(MANAGED_SELECTION_KEY, 'subi.selectedManagedModel');
});

void test('webview projection carries only safe fields', () => {
  const controller = new ManagedSessionController(fakeAuth(), servicePort(fakeService()), memStore());
  return controller.bootstrap().then(() => {
    const wire = toManagedWebviewState(controller.getState());
    assert.equal(wire.status, 'allowed');
    assert.deepEqual(Object.keys(wire).sort(), ['models', 'monthlyLimit', 'selectedModelKey', 'status', 'user']);
    assert.deepEqual(Object.keys(wire.models[0]).sort(), ['capabilities', 'contextLength', 'displayName', 'modelKey']);
    assert.deepEqual(Object.keys(wire.monthlyLimit).sort(), ['configured', 'monthlyTokenLimit', 'period']);
  });
});
