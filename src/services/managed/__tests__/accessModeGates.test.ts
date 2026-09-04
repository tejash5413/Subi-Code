import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SubiIdentity } from '../../../types';
import {
  canUseByokActions,
  canUseManagedActions,
  isAuthenticatedLearnSmart,
  isLearnSmartMode,
} from '../../accessModeGates';

const GUEST: SubiIdentity = { type: 'guest' };
const LEARNSMART: SubiIdentity = {
  type: 'learnsmart',
  user: { uid: 'u1', email: 'a@school.edu', role: 'student' },
};

// 1. accessMode=learnsmart + identity=guest → BYOK blocked (restore window).
void test('learnsmart mode with guest identity still blocks BYOK', () => {
  assert.equal(isLearnSmartMode('learnsmart'), true);
  assert.equal(canUseByokActions('learnsmart'), false);
  assert.equal(isAuthenticatedLearnSmart('learnsmart', GUEST), false);
  assert.equal(canUseManagedActions('learnsmart', GUEST), false);
});

// 2. accessMode=learnsmart + identity=learnsmart → BYOK blocked, managed allowed.
void test('authenticated learnsmart blocks BYOK and allows managed', () => {
  assert.equal(canUseByokActions('learnsmart'), false);
  assert.equal(isAuthenticatedLearnSmart('learnsmart', LEARNSMART), true);
  assert.equal(canUseManagedActions('learnsmart', LEARNSMART), true);
});

// 3. accessMode=byok + identity=guest → BYOK permitted normally.
void test('byok mode permits BYOK actions', () => {
  assert.equal(isLearnSmartMode('byok'), false);
  assert.equal(canUseByokActions('byok'), true);
  assert.equal(canUseManagedActions('byok', GUEST), false);
  assert.equal(canUseManagedActions('byok', LEARNSMART), false);
});

// Free / null / undefined are never LearnSmart mode.
void test('free and unknown modes permit BYOK and deny managed', () => {
  for (const mode of ['free', null, undefined] as const) {
    assert.equal(isLearnSmartMode(mode), false);
    assert.equal(canUseByokActions(mode), true);
    assert.equal(canUseManagedActions(mode, GUEST), false);
    assert.equal(canUseManagedActions(mode, LEARNSMART), false);
  }
});

// 6. Managed actions still require an authenticated LearnSmart identity.
void test('managed actions require mode plus authenticated identity', () => {
  assert.equal(canUseManagedActions('learnsmart', null), false);
  assert.equal(canUseManagedActions('learnsmart', undefined), false);
  assert.equal(canUseManagedActions(null, LEARNSMART), false);
});

function readCompiled(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');
}

// Static: every BYOK-only host handler must consult the LearnSmart-mode gate.
void test('host BYOK handlers are access-mode gated', () => {
  const code = readCompiled(path.join('sidebar', 'SidebarProvider.js'));
  for (const handler of [
    'handleConfigureProvider',
    'handleRemoveProviderKey',
    'handleSetProvider',
    'handleSetModel',
    'handleCatalogRequest',
    'handleConfirmCost',
    'handleSendMessage',
  ]) {
    assert.ok(code.includes(handler), `expected handler ${handler}`);
  }
  const gateCalls = code.split('this.isLearnSmartMode()').length - 1;
  assert.ok(gateCalls >= 8, `expected >=8 LearnSmart-mode gate calls, found ${gateCalls}`);
  assert.ok(code.includes('accessModeGates'), 'host must use the accessModeGates helper');
  assert.ok(code.includes('accessModeChanged'), 'host must emit accessModeChanged');
  assert.ok(code.includes('accessMode'), 'init must carry accessMode');
});

// Static: webview gates BYOK presentation on currentAccessMode, not identity alone.
void test('webview BYOK isolation uses access mode as primary gate', () => {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'media', 'sidebar.js'),
    'utf8'
  );
  assert.ok(code.includes('currentAccessMode'), 'webview must track currentAccessMode');
  assert.ok(code.includes('function isLearnSmartMode'), 'webview must define isLearnSmartMode');
  assert.ok(
    code.includes('function isAuthenticatedLearnSmart'),
    'webview must define isAuthenticatedLearnSmart'
  );
  assert.ok(code.includes('function applyModeVisibility'), 'webview must define applyModeVisibility');
  assert.ok(
    code.includes("currentAccessMode==='learnsmart'"),
    'LearnSmart gate must compare currentAccessMode'
  );
  assert.ok(
    code.includes("case 'accessModeChanged'"),
    'webview must handle accessModeChanged'
  );
});
