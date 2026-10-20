# Subi Code 2.0 presentation and packaging — 2026-10-18

## Result and scope

First-party Subi Code presentation is adapted in the development copy at
D:\LearnSmart\Subi 2.0. The product name, supplied blue/purple mark, theme labels,
menus, About screen, help destinations, local authentication pages and distribution
metadata belong to Subi Code. The OpenCode implementation remains the compatible
engine underneath. This is a bounded branding qualification, not completion of the
earlier independent architecture/release audit. Overall release verdict remains
**NOT READY** for an unrestricted, all-platform release.

The original source/reference tree is read-only. Existing LearnSmart school and
individual accounts, assigned model IDs, BYOK, quotas, credits, permissions,
protocols and stored configuration are preserved. No account, provider, payment,
deployment, publishing or normal-profile installation was performed.

## Implementation and evidence

| Surface/boundary                          | Change and production evidence                                                                                                                                                                                                                            | Qualification                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared identity                           | packages/util/src/product.ts owns Subi Code name, command, directory and first-party destinations. brandMessages changes authored templates before parameters are interpolated.                                                                           | Product regression; English/French production component preview; workspace checks.                                                                                                                     |
| App and native menu translations          | packages/app/src/runtime/i18n/language.tsx and desktop-native.ts adapt values, preserving translation keys and bounded IPC validation.                                                                                                                    | 762 app unit tests and 176 browser-condition tests; real Chrome preview receives Subi Code native menu bundles.                                                                                        |
| Shipping built-in GUI features            | All 13 feature definitions call the local packages/gui-extensions/src/branding.ts catalog adapter, including lazy locales. Third-party extension catalogs are not rewritten.                                                                              | Reproduced untranslated WSL/SSH/updater copy first; current English/French regressions pass. 25 actual-browser extension host/graph tests pass with host ports supplied by fixtures.                   |
| Appearance                                | The built-in GUI theme name is Subi Code; saved oc-2/opencode/opencode2 IDs remain compatible. Invalid stored color schemes fall back to system.                                                                                                          | UI tests, native terminal Settings, and Chrome using an invalid saved appearance value.                                                                                                                |
| First-party About, navigation and artwork | Shared wordmark uses the supplied mark. About describes LearnSmart/Subi Code, links to LearnSmart, retains third-party notices and removes the upstream contributor fetch. Titlebar, support, error-report and server-pairing destinations/copy use Subi. | Chrome production About/translation/theme components in English and French; app suite; web/desktop builds.                                                                                             |
| Integrations/models                       | Normal integration listings filter legacy OpenCode Console/Go entries; the core already excludes those upstream integrations. Available-free-model copy and connection descriptions do not advertise Go or Zen.                                           | Existing app/core provider authority is retained. No identity spoofing or upstream free-tier bypass. No live inference qualification in this pass.                                                     |
| Tools and skills                          | Web-search provider display maps the compatible internal opencode ID to Subi Code. Built-in skill display/report identity is Subi; original skill IDs and technical configuration names remain stable.                                                    | TUI regression and two core skill tests; shared session UI suite.                                                                                                                                      |
| Native CLI                                | Help/error examples, ACP client identity, stats, terminal title and theme label use Subi. Commands are subi; existing internal namespaces remain compatible.                                                                                              | Fresh compiled Windows x64 CLI; actual ConPTY Settings, Ctrl+P and signed-out /account smoke; zero generation/payment calls.                                                                           |
| Local installer                           | Root install and desktop local installer use .subi-code/bin/subi. A missing Subi download feed fails without downloading upstream software. No opencode2 shim is created.                                                                                 | Real Git Bash temporary-home installer regression, preserving a separate upstream command.                                                                                                             |
| Remote setup                              | SSH discovers subi and reads Subi service state. Automatic upstream archive/version downloads are disabled. WSL stages only the supplied binary and checks its version before replacing the Subi executable.                                              | Reproduced upstream-discovery issue first; real shell fixture proves independent old install is ignored/preserved and a wrong-version replacement is rejected. Native WSL/SSH hosts are not qualified. |
| Updates/release notes                     | Upstream updater remains disabled. The GUI no longer fetches upstream release highlights for Subi builds.                                                                                                                                                 | Updater regressions, extension graph and packaging. Do not enable the flag without implementing an actual Subi release feed.                                                                           |
| Distribution metadata                     | VS Code homepage/support, Linux metadata and retained launcher use Subi identity. Supplied icons remain configured for desktop platform targets. Original MIT text is retained with distributions.                                                        | CLI and VSIX built; VSIX and desktop embedded CLI hashes match. Desktop main/preload/renderer and web builds pass. No signed installer or store release.                                               |

