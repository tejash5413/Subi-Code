import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

void test('Phase 10A: no WorkspaceEdit, applyEdit, fs.writeFile, createDirectory, createTerminal, child_process, exec, spawn, git mutation in agent/slash/tools', () => {
  const dirs = ['agent', 'slash', 'tools'];
  const root = path.resolve(__dirname, '..', '..', '..', 'src');
  const banned = [
    /WorkspaceEdit/,
    /TextEdit/,
    /applyEdit/,
    /\.writeFile/,
    /createDirectory/,
    /createTerminal/,
    /sendText/,
    /child_process/,
    /node-pty/,
    /execa/,
    /\.git\.commit/,
    /\.git\.push/,
    /\.git\.pull/,
    /\.git\.add/,
  ];
  for (const d of dirs) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    walk(dir, (file: string) => {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) return;
      if (file.endsWith('.test.ts') || file.endsWith('.test.js')) return;
      const src = fs.readFileSync(file, 'utf8');
      for (const re of banned) {
        assert.ok(
          !re.test(src),
          `${path.relative(root, file)} must not reference ${re.source}`
        );
      }
    });
  }
});

void test('Phase 10A: MANAGED_CHAT_ENABLED remains FALSE', () => {
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
