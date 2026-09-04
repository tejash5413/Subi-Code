import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SafeLearnSmartUser } from '../../../types';
import { ManagedSessionController, toManagedWebviewState } from '../managedSessionController';
import type { ManagedSessionState } from '../managedTypes';

const USER: SafeLearnSmartUser = { uid: 'u1', email: 'a@school.edu', role: 'student' };

function allowedState(): ManagedSessionState {
  return {
    status: 'allowed',
    user: { uid: USER.uid, displayName: 'Ada', role: 'student' },
    models: [
      {
        modelKey: 'mdl_1',
        displayName: 'Subi One',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
        contextLength: 1000,
      },
    ],
    selectedModelKey: 'mdl_1',
    monthlyLimit: { configured: true, monthlyTokenLimit: 100000, period: 'calendar_month' },
  };
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, into);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectKeys(entry, into);
    }
  }
}

/** Exact key names that must never cross to the webview (structural check). */
const FORBIDDEN_WIRE_KEYS = new Set([
  'idToken',
  'refreshToken',
  'authorization',
  'apiKey',
  'upstreamModelId',
  'token',
  'secret',
  'password',
]);

void test('webview projection contains no forbidden keys', () => {
  const wire = toManagedWebviewState(allowedState());
  const keys = new Set<string>();
  collectKeys(wire, keys);
  for (const forbidden of FORBIDDEN_WIRE_KEYS) {
    assert.ok(!keys.has(forbidden), `wire payload must not contain key: ${forbidden}`);
  }
  // monthlyTokenLimit is an expected configuration key, not a credential.
  assert.ok(keys.has('monthlyTokenLimit'));
});

void test('webview projection survives hostile display names', () => {
  const hostile: ManagedSessionState = {
    ...allowedState(),
    user: { uid: 'u1', displayName: 'idToken upstreamModelId apiKey', role: 'student' },
  };
  const wire = toManagedWebviewState(hostile);
  const keys = new Set<string>();
  collectKeys(wire, keys);
  for (const forbidden of FORBIDDEN_WIRE_KEYS) {
    assert.ok(!keys.has(forbidden), `wire payload must not contain key: ${forbidden}`);
  }
  assert.equal(wire.user?.displayName, 'idToken upstreamModelId apiKey');
});

void test('idle/blocked/unavailable projections stay minimal', () => {
  for (const status of ['idle', 'loading', 'blocked', 'unavailable'] as const) {
    const wire = toManagedWebviewState({
      status,
      models: [],
      monthlyLimit: { configured: false, monthlyTokenLimit: null, period: 'calendar_month' },
      ...(status === 'blocked' ? { errorCode: 'SUBI_ACCESS_DISABLED' } : {}),
    });
    const keys = new Set<string>();
    collectKeys(wire, keys);
    assert.ok(!keys.has('selectedModelKey'));
    for (const forbidden of FORBIDDEN_WIRE_KEYS) {
      assert.ok(!keys.has(forbidden));
    }
  }
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

void test('managed code never touches secrets, providers, or stores', () => {
  const dir = path.join(__dirname, '..');
  const banned = [
    'SecretStorage',
    'AIProviderRegistry',
    'getApiKey',
    'openrouter.ai',
    'postMessage',
    'getFirestore',
    'firestore.',
    'selectedAI',
    'localStorage',
    'sessionStorage',
    'globalState',
  ];
  for (const file of ['managedTypes.js', 'learnsmartManagedService.js', 'managedSessionController.js', 'managedChatService.js', 'managedChatHistory.js', 'managedChatController.js']) {
    const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const token of banned) {
      assert.ok(!code.includes(token), `${file} must not reference ${token}`);
    }
  }
});

void test('upstreamModelId appears only as a rejection guard, never stored', () => {

  const dir = path.join(__dirname, '..');
  for (const file of ['learnsmartManagedService.js', 'managedSessionController.js']) {
    const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(!code.includes('upstreamModelId'), `${file} must not reference upstreamModelId`);
  }
  // managedTypes.ts may name the literal exactly once: the validator that
  // rejects any record carrying it. It must never be read into a variable,
  // assigned, or forwarded.
  const typesCode = stripComments(fs.readFileSync(path.join(dir, 'managedTypes.js'), 'utf8'));
  const occurrences = typesCode.split('upstreamModelId').length - 1;
  assert.equal(occurrences, 1);
  assert.ok(typesCode.includes("'upstreamModelId' in item"));
});

void test('managed bootstrap leaves BYOK state untouched', async () => {
  const byokSelection = { provider: 'openai', modelId: 'gpt-x' };
  const byokKeys = { 'subi.provider.openai.apiKey': 'sk-secret' };
  const auth = { getCurrentUser: () => USER, getIdToken: () => Promise.resolve('tok') };
  const service = {
    getAccessStatus: () => Promise.resolve({ allowed: true }),
    getModels: () => Promise.resolve([]),
    getMonthlyLimit: () =>
      Promise.resolve({ configured: false, monthlyTokenLimit: null, period: 'calendar_month' as const }),
  };
  const store = {
    loadSelectedModelKey: () => undefined,
    saveSelectedModelKey: () => undefined,
  };
  const controller = new ManagedSessionController(auth, service, store);
  const beforeSelection = JSON.stringify(byokSelection);
  const beforeKeys = JSON.stringify(byokKeys);
  await controller.bootstrap();
  await controller.setSelectedModelKey('anything');
  controller.clear();
  assert.equal(JSON.stringify(byokSelection), beforeSelection);
  assert.equal(JSON.stringify(byokKeys), beforeKeys);
});

void test('managed chat files never reference upstream identifiers', () => {
  const dir = path.join(__dirname, '..');
  for (const file of ['managedChatService.js', 'managedChatHistory.js', 'managedChatController.js']) {
    const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(!code.includes('upstreamModelId'), `${file} must not reference upstreamModelId`);
    assert.ok(!code.includes('upstream_model'), `${file} must not reference provider model IDs`);
  }
});
