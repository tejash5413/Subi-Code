const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('secret gate permits the exact local compatibility route and still rejects provider URLs outside the gateway service', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subi-native-leak-gate-'));
  try {
    fs.cpSync(path.join(__dirname, '../src'), path.join(directory, 'src'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.copyFileSync(path.join(__dirname, '../scripts/check-no-leak.js'), path.join(directory, 'scripts/check-no-leak.js'));
    const scan = () => spawnSync(process.execPath, ['scripts/check-no-leak.js'], { cwd: directory, encoding: 'utf8', windowsHide: true });
    const clean = scan();
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    fs.writeFileSync(path.join(directory, 'src/nativeSentinel.js'), 'const upstream = "https://openrouter.ai/api/v1/chat/completions";');
    assert.equal(scan().status, 1);
    fs.writeFileSync(path.join(directory, 'src/nativeSentinel.js'), 'const upstream = "https://untrusted.example/agent/chat/completions";');
    assert.equal(scan().status, 1);
    fs.writeFileSync(path.join(directory, 'src/nativeSentinel.js'), 'const local = "/agent/chat/completions";');
    assert.equal(scan().status, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('subi-native-leak-gate-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
