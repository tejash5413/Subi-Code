# SubiCode release readiness — 20 October 2026

**Verdict: NO-GO for an all-platform public release.** Windows development builds have useful qualification evidence, but the latest source, signed release artifacts, native platform qualification and public distribution are not all aligned.

This audit did not publish packages, change accounts, enable remote access, replace installed applications or restart the user's services. The LearnSmart website production build was not restarted.

## Platform status

| Target | Evidence available | Release status |
| --- | --- | --- |
| Windows x64 CLI | Installed version command confirms `2.0.0-dev.37`; prior deterministic read/edit/test workflow passed | Latest source needs a new qualified release package |
| Windows x64 desktop | dev.37 installer and installed qualification cover startup, Build/Plan, twelve Settings pages and extension setup; prior coding workflow passed | Installed build predates the latest documentation links; installer is unsigned |
| Windows x64 VS Code extension | Installed `learnsmart.subicode` 2.0.6 previously completed the native terminal coding workflow; source compiles now | Installed manifest lacks the new documentation command; rebuild/package/version/update required |
| Windows ARM64 | Distribution staging contract exists and passes with fixtures | Native artifact and runtime qualification not found |
| Linux x64 / ARM64 | Native build/qualification jobs exist in the six-target workflow; staging contracts pass | No native release artifacts or successful native job results available in this checkout |
| macOS Intel / Apple silicon | Native build/qualification jobs and app configuration exist | No native runtime, signing or notarization results available in this checkout |
| Phone browser pairing | Link parsing, one-time exchange/web-shell behavior and tunnel-address selection have code/test coverage | Actual phone, camera permissions, tunnel connectivity and reconnect behavior are not qualified |

Fixture-based distribution tests executed on Windows do **not** establish that a Linux/macOS binary runs. Earlier Windows coding tests used a deterministic local model: they establish tool wiring, not live provider eligibility, billing or model quality.

## Fresh checks

| Check | Result |
| --- | --- |
| Repository `bun run check` before test corrections | Passed; 36/36 cached type-check tasks; lint warnings remain |
| Final repository `bun run check` | Passed; 36/36 tasks successful, 29 cached and 7 executed; lint warnings remain |
| App E2E TypeScript | Passed |
| App performance unit suite | 52 passed |
| Complete app `test:unit` | 762 passed, 0 failed |
| Desktop staging, distribution identities, Windows installer ACL and IPC transport | 15 passed |
| Desktop service/storage/windows/deep-link/external URL tests | 57 passed |
| Core MCP OAuth, plugin failure handling and skill registration | 31 passed after correcting stale expectations |
| CLI MCP command/auth/configuration tests | 4 passed with `--timeout 60000` |
| CLI web shell, authenticated pairing exchange and compressed assets | 3 passed in the initial mixed invocation |
| GUI extension branding, remote discovery and pairing tunnel-address tests | 7 passed |
| VS Code type check, lint, bundle and test compilation | Passed; 43 semicolon warnings, no errors |

The initial CLI MCP invocation had three 5-second startup timeouts and associated child termination errors. A subsequent 60-second-timeout run passed all four MCP tests; this is not evidence of a functional MCP failure. The app unit log includes the deliberately simulated persistence `disk full` errors and local connection-reset messages; its final exit code is 0. Browser UI automation was unavailable under current Work settings, so no new visual/E2E/native desktop inspection is claimed in this audit. This is not a run of every test in the monorepo.

## Corrections made during the audit

Fresh tests exposed stale expectations after the previously approved branding and product-URL changes. Production behavior was retained; three test files were corrected:

- `packages/core/test/mcp-oauth.test.ts`: expect OAuth client URI `https://stlearnsmart.in/subi-code`.
- `packages/core/test/plugin/skill.test.ts`: expect the built-in skill display name `SubiCode`.
- `packages/app/src/runtime/i18n/desktop-native.test.ts`: expect native menu branding `SubiCode`, preserving protocol tokens/placeholders.

The failures were reproduced before these corrections, and the affected suites passed afterwards.

## Remaining release work

1. Select an explicit release candidate version/channel and build CLI, desktop and per-target VSIX packages from the same final source. The latest local artifacts are dev.37 Windows x64 packages from 19 October, while later source changes are not installed.
2. Execute `.github/workflows/subicode-platforms.yml` on its six native targets and retain successful qualification artifacts. Its current configuration produces development, unsigned, unpublished qualification builds; it is not a signed production publishing workflow. `distribute.ts` explicitly disables macOS notarization for those qualification runs.
3. Produce and verify Windows signatures and macOS signing/notarization for the public installers. The existing Windows dev.37 installer reports `NotSigned`.
4. Verify the Marketplace/Open VSX publishing path uses the intended platform packages. The legacy `sdks/vscode/script/publish` packages the source SDK directly without a target and does not invoke staged native distribution. The source SDK's `bin` currently contains only `win32-x64`; staged per-target packaging and marketplace publication need to be reconciled before claiming a bundled CLI on every platform.
5. Test actual clean installation, upgrade with saved data, launch/reconnect and removal of the final candidate on supported platforms; existing source/fixture tests are not substitutes for final installer qualification.
6. Verify real LearnSmart sign-in, permitted model discovery/inference, credits/account state and MCP OAuth with release builds. No paid transaction was performed. OpenCode-only hosted free tiers must not be advertised as working in SubiCode without provider authorization.
7. Complete phone-browser pairing and network/reconnect checks on actual mobile devices. The earlier explanation described implemented behavior, not a verified phone session.
8. Publish the verified download/install destinations and the latest website/docs content. `D:/LearnSmart/learnsmart/src/pages/HomeSubiCode.js` still has null entries for CLI install commands, desktop downloads and VS Code download destinations.
9. Establish a supported update process. `Product.upstreamUpdates` remains false and desktop production `publish` is null; automatic SubiCode updates are not currently a verified delivery feature. A documented manual-update process is an alternative to an automatic feed.

## Evidence

Fresh logs are under `artifacts/verification/2026-10-20/release-audit/`. Earlier installed-package evidence is in `artifacts/platforms/2.0.0-dev.37/win32-x64/` and `artifacts/verification/2026-10-20/{cli,desktop,extension}-result.json`. The earlier detailed workflow scope is documented in `docs/subi-workflow-verification-2026-10-20.md`.

## Public version label requested after the audit

The normal About version, Settings header version and CLI home footer now use a centralized public `Product.version` of **2.0.0**. Runtime build identifiers remain unchanged in diagnostics, compatibility and update logic. This is a source presentation change, not a declaration that the release gates above have passed. Installed applications were not rebuilt or replaced. The existing About E2E keeper now asserts `Version 2.0.0` and the `2.0.0` badge; its TypeScript check passes, but browser execution is unavailable in current Work settings. Final `bun run check` for this presentation change passed: **36/36 tasks successful**, all executed without cache hits. The log is `artifacts/verification/2026-10-20/release-audit/public-version-check.log`.
