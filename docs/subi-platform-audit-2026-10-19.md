# Subi Code platform and branding audit — October 19, 2026

## Installed Windows update

The global CLI, VS Code extension and per-user desktop have been updated with
the new supplied glossy white ribbon emblem. The CLI reports 2.0.0-dev.19.
The extension retains manifest version 2.0.0 and contains the dev.19 binary.
The desktop package is built with version 2.0.0-dev.19 (Windows file properties
normalize its product version to 2.0.0.0). The NSIS installer exited 0.

Installed desktop: `C:\Users\Admin\AppData\Local\Programs\subicode-desktop\Subi Code Dev.exe`.
Normal account settings and sessions were preserved; private profiles were used
for automated runtime checks. Other extensions and reference projects remain.

After installation, Explorer still displayed the old blue/purple shortcut icon.
Direct extraction confirmed the installed executable already contained the new
white logo. Desktop and Start menu links were backed up, assigned a separate
hash-named ICO in the installed resources directory, and notified through the
Windows Shell refresh API. Shell extraction from the updated desktop link now
resolves the white logo. Evidence: `shortcut-icon-fix.json` and
`shortcut-shell-icon.png` in the audit directory. Future installers can recreate
the default executable-based shortcut reference.

All three installed native CLI copies match SHA256
`A91DB0D4D273735626694A77E3CD433538DC1CF29C5D17C646662C85D32C7B6B`.

Artifacts are under `artifacts/2026-10-19`:

- `learnsmart-subi-cli-2.0.0-dev.19.tgz`
- `subicode-2.0.0-win32-x64-dev19.vsix`
- `desktop-dev19/subi-desktop-win-x64.exe`

## Logo and shared UI

The canonical `assets/brand/subi-code-source.png` is byte-identical to
`C:\Users\Admin\Downloads\glossy_interlocking_ribbon_emblem.png`, SHA256
`8C0186D14C07B29ACB95A1923DADA0743D5764701A33B8272965C786DAB66763`.
The asset pipeline preserves the opaque supplied square composition. Updated
targets include shared app/UI marks, sign-in callbacks, website/favicon/PWA
assets, extension images and all desktop channel Windows ICO, Linux PNG and
macOS ICNS resources. Asset QA recorded 261 changed files, preserved target
dimensions and valid Windows/macOS icon formats. These are local source assets;
this audit does not deploy the hosted website.

The large centered CLI SUBICODE welcome wordmark remains. Its compact fallback
uses theme text colors. Build and Plan now appear in the shared app composer
when multiple primary agents are available, without requiring custom agents.
This reuses existing selection, keyboard and submission behavior, including
backend permissions. Web and desktop platforms share this implementation.

## Verification

- Root `bun run check`: 36/36 tasks passed.
- CLI: 309 passed, 8 skipped; TUI: 1,508 passed, 12 skipped.
- Desktop: 135; app unit: 762; app browser: 176; GUI extensions: 178 (1 skip).
- Managed account package: 76; plugin host: 9; client: 226 (4 skips);
  SDK: 39; session UI: 251; UI: 152 — all passed.
- Server: 78 passed, 6 skipped after correcting two stale upstream-brand/provider
  expectations; no server production behavior changed for those tests.
- Selected core agent/MCP/OAuth/plugin/permission/runner/recovery tests:
  539 passed, 1 skipped. This is not the entire core test suite.
- Build/Plan regression passed 10 repetitions; restoring the old production
  selector caused the expected failure. All 17 composer regression cases passed.
  Shared test seeding now uses actual Subi storage namespaces.
- Logo/welcome/design checks: 100 passed across 10 repetitions.
- Actual Windows terminal verified welcome, model/command/settings menus and
  narrow resizing. Packaged VSIX passed a native extension-host test, including
  activation, bundled CLI launch, terminal reuse and new terminal creation.
- Packaged desktop and installed desktop passed startup, title and real
  Build→Plan→Build switching with screenshots. Installed desktop first had a
  5-second CDP test-connection timeout; one unchanged confirmation run passed
  with no renderer errors. That initial failure is retained in the audit logs.

Logs, results, screenshots, fixture profiles and pre-change backups are in
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\platform-audit`.
Server/core/logo final logs are in the adjacent `subi2-20261018` directory.

## Remaining qualification

Linux/macOS assets and shared code are updated, but their native builds and
runtime tests are pending. This Windows machine has no Linux/macOS execution
host and lacks the corresponding optional native PTY dependencies. No signed,
notarized, published all-platform release is claimed. Broader extension/desktop
GUI redesign remains a separate follow-up.

The OpenCode catalog returned 200, but an honestly Subi-identified request to its
hosted free model returned 403 FreeTierError. Catalog visibility does not grant
Subi access to that restricted free tier. Keyless activation remains disabled;
LearnSmart and direct provider authentication are separate paths. No paid
inference, credit purchase, account reset, backend deployment or publishing was
performed. Overall unrestricted all-platform release remains NOT READY.

This project copy has no Git metadata; backups and hashes preserve the checkpoint.
