# Windows installation and desktop startup repair — October 18

All three Windows x64 components are installed from the local Subi 2.0 build.
This is development version 2.0.0-dev.16, not a completed release qualification.
No deployment, publishing, payment, external inference, or account login/logout
was performed in this installation phase.

## Installed components

| Component | Installed location / entry point | Evidence |
| --- | --- | --- |
| CLI | C:\Users\Admin\AppData\Roaming\npm\node_modules\@learnsmart\subi-cli; run `subi` from a project folder | Both the npm command shim and normal PowerShell command print `subi v2.0.0-dev.16`; native executable SHA256 matches the qualified build |
| VS Code | C:\Users\Admin\.vscode\extensions\learnsmart.subicode-2.0.0; Command Palette → Open Subi Code | VS Code lists learnsmart.subicode@2.0.0; its bundled native executable matches the qualified CLI |
| Desktop | C:\Users\Admin\AppData\Local\Programs\subicode-desktop\Subi Code Dev.exe | Per-user NSIS install exit 0; registry version 2.0.0-dev.16; Start menu and desktop shortcuts target this executable; installed executable, app.asar and bundled CLI match the corrected package |

Reload the VS Code window if its new commands have not appeared. Existing legacy
learnsmart.subi@0.1.0 and sst-dev.opencode@1.0.0 extensions were retained. The
separate OpenCode desktop application was also retained.

The previous global CLI package (version 0.1.0) and its npm shims were backed up
before the global npm update, under:
C:\Users\Admin\AppData\Local\Temp\subi2-20261018\install-cli-backup.
Normal account/session storage was not removed or reset.

## Reproduced desktop defect and fix

The first installed desktop displayed a black window. Its main process emitted
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING when a lazy desktop import reached
@opencode/util/src/product.ts inside app.asar/node_modules. The branding utility
was externalized even though that workspace package exports TypeScript source.
Bun tests and renderer builds alone did not expose Electron's runtime restriction.

Small production fix: packages/desktop/electron.vite.config.ts now includes
@opencode/util in main.build.externalizeDeps.exclude. Electron receives compiled
JavaScript in the bundle. No public API, schema, account policy or new dependency
was introduced.

Extended the existing electron.vite.config.test.ts contract: preserve the exact
Effect/Drizzle/native-package checks, require workspace utilities to be bundled,
and assert the real output includes the product module with no external util
imports. The initial suite after the production fix was 134 pass / 1 fail because
its exact expected bundling list still described the previous configuration.
The updated expectation adds the required utility; no existing assertion was
deleted or weakened.

## Actual native regression evidence

The same external native startup fixture was run against the original packaged
binary and corrected binary. It launches Electron with a disposable profile,
fresh config, private service port, model fetching disabled, and provider
credentials removed from the child environment. It uses CDP to require a visible
production composer, absence of the startup overlay, the Subi Code title, and
zero captured renderer errors. It saves logs, DOM text and a screenshot.

| Native execution | Observed result |
| --- | --- |
| Original desktop-dev16 packaged build | FAIL: composer never appears, body remains empty, main log reproduces the TypeScript module error |
| Corrected desktop-dev16-startup-fix unpacked executable | PASS: production home screen, composer and model selector, no captured renderer errors |
| Corrected installed executable | PASS: production home screen and local service ready; startup fixture measured 4,808 ms; no captured renderer errors |

An earlier disposable run used the normal default service port and correctly
reported a port collision. The fixture was corrected to use its own service
configuration and private port. This was fixture interference, not evidence of
another production repair. No normal service was stopped for that test.

Native test helper, raw logs, screenshots, installation metadata and backups:
C:\Users\Admin\AppData\Local\Temp\subi2-20261018.
Important entries: install-native-smoke.mjs, install-desktop-baseline-regression,
install-desktop-unpacked-private, install-desktop-installed-fixed,
install-desktop-fixed-hashes.json, install-desktop-fixed-exit.json,
install-desktop-tests-final.log, install-desktop-regression10.log.
Owned temporary desktop processes and their staged service processes were closed
after inspection. No prompt, provider authentication, checkout or payment was run.

This proves native Windows desktop startup with a fresh profile. It does not
qualify live managed inference, every desktop feature, existing-profile recovery,
VS Code extension-host activation, Linux or macOS. The broader release verdict
and outstanding fixtures in the branding handoff remain unchanged.

## Commands and checks

Toolchain: Bun 1.4.2, Node 22.19.0, Electron 44.4.5, electron-builder 26.15.7.
Bun is available at
C:\Users\Admin\AppData\Local\Temp\subi-opencode-migration-20261017-1204\toolchain\bun-windows-x64-baseline\bun.exe.

Extension installation:

```powershell
& 'C:\Users\Admin\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --install-extension 'D:\LearnSmart\Subi 2.0\artifacts\2026-10-18\subicode-2.0.0-win32-x64-dev16.vsix' --force
& 'C:\Users\Admin\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' --list-extensions --show-versions
```