The catalog adapter is a local build adaptation, not a new extension SDK API.
No RPC/schema, dependency or provider credential format changed. Technical paths,
SDK package names, persisted keys and wire markers remain where required.

## Defects, assertions and checks

1. The first native-menu branding regression failed before the fix; it now proves
   Subi copy while preserving template parameters and OPENCODE/config identifiers.
2. The first shipping-feature regression failed for all three audited catalogs.
   Their independent catalog loading path was not covered by app dictionary changes.
   All built-in definitions now use the catalog adapter.
3. Remote discovery selected an unrelated .opencode/bin/opencode installation in
   a real temporary shell fixture. Discovery now selects Subi only. WSL promotes
   the supplied binary only after the requested version succeeds.
4. Native installer ownership and unconfigured-feed behavior are tested without
   network access. Old upstream PATH cleanup was corrected to own Subi's path only.
5. Initial checks found an unused icon import, a NodeNext test import without .js,
   catalog return-type inference, and readonly log-context typing. They were fixed.
   Strict changed-GUI lint also required cleaning touched files; bounded native
   translation parsing remains intact, with explicit boundary justifications.
6. Two terminal tests initially picked up the calling editor's inherited SSE
   context; unchanged assertions pass with that context removed in child-only
   disposable environments. Initial simultaneous runs also hit one askpass timeout.
   The isolated configured CLI suite passes.
7. Old CLI mini/stats and Linux launcher expectations described the upstream
   brand. Assertions now require the requested Subi names while preserving their
   original behavior/hidden-launcher checks.
8. The external component harness initially loaded a temporary config as CommonJS.
   Its final .mts configuration uses the repository config, installed Chrome,
   one worker, a fresh owned server and external output directories. This is
   a qualification harness adjustment, not an app architecture change.

Current configured runs, excluding duplicate focused rechecks:

| Command (from package unless noted)                                                                          | Observed result                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| root: bun run check                                                                                          | 36/36 workspace tasks pass; lint and typecheck                                                                     |
| app: bun run test                                                                                            | 762 unit + 176 browser-condition pass; 0 fail                                                                      |
| tui: bun run test                                                                                            | 1,500 pass; 12 skip; 0 fail; 1,512 cases / 179 files                                                               |
| cli: bun run test                                                                                            | 309 pass; 8 skip; 0 fail; 1,171 assertions; 317 cases / 52 files                                                   |
| desktop: bun run test                                                                                        | 135 pass; 0 fail; 686 assertions / 33 files                                                                        |
| gui-extensions: bun run test                                                                                 | 178 pass; 1 skip; 0 fail; 538 assertions / 33 files                                                                |
| ui: bun run test                                                                                             | 152 pass; 0 fail; 212 assertions / 8 files                                                                         |
| session-ui: bun run test                                                                                     | 251 pass; 0 fail; 666 assertions / 20 files                                                                        |
| util: bun test src/product.test.ts                                                                           | 1 pass; 0 fail; 3 assertions                                                                                       |
| core: bun run script/test.ts test/plugin/skill.test.ts                                                       | 2 pass; 0 fail; 5 assertions                                                                                       |
| cli: bun test src/services/updater.test.ts test/upgrade.test.ts test/updater-install.test.ts --timeout 30000 | Follow-up copy check: 32 pass; 0 fail; 143 assertions                                                              |
| app: bun x --no-install playwright test --config external/branding-components.config.mts extension-          | 25 pass, including real window-host graph/lifetime/optional-provider fixtures; 1.9 minutes                         |
| External Chrome production component preview                                                                 | English and French menu, theme and About identity; LearnSmart links; invalid appearance fallback; 0 browser errors |
| External Node ConPTY smoke against fresh subi.exe --standalone                                               | Tab title Subi Code; Settings Subi Code; Ctrl+P Commands; signed-out LearnSmart /account                           |

Child-only test environments use the existing CLI isolatedEnv helper and remove
CLAUDE_CODE_SSE_PORT and OPENCODE_EDITOR_SSE_PORT. No normal editor/account state
is copied or modified. The skipped GUI test needs a native WSL distro; skips
are not PASS. Browser-condition Bun tests are distinguished above from actual
Chrome tests and native Windows execution.

## Builds and artifacts

Build version: **2.0.0-dev.16**. Bun 1.4.2 Windows x64 baseline toolchain, Node from
C:\nvm4w\nodejs, installed Google Chrome. Toolchain prefix used for Bun commands:
C:\Users\Admin\AppData\Local\Temp\subi-opencode-migration-20261017-1204\toolchain\bun-windows-x64-baseline.

