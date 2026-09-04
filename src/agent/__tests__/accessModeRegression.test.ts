import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isLearnSmartMode, canUseByokActions, canUseManagedActions, isAuthenticatedLearnSmart } from '../../services/accessModeGates';
import { SubiAccessMode, SubiIdentity } from '../../types';

void test('Phase 10A: agentMode is independent of accessMode gates', () => {
  // The existing accessMode gates must be unaffected by the new agentMode.
  const modes: Array<SubiAccessMode | null> = ['learnsmart', 'byok', 'free', null];
  for (const m of modes) {
    // These are pre-Phase-10A functions. Adding agentMode to the project
    // must not change their behavior.
    const learnsmart = isLearnSmartMode(m);
    const byok = canUseByokActions(m);
    if (m === 'learnsmart') {
      assert.equal(learnsmart, true);
      assert.equal(byok, false);
    } else {
      assert.equal(learnsmart, false);
      assert.equal(byok, true);
    }
  }
});

void test('Phase 10A: accessMode + agentMode coexist without interference', () => {
  // No function introduced in this phase reads agentMode to alter BYOK
  // gating. The accessMode gates are still authoritative.
  const guestIdentity: SubiIdentity = { type: 'guest' };
  const learnsmartIdentity: SubiIdentity = {
    type: 'learnsmart',
    user: { uid: 'u', email: 'a@b.com', role: 'student' },
  };
  // BYOK blocked in learnsmart mode regardless of agentMode.
  assert.equal(canUseByokActions('learnsmart'), false);
  // Managed requires both learnsmart mode AND authenticated identity.
  assert.equal(canUseManagedActions('learnsmart', guestIdentity), false);
  assert.equal(canUseManagedActions('learnsmart', learnsmartIdentity), true);
  // isAuthenticatedLearnSmart unchanged
  assert.equal(isAuthenticatedLearnSmart('byok', learnsmartIdentity), false);
  assert.equal(isAuthenticatedLearnSmart('learnsmart', learnsmartIdentity), true);
});

void test('Phase 10A: agent/ tool/ slash code contains no write/terminal/git primitives', () => {
  const newDirs = ['agent', 'slash', 'tools'];
  // This test is compiled to out/agent/__tests__/, so the source root is
  // ../../.. from __dirname (i.e., the project root). The source files live
  // under <root>/src/...
  const root = path.join(__dirname, '..', '..', '..', 'src');
  // Exclude the test file itself (which contains banned tokens in the ban list).
  const banned = [
    'WorkspaceEdit',
    'TextEdit',
    'applyEdit',
    'writeFile',
    'createDirectory',
    'fs.unlink',
    'fs.rm',
    'createTerminal',
    'sendText',
    'child_process',
    'node-pty',
    'execa',
  ];
  for (const d of newDirs) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    walk(dir, (file) => {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) return;
      if (file.endsWith('.test.ts') || file.endsWith('.test.js')) return;
      const src = fs.readFileSync(file, 'utf8');
      // Forbidden patterns: never WorkspaceEdit / TextEdit / applyEdit /
      // writeFile / createDirectory / fs.unlink / fs.rm / createTerminal /
      // sendText / child_process / node-pty / execa.
      const bannedPatterns = [
        /WorkspaceEdit/,
        /TextEdit/,
        /applyEdit/,
        /writeFile/,
        /createDirectory/,
        /fs\.unlink/,
        /fs\.rm/,
        /createTerminal/,
        /sendText/,
        /child_process/,
        /node-pty/,
        /execa/,
      ];
      for (const re of bannedPatterns) {
        assert.ok(
          !re.test(src),
          `${path.relative(root, file)} must not reference pattern ${re.source}`
        );
      }
      // Dangerous function calls. Skip RegExp .exec() method access.
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('.exec(') || line.includes('.exec (')) {
          continue;
        }
        assert.ok(!/\bexec\s*\(/.test(line), `${path.relative(root, file)} line ${i + 1} must not call exec()`);
        assert.ok(!/\bspawn\s*\(/.test(line), `${path.relative(root, file)} line ${i + 1} must not call spawn()`);
      }
    });
  }
});

void test('Phase 10A: slash command file is vscode-free', () => {
  const f = path.resolve(__dirname, '..', '..', '..', 'src', 'slash', 'SlashCommandParser.ts');
  const src = fs.readFileSync(f, 'utf8');
  // Only check import/from lines — ignore descriptive comments.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip non-import lines (comments, code using the word in descriptions).
    if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
      continue;
    }
    assert.ok(
      !line.includes('vscode'),
      `SlashCommandParser line ${i + 1} must not import vscode: ${line.trim()}`
    );
  }
});

void test('Phase 10A: agent mode file is vscode-free', () => {
  const f = path.resolve(__dirname, '..', '..', '..', 'src', 'agent', 'AgentMode.ts');
  const src = fs.readFileSync(f, 'utf8');
  assert.ok(!src.includes('vscode'), 'AgentMode must not import vscode');
});

void test('Phase 10A: managed chat production gate remains FALSE', () => {
  // Re-read the actual constant from the compiled managed chat service to
  // assert it has not been silently flipped to true during Phase 10A work.
  // From out/agent/__tests__/, the compiled managed service is at
  // ../../services/managed/managedChatService.js.
  const svc = require('../../services/managed/managedChatService') as { MANAGED_CHAT_ENABLED: boolean };
  assert.equal(svc.MANAGED_CHAT_ENABLED, false, 'MANAGED_CHAT_ENABLED must remain FALSE');
});

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'out') continue;
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}