The local CLI installation package reuses the existing production Node launcher's
signal/stdio forwarding and carries the qualified native Windows binary and MIT
license. It has no npm dependencies or install scripts. Pack/install commands:

```powershell
npm pack 'C:\Users\Admin\AppData\Local\Temp\subi2-20261018\install-cli-package' --pack-destination 'D:\LearnSmart\Subi 2.0\artifacts\2026-10-18' --ignore-scripts --offline --json
npm install --global 'D:\LearnSmart\Subi 2.0\artifacts\2026-10-18\learnsmart-subi-cli-2.0.0-dev.16.tgz' --offline --ignore-scripts --no-audit --no-fund
subi --version
```

From packages/desktop, set OPENCODE_CHANNEL=dev, OPENCODE_VERSION=2.0.0-dev.16,
OPENCODE_CLI_DIST=D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-branding-final-20261018.
Sentry upload variables were removed from the build child environment.

```powershell
bun run build
bun x --no-install electron-builder --config electron-builder.config.ts --win nsis --x64 --publish never '--config.directories.output=D:\LearnSmart\Subi 2.0\artifacts\2026-10-18\desktop-dev16-startup-fix' --config.extraMetadata.version=2.0.0-dev.16 --config.extraMetadata.name=subicode-desktop
Start-Process -FilePath 'D:\LearnSmart\Subi 2.0\artifacts\2026-10-18\desktop-dev16-startup-fix\subi-desktop-win-x64.exe' -ArgumentList @('/S','/currentuser') -WindowStyle Hidden -PassThru
```

The output path was verified under the task artifact directory before packaging.
Original desktop-dev16 artifacts remain saved for regression evidence; use the
desktop-dev16-startup-fix installer. Local signing is skipped by the project's
signWindows hook outside GitHub Actions; this is not a signed release claim.
Corrected installer completed in 16.15 seconds with exit code 0.

Checks executed:

- Root `bun run check`: 36/36 tasks successful, 35 cached, 26.626 seconds;
  after the test update, final repeat also passed 36/36 in 20.785 seconds.
- Desktop `bun run build`: main, preload and renderer pass with the supplied CLI.
- Desktop `bun test --timeout 30000`: 135 pass, 0 fail, 688 assertions, 33 files,
  24.99 seconds, in the existing isolated environment helper.
- Desktop `bun test electron.vite.config.test.ts --timeout 30000 --rerun-each 10`:
  20 pass, 0 fail, 470 assertions, 14.72 seconds. It ran concurrently with the
  configured desktop suite.
- Actual installed CLI version and installed extension/native hashes verified.
- Actual installed desktop startup and unpacked/installed file hashes verified.
- `git -c core.autocrlf=false diff --no-index --check` against the two saved
  source/test baselines: no whitespace errors. All four changed source/document
  files were checked for NUL, trailing whitespace and final newline, then copied
  with SHA256 records to install-final-source and install-source-checkpoint.json
  under the external log directory. This copy has no Git metadata to commit.

The first prebuild attempt correctly rejected a missing OPENCODE_CLI_DIST; the
second rejected a package-level path instead of the required distribution parent.
Both were invocation errors. The successful build uses the parent path above.

## Artifacts and SHA256

| Artifact | SHA256 |
| --- | --- |
| Qualified CLI, global CLI, VSIX bundled CLI and desktop bundled CLI | FBBA34E8359B106B53F1DD09716A452B1CFE37CF72525B4DFAA6DD62A972AC82 |
| artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev16.vsix | 8ECD00FA2FF98AB9EC9F4AA80657730A3DE15264996972DAE7CC8C2CD9DEA082 |
| artifacts/2026-10-18/learnsmart-subi-cli-2.0.0-dev.16.tgz | 9397FEB8DE518B216E9B3BE268662412A03C39A07541CB475B74DA82EF05E785 |
| artifacts/2026-10-18/desktop-dev16-startup-fix/subi-desktop-win-x64.exe | 01806BF7F72130B3713C0626DFCFD807A93F922FDD027B6693CF4D3498F00BAF |
| Installed Subi Code Dev.exe | 9EA775BF406065EF9CBECFE387BD754C3B22F2EB33868005802BCF61D4FC4051 |
| Installed resources/app.asar | 987F61D5AEDD0AE9F7583ED8447ED9E4A09EEE1182AAE8ED2D2E5CF43DDBBEAC |

## Source changes in this installation phase

- packages/desktop/electron.vite.config.ts: compile TypeScript workspace utilities.
- packages/desktop/electron.vite.config.test.ts: preserve and extend actual bundling coverage.
- docs/subi-installation-2026-10-18.md: this installation record.
- docs/subi-resume-2026-10-18.md: append current installation/repair status.

Generated build/install artifacts live under the existing task artifact directories;
bulky execution output remains outside the repository. No original OpenCode or old
Subi reference source was edited.
