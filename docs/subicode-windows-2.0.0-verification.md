# SubiCode 2.0.0 — Windows installation verification

Verified on Windows x64, 20 October 2026. This records local package qualification and installation; it does not declare an all-platform public release.

## Installed products

- CLI reports `subi v2.0.0`.
- VS Code reports `learnsmart.subicode@2.0.0`.
- Installed desktop executable reports file version `2.0.0`; its window title and shortcut are `SubiCode`.
- The installed desktop logs confirm its background service is ready, with no matching startup IPC/server errors. The CLI discovers the same service at `http://127.0.0.1:46513`.
- Installed CLI, extension-bundled CLI and desktop-bundled CLI have the same SHA-256: `d4bfdb25a85a5482a975ae32acad4b9858ad00cb6ffd88bfc9bb4d382e1561e1`.
- The previous desktop profile was backed up locally and copied to the production desktop profile before installation. The old development desktop was uninstalled; its saved profile backup was retained.

## Checks completed

| Check | Result |
| --- | --- |
| Canonical lint/type check | 36 successful tasks; repeated after the service fix |
| App E2E TypeScript | Passed |
| App unit tests | 762 passed, 0 failed |
| Native packaging contracts | 11 passed, 0 failed |
| CLI service suite | 25 passed, 0 failed |
| Extension compilation, type check and test compilation | Passed; existing semicolon warnings remain |
| Sanitized provider recording replay | 1 passed, 0 failed |
| Staged and imported commit secret scans | Passed after reviewing false positives and redacting signed fixture URLs |
| Desktop native qualification | Startup, Build/Plan, all twelve settings sections, MCP form, local plugin/skill setup and removal passed |
| Extension native qualification | VSIX installation, bundled executable startup and terminal reuse passed |
| Visible branding qualification | No OpenCode text in the twelve settings sections or extension setup forms checked |

## Problems caught before desktop installation

The clean import initially omitted the root `install` script required by the desktop bundle. It was restored unchanged and the desktop build passed.

The production CLI channel initially selected `service-prod.json`, while the desktop used `service.json`. That mismatch caused isolated desktop startup to collide with an existing service port. Existing service tests were extended to cover production: three checks failed before the fix; the complete 25-test service suite passed after the fix. Production now shares the canonical release registration and port.

The CLI was rebuilt from the corrected source using the unchanged production web archive. All packaged CLI copies were checked for identical hashes, the Windows installer was recreated, and complete native qualification passed before installation.

An initial extension qualification attempt used an outdated installed VS Code CLI path. Rerunning against the installed version's actual CLI path passed.

## Evidence and limits

Local logs are under `artifacts/verification/2026-10-20/release-2.0.0/`; package qualification is under `artifacts/platforms/2.0.0/win32-x64/packages/qualification.json`. These generated files, personal profiles and installers are excluded from Git.

The Windows installer is unsigned. Native Windows ARM64, macOS and Linux CI is pending. Live provider access, LearnSmart billing and real-phone pairing have not been newly production-qualified by these checks. No stable release tag, registry publication or public download asset is implied by merging this source.
