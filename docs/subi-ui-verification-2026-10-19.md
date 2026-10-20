# SubiCode UI verification and dev.37 update

Scope: first-party branding, light/dark layouts, Settings and session setup forms, Recent tasks navigation, CLI/extension presentation, and native packaging preparation. Existing account, model, session and compatibility behavior is retained.

## Findings and fixes

- Plugin/skill setup fields used the controls' fixed 280px default width. At 320px viewport width they extended beyond their label rows and were clipped. MCP setup had the same problem, including advanced OAuth fields and its long authentication selector. The existing Settings keeper cases reproduced these failures before the fix. Fields now fill the available row; the authentication selector can shrink. Existing save, validation, edit and removal behavior is unchanged. These are shared forms used by desktop/browser and selected-server session details.
- VS Code toolbar and terminal icons referenced the same opaque dark square PNG in both themes. They now use the existing transparent ribbon through distinct light/dark SVG resources, with the same darkening treatment used by the application in light mode. The asset generation script retains these variants. The extension manifest is 2.0.6.
- Browser pairing-link expiry and service-startup recovery responses still suggested upstream commands. They now suggest `subi pair` and `subi service restart`. The compiled API-viewer fallback also displays SubiCode. Authentication, cookies, protocols and error status codes are unchanged.
- The native six-platform workflow defaults to 2.0.0-dev.37. Windows x64/ARM64, Linux x64/ARM64 and macOS x64/ARM64 staging contracts passed. This is source/packaging validation, not native execution of all six targets.

## Branding audit

The real presentation adapter processed 759 catalogs: application 54,655 messages, shared UI 16,074, GUI extensions 17,789. There were zero case-insensitive `opencode` substring matches in the resulting 88,518 first-party messages. Thirteen installed CLI help pages also had zero matches and exited successfully. VS Code command labels and product metadata use SubiCode/Subi Code.

Internal imports, protocols, saved configuration filenames, compatibility identifiers and legal notices retain their real identities. User content, file paths, external provider replies and third-party plugin identities are not rewritten. This audit is not a promise that arbitrary external content never contains an upstream name.

## Checks

- Root `bun run check`: 36 successful tasks; existing lint warnings remain.
- Browser keepers: nine passed covering the narrow setup forms, light/dark variants, existing MCP operations, Settings navigation/layout, new-session background, Home search shortcut and local/remote session setup. The three modified form cases passed again after correcting their fixture typing.
- Product copy tests: seven passed. CLI Settings/crash branding: five passed on confirmation with a 20s test timeout; the initial cold Settings fixture exceeded its original 5s timeout under parallel work. No production change was made for that timeout.
- Server process/status tests: six passed, 146 assertions, including browser/API pairing expiry and cookie/token authentication.
- Packaging contracts: eleven passed, covering six targets and desktop channel identity/update isolation. Extension test host compiled.
- The actual SVG resources rendered in Chromium on white and dark surfaces; the resulting preview was visually inspected.
- Shared startup component checks passed twelve combinations: Windows/macOS/Linux layout, light/dark mode, and wide/narrow viewport. Centered ribbon/title, Keania One loading, theme contrast and absence of renderer errors were verified. Wide light and narrow dark screenshots were visually inspected. These are shared-component browser checks on Windows, not native Linux/macOS execution.
- Supplemental E2E-wide typecheck still reports four existing errors outside the changed Settings keeper: `e2e/performance/terminals/probe.ts:61`, `e2e/performance/timeline/session-timeline-stream-probe.ts:148`, and `e2e/regression/timeline-stream.spec.ts:1822,1825`. The plugin fixture's incompatible client/server option typing was corrected; it has no remaining diagnostics. The canonical production lint/type check passes.

Local logs and icon preview: `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev36/`. A temporary Chrome-based Playwright config is outside the repository; the pinned browser/ffmpeg are unavailable on this host. Tests use disposable fixture servers/profiles and do not submit inference or account changes.

## Platform limits

macOS/Linux use the same application/forms and extension source. Their native installers and runtime checks still require their own hosts or the configured native CI workflow. This Windows x64 checkout has no Git metadata or connected CI run, WSL or macOS host. No all-platform release, signing, notarization or publication is claimed.

The initial dev.36 candidate was superseded during the expanded server recovery-copy audit and was not installed.

## Final Windows installation

Windows CLI/desktop **2.0.0-dev.37** and VS Code extension **2.0.6** are built, qualified and installed. The desktop installer exited 0. `subi --version` reports dev.37; VS Code lists `learnsmart.subicode@2.0.6`.

Packaged qualification passed desktop startup, Build/Plan, all twelve Settings pages, MCP setup, real local plugin/skill activation and removal, and native extension startup with terminal reuse. It also fetched the bundled server's expired-pairing page and verified the `subi pair` recovery instruction. Its disposable apps and managed service were closed after verification.

Normal installed-profile checks passed both setup forms in Settings/session details, their new full-width fields, all twelve Settings pages, account/credit access and reopening Recent tasks. **15 saved tasks**, the `nightowl` theme and dark mode were preserved. There were no renderer errors. Forms were cancelled without changing the user's sources. Installed form screenshots were visually inspected.

Installed global CLI, extension CLI and desktop sidecar match the tested SHA256 `77BCA0080B9E29BB8C5A5C0AD1C43CDF2769DC2DC5CC4ABD8D52CC160B347B87`. Installed desktop archive matches the package SHA256 `144B3FC8556B90D8E8E949A161CF9A0ECF5AC6420E4FEE50A260C98EA0E74948`. Installed light/dark extension SVGs match their source resources.

Final artifacts: `artifacts/platforms/2.0.0-dev.37/win32-x64/`, including `packages/qualification.json` and `installed-qualification.json`. Catalog/help audits are in sibling `branding/`; visual checks are in sibling `visuals/`. Final build, install and normal-profile logs are under `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev37/`; initial source/UI checks are under the adjacent `platform-dev36/`.

To use: launch a new `subi` terminal, reload VS Code for extension 2.0.6, or use the updated SubiCode desktop. Settings → Extensions exposes Add MCP connection, Add plugin and Add skill. Existing CLI setup shortcuts remain `/plugins` then Ctrl+O, `/skills` then Ctrl+A.

20 October follow-up: the four supplemental E2E typing errors noted above are resolved, and installed Windows CLI/extension/desktop coding workflows passed. See [the workflow verification report](subi-workflow-verification-2026-10-20.md) for current results and platform limits.