Exact CLI build, from packages/cli, with OPENCODE_CHANNEL=dev and
OPENCODE_VERSION=2.0.0-dev.16:

    bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-branding-final-20261018

CLI output:

    packages/cli/dist/subi-branding-final-20261018/cli-windows-x64-baseline/bin/subi.exe

VSIX packaging from sdks/vscode, using the existing read-only vsce tool:

    & "C:\nvm4w\nodejs\node.exe" "D:\LearnSmart\Subi\node_modules\@vscode\vsce\vsce" package --no-dependencies --target win32-x64 --out "D:\LearnSmart\Subi 2.0\artifacts\2026-10-18\subicode-2.0.0-win32-x64-dev16.vsix"

Paths containing spaces were quoted in the executed PowerShell command.
The CLI is copied to sdks/vscode/bin/win32-x64/subi.exe before packaging.
The original MIT license is included; there is no invented Subi source repository.
The existing 42 extension lint warnings remain zero-error warnings.

Desktop: OPENCODE_CLI_DIST points to the fresh CLI dist root; bun run build stages
that CLI and supplied icons, generates Linux metadata, and builds Electron main,
preload and renderer. Web: bun run build from packages/app. Sentry credentials
are removed only in these child build environments. CLI deliberately uses
--skip-web-ui; the web and Electron renderers are separate built outputs.

Artifact SHA-256 values are recorded in the external branding-artifacts.json and
the final handoff below after packaging. The development artifacts are unsigned.

## Limits and deliberately retained compatibility

- Third-party hosted OAuth consent pages use the provider's registered application
  name. The user has not registered Subi OAuth applications yet. Those pages may
  still say OpenCode. Local Subi-owned callback/sign-in pages and icons are
  branded; genuine client IDs are preserved.
- Legal notices and source attribution retain original names. They are not
  first-party product advertising. User text, provider text, model names and
  third-party extension content are not globally sanitized.
- Internal @opencode packages, namespaces, schemas, .opencode/opencode.json
  technical paths, fixed skill/provider IDs and wire markers remain compatible.
- The cloned upstream service/marketing sources are not deployed as the Subi
  product. No claim is made that every textual source occurrence was deleted.
- No paid model call, purchase, renewal, backend deployment, normal-profile
  extension installation, native macOS/Linux app execution or live remote
  WSL/SSH qualification was performed in this pass.
- The previously observed individual-model loading latency and the earlier
  coding failure/repair, restart and duplicate-promotion release fixtures remain
  separate outstanding work. This branding pass does not resolve them.

## Saved evidence

Bulky logs, fixtures, native terminal captures, browser screenshots, hashes,
source comparison and changed-file lint JSON are outside the repository:

    C:\Users\Admin\AppData\Local\Temp\subi2-20261018\branding-*

The source comparison checks the original 8,559-file manifest. It reports zero
reference-tree changes and zero diff whitespace errors. A targeted file manifest
records this pass separately from older dirty migration/billing work. New text
assets are checked for NUL/whitespace, and copied legal files match the original.

## Final dev.16 handoff

- CLI: packages/cli/dist/subi-branding-final-20261018/cli-windows-x64-baseline/bin/subi.exe
- CLI SHA-256: FBBA34E8359B106B53F1DD09716A452B1CFE37CF72525B4DFAA6DD62A972AC82
- VSIX: artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev16.vsix
- VSIX SHA-256: 8ECD00FA2FF98AB9EC9F4AA80657730A3DE15264996972DAE7CC8C2CD9DEA082
- Embedded VSIX and desktop CLI SHA-256 match the standalone CLI.
- Original MIT text SHA-256: 625F0F619133F89BBBB2ABE37369613DFA1885EBA1E50D02170DEB62BB42CB6B.
  VSIX LICENSE.txt, source SDK license, desktop resource, web public/dist and CLI
  distribution copies match exactly. The CLI build script now carries it forward.
  License text is a deliberate attribution exception to product-name replacement.
- Final root check after source/packaging corrections: 36/36 tasks, 32 cached,
  28.66 seconds. Strict changed-GUI lint: 0 diagnostics in 50 files.
- Actual Chrome extension-host graph/lifetime fixture: 25/25 pass. The owned
  Storybook server was closed; normal app/editor/account profiles were untouched.
- Web was rebuilt after adding its distributed license. No signed installer or
  live-provider inference was produced by this work.

## Targeted source/document manifest

The following 84 source/document paths were touched or verified as part of
this pass. Generated build outputs and earlier migration changes are separate.

- docs/subi-branding-2026-10-18.md
- docs/subi-execution-2026-10-18.md
- docs/subi-migration.md
- docs/subi-resume-2026-10-18.md
- install
- packages/app/public/LICENSE.txt
- packages/app/src/composer/commands.tsx
- packages/app/src/home/projects/controller.tsx
- packages/app/src/providers/catalog/integrations.ts
- packages/app/src/providers/credentials/dialog.tsx
- packages/app/src/providers/models/unpaid.tsx
- packages/app/src/providers/opencode-logo.tsx
- packages/app/src/runtime/i18n/desktop-native.test.ts
- packages/app/src/runtime/i18n/desktop-native.ts
- packages/app/src/runtime/i18n/en.ts
- packages/app/src/runtime/i18n/language.tsx
- packages/app/src/runtime/platform/web.ts
- packages/app/src/servers/connect/screen.tsx
- packages/app/src/settings/about/about.tsx
- packages/app/src/settings/appearance/appearance.tsx
- packages/app/src/settings/providers/extensions.tsx
- packages/app/src/settings/workspaces/project-extensions.tsx
- packages/app/src/shell/commands/desktop-menu.ts
- packages/app/src/shell/errors/error.tsx
- packages/app/src/shell/titlebar/titlebar.tsx
- packages/app/src/shell/titlebar/windows-menu.tsx
- packages/cli/script/build.ts
- packages/cli/src/acp/agent.ts
- packages/cli/src/commands/handlers/acp.ts
- packages/cli/src/commands/handlers/mcp/auth.ts
- packages/cli/src/commands/handlers/stats.ts
- packages/cli/src/commands/handlers/uninstall.ts
- packages/cli/src/mini-host.ts
- packages/cli/src/mini.ts
- packages/cli/src/services/updater.ts
- packages/cli/test/installer-branding.test.ts
- packages/cli/test/mini.test.ts
- packages/cli/test/stats.test.ts
- packages/core/src/plugin/skill.ts
- packages/core/src/plugin/skill/report.md
- packages/core/test/plugin/skill.test.ts
- packages/desktop/electron-builder.config.test.ts
- packages/desktop/package.json
- packages/desktop/resources/LICENSE-subi-code.txt
- packages/desktop/resources/in.stlearnsmart.subi.desktop.dev.metainfo.xml
- packages/desktop/resources/linux/opencode-desktop.desktop
- packages/desktop/scripts/copy-metainfo.ts
- packages/desktop/src/main/native/logging.ts
- packages/desktop/src/main/service/desktop-cli.ts
- packages/gui-extensions/README.md
- packages/gui-extensions/src/branding.test.ts
- packages/gui-extensions/src/branding.ts
- packages/gui-extensions/src/browser/index.ts
- packages/gui-extensions/src/btw/index.ts
- packages/gui-extensions/src/context/index.ts
- packages/gui-extensions/src/debug/index.ts
- packages/gui-extensions/src/details/index.ts
- packages/gui-extensions/src/file/index.ts
- packages/gui-extensions/src/microsoft-office/index.ts
- packages/gui-extensions/src/pairing/index.ts
- packages/gui-extensions/src/remote-branding.test.ts
- packages/gui-extensions/src/review/index.ts
- packages/gui-extensions/src/ssh/bootstrap.test.ts
- packages/gui-extensions/src/ssh/bootstrap.ts
- packages/gui-extensions/src/ssh/i18n/en.ts
- packages/gui-extensions/src/ssh/index.ts
- packages/gui-extensions/src/ssh/remote-cli.ts
- packages/gui-extensions/src/terminal/index.ts
- packages/gui-extensions/src/updater/index.ts
- packages/gui-extensions/src/updater/renderer.tsx
- packages/gui-extensions/src/wsl/i18n/en.ts
- packages/gui-extensions/src/wsl/index.ts
- packages/gui-extensions/src/wsl/remote-cli.ts
- packages/session-ui/src/tools/tool-renderer.tsx
- packages/tui/src/app.tsx
- packages/tui/src/util/tool-display.ts
- packages/tui/test/util/tool-display.test.ts
- packages/ui/src/data-display/project-avatar/project-avatar.tsx
- packages/ui/src/theme/context.tsx
- packages/ui/src/theme/themes/oc-2.json
- packages/util/src/product.test.ts
- packages/util/src/product.ts
- sdks/vscode/LICENSE
- sdks/vscode/package.json
