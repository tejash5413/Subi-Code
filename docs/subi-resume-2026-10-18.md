# Subi Code — October 18 handoff

## Current UI branding cleanup — dev.34, October 19

Windows CLI/desktop **2.0.0-dev.34** and VS Code **2.0.4** are installed. Fixed
62 translated CLI install messages still naming opencode2, seven inflected or
case-varied WSL error messages, Worktree hints and internal CLI plugin labels.
Worktree hints now use SUBI_WORKTREE_BASE/PATH; the backend supplies both the
new and original aliases with identical values. Plugin actions retain their
registered IDs; only internal presentation labels/source labels changed.

Expanded substring audit: 88,484 messages across 759 dictionaries, zero old-name
matches after presentation branding. Original legal notices, external identities,
provider responses and user content remain unchanged. Regression cases failed
before correction and passed afterward: 70 presentation tests over ten repeats;
35 real Worktree tests passed with old/new variable coverage. Final root check:
36 successful tasks.

Packaged native desktop checks assert no OpenCode text in twelve Settings sections
and Add MCP connection. Startup/Build/Plan and isolated VSIX CLI/terminal reuse
passed. Installer exit 0; installed CLI/sidecar/extension hashes and desktop archive
match tested files. Normal installed-profile checks passed: fifteen tasks and
nightowl dark theme preserved, no renderer errors or inference calls. Source fixes
are shared across platforms; Mac/Linux and Windows ARM64 native checks remain pending.

See [branding audit report](subi-ui-branding-audit-2026-10-19.md). Current packages:
`artifacts/platforms/2.0.0-dev.34/win32-x64/`. Earlier inventories are historical.

## Current centered desktop startup — dev.33, October 19

Desktop **2.0.0-dev.33** is installed. First-launch splash uses a large centered
ribbon above `SUBI CODE` in locally bundled Keania One Regular. Other Wordmark
consumers remain horizontal. Light/dark contrast, animation and reduced-motion
behavior are preserved. Desktop packages include the font's original OFL license.

Final root check: 36 successful tasks. Twelve actual shared-component visual
cases passed across three OS layout values, two themes and two viewport sizes.
Native Windows packaged check passed font loading, Build/Plan, Settings, themes
and real local MCP CRUD/tools/session-add flow. Installer exit 0. Normal-profile
checks passed; 15 saved tasks and nightowl dark theme preserved, no renderer
errors. Installed archive hash matches the tested package. No inference sent.

CLI/desktop sidecar remain dev.32 and VS Code remains 2.0.3. Mac/Linux native
qualification is still pending. See [centered startup report](subi-centered-startup-2026-10-19.md).
The user-facing preview is `artifacts/platforms/2.0.0-dev.33/visuals/windows-light-1440.png`.

## Current installed branding/light-mode update — dev.32, October 19

Windows CLI and desktop **2.0.0-dev.32** plus VS Code **2.0.3** are installed.
The startup wordmark uses solid theme text and a darkened transparent ribbon
on light backgrounds; dark mode retains the silver ribbon. Six actual shared
component visual cases passed across Windows/macOS/Linux layout values.
These are Windows-hosted component checks, not native Mac/Linux execution.

Presentation branding now uses SubiCode, including translated pairing and
Extensions labels. Audit: 54,655 messages across 63 dictionaries, no remaining
OpenCode matches in transformed application text. Backend compatibility IDs,
third-party legal credits and external/user content are preserved.

Root check: 36 successful tasks. Final packaged native desktop/extension host
passed. Installer exit 0; installed CLI/sidecar/extension hashes match, as do
installed/packaged desktop archives. Normal installed profile passed Settings,
MCP API/form, Extensions menus and Recent tasks. 15 saved tasks and selected
nightowl dark theme were preserved, no renderer errors. No inference sent.

See [branding/light-mode report](subi-branding-light-mode-2026-10-19.md) and
[platform report](subi-platform-packages-2026-10-19.md). Current artifacts are
under `artifacts/platforms/2.0.0-dev.32/`; Linux/macOS and Windows ARM64 native
jobs still need to run. Earlier version inventories below are historical.

## Latest platform packaging changes — dev.30, October 19

Windows CLI and desktop dev.30 plus VS Code 2.0.1 are installed. All three
contain the matching newly compiled CLI, including the current shared web UI.
Installed profile verification preserved twelve tasks and the existing theme;
Settings, Recent tasks, account navigation and Add MCP connection passed.
Older Subi/OpenCode VS Code integrations were backed up and removed.

Six native Windows/Linux/macOS x64/ARM64 package jobs and a reusable native
desktop/extension qualification harness are implemented. Linux/macOS and
Windows ARM64 execution remain pending: this copy has no Git metadata/CI run
and this machine is Windows x64. See
[platform packaging report](subi-platform-packages-2026-10-19.md) for exact
artifacts, evidence, commands and remaining native qualifications. Earlier
version inventories below are historical.

## Latest platform verification review — October 19

Read-only inventory reconfirms Windows CLI dev.25, VS Code extension 2.0.0 with
dev.25 CLI, and desktop dev.29. All three installed CLI hashes match; installed
extension.js matches the qualified VSIX; desktop archive matches dev.29.
The current packages are Windows x64. Linux/macOS targets and shared code exist,
but no native release artifacts were found and those native tests remain
outstanding. WSL is not installed. Older `learnsmart.subi@0.1.0` and
`sst-dev.opencode@1.0.0` are also still installed in VS Code; no removal was
performed. See [installed platform check](subi-installed-platform-check-2026-10-19.md).

## Latest installed session Add MCP connection — dev.29, October 19

SubiCode dev.29 is installed on Windows. Session details → MCP now offers Add
MCP connection in place of Configuration file, using the same App name/URL/
authentication/advanced OAuth form as Settings. Saves target the session's
server, persist globally there and start the existing browser sign-in flow when
required. The form now fits the viewport and keeps Save and connect visible.

Final canonical check: 36 tasks successful. Final production keepers: 23/23
pass, including local desktop and remote mobile Add/SSO/future-session coverage
and Settings form validation/editing. Visual checks: 3/3 pass, with advanced
fields expanded too. Packaged native check added a real local MCP connection
from the session form and discovered tools. Normal installed-profile checks
passed, no renderer errors; twelve tasks, accounts and dark theme preserved.
Installer exit 0; installed hashes match. The blank session Add MCP form is left
open for the user. No connection was added to the normal profile during checks.

Bundled/global CLI and VS Code remain qualified dev.25. Native macOS/Linux
testing still needs those hosts; the shared app renderer contains this change.
See [session Add MCP report](subi-session-add-mcp-2026-10-19.md) for source,
retained failures, screenshots, native scope and hashes.

## Latest installed in-session Extensions design — dev.28, October 19

SubiCode dev.28 is installed on Windows and left with the Session details /
Extensions panel open. The screenshot's independent flyout is now one outlined
surface with flat sections, aligned controls and matching MCP/Plugins/Skills/
LSP menus. Mobile retains its single drawer and back navigation. Production
change is limited to the built-in details extension's CSS; handlers and service
logic are unchanged.

Canonical check: 36 successful tasks. Final browser keeper run: 19/19 pass.
Production visual checks: 4/4 pass. Private packaged real-service checks and
normal installed-profile checks passed all four extension menus, configuration
controls, keyboard focus, Settings and MCP operations with no renderer errors.
Accounts/history/theme preserved; installed hashes match the package. Bundled
CLI/global CLI/VS Code remain dev.25. Native macOS/Linux testing still needs
those hosts; they share the updated UI source. See the
[Extensions design report](subi-session-extensions-design-2026-10-19.md) for
test fixture corrections, screenshots, hashes and scope.

## Latest installed Recent tasks and shared surfaces — dev.27, October 19

SubiCode dev.27 is installed on Windows and left on Recent tasks. The remaining
inherited Home presentation now matches the approved monochrome app: explicit
Recent tasks heading, aligned toolbar, flat task rows, project navigation and
responsive layout. Shared dialogs, command search, menus and project popovers
use the same design. Existing controllers and execution behavior are retained.

Canonical check: 36 successful tasks. App units: 762 pass. All 114 browser keeper
cases have passing evidence (104 initial passes plus ten corrected-fixture
rechecks), with four production visual cases passing. Packaged native checks
passed Build/Plan, all twelve Settings pages, themes, account navigation and
real MCP tools, including a CLI addition reflected in the GUI. The normal
installed profile passed saved-task reopening/search/Commands, Settings and
MCP form/API with no renderer errors. Installer exit 0 and installed hashes
match. Existing profile/theme preserved.

The same renderer serves Windows, macOS and Linux, but native macOS/Linux
qualification still requires those hosts. Bundled CLI, global CLI and VS Code
extension remain dev.25; this update changes desktop/shared app presentation.
No hosted deployment, paid inference or credit purchase was performed.
See [UI completion report](subi-desktop-ui-completion-2026-10-19.md) for exact
scope, measurements, test corrections, screenshots and installed hashes.

## Latest installed Settings redesign — dev.26, October 19

The user approved the monochrome Settings preview and it is now implemented and
installed. SubiCode is open on Preferences. All twelve Settings pages, including
desktop Pairing, use one sidebar with Personal/Workspace groups, a branded header,
breadcrumbs and flat rows. Existing theme choices and behavior are retained;
the normal profile's light theme was preserved. Account and credits opens the
real LearnSmart panel. Native MCP tools and add form pass in the installed app.
The desktop frontend is dev.26; the bundled service, global CLI and VS Code
extension remain the qualified dev.25. CLI terminal design was not changed.

Canonical check passes 36 tasks; Settings units pass 52 tests; all 50 current
browser keeper cases have passing evidence (49 complete-run passes plus the
targeted corrected-branding pairing recheck). Production visual and private
packaged native checks pass, including real local MCP operations. Installer exit
0, installed hashes match. Optional E2E type-check still has four pre-existing
errors in untouched terminal/timeline test code. macOS/Linux native qualification
is still outstanding. See [Settings report](subi-settings-design-2026-10-19.md)
for exact scope, artifacts, retained failures, screenshots and hashes.

## Latest installed MCP update — dev.25, October 19

Windows desktop, global CLI and VS Code extension now contain the dev.25 MCP
connection update. Desktop is open on Extensions → MCPs. The installed tools API,
add form, title, shortcuts and package hashes were verified. Real local MCP
connection, tools, reconnect, removal and cross-client CLI addition/removal passed
in a private packaged profile. CLI Ctrl+A adds an app name/URL from MCP servers;
Ctrl+R refreshes. CLI `mcp add --url ... --global --auth` waits for connection
discovery and only starts OAuth when required. New OAuth DCR identifies SubiCode.
Canonical root check: 36 tasks passed; core MCP/plugins: 94 pass, one existing
skip; OAuth: 21 pass; config HTTP: three pass; CLI: four pass; TUI: 40 repeated
passes; focused new browser cases: three pass. Native VS Code dev.25 host passed.

See [MCP report](subi-mcp-connections-2026-10-19.md) for functionality, artifacts,
hashes, retained failed dev.24 diagnosis and platform limits. macOS/Linux share
the source but still require native-host qualification. No hosted deployment or
paid inference was performed.

The later Settings redesign was approved and implemented in dev.26 above. Its
original navigable dark, monochrome preview is at
`C:/Users/Admin/.codex/visualizations/2026/10/16/01a142e4-f4b0-7a82-9ea8-a2664b4fe74b/subicode-settings-preview.html`.
Reload the full visualize skill before creating or updating that visualization.

## Latest installed desktop GUI — dev.23, October 19

Approved workspace redesign is installed and open as **SubiCode**. Normal-profile
Settings now selects Workspace sidebar and Dark mode; the old Horizontal setting
had initially hidden the sidebar. Existing accounts, model selection and drafts
are preserved. Models, Integrations, MCP/plugins, account/credits and Preferences
navigation passed in the installed app with no renderer errors. Build/Plan and
hidden-window reopening passed native checks. Root check passes 36 tasks; app
unit tests pass 762/762. All 39 composer/tab browser cases pass after correcting
two stale selectors, plus 20/20 repeated new-feature cases and two layout/settings
keeper cases. The bundled service remains dev.20 on 46513. CLI and VS Code
extension installations are unchanged. See the
[desktop workspace report](subi-desktop-workspace-2026-10-19.md) for hashes,
UI-to-feature mapping, retained failures and platform qualification scope.

## Latest installed desktop GUI — dev.21, October 19

The desktop now has the CLI-style centered block wordmark at normal contrast
and a transparent icon in the hero and titlebar. Dark/light packaged checks and
root checks pass. Windows installer exited 0 and installed hashes match.
GUI is dev.21; bundled server remains qualified dev.20, and global CLI/extension
remain their previous versions. See [app branding report](subi-app-wordmark-2026-10-19.md).
The earlier sections below record historical checkpoints.

## Latest installed desktop — dev.20, October 19

The Windows desktop now bundles dev.20 with the default-port collision fix and
new white logo. Installed and packaged fresh-profile startup/Build-Plan keyboard
checks pass; root check passes 36/36. Normal server logs confirm dev.20 on port
46513. Global CLI and extension remain the previously installed dev.19 bundle.
See [desktop installation report](subi-desktop-dev20-install-2026-10-19.md),
including retained automation failures and platform limitations. The desktop
was reopened normally. Earlier sections below describe historical checkpoints.

## October 19 desktop port collision repair

Installed Subi uses port 46513 to coexist with the original OpenCode service on
45278. The normal-profile desktop startup is verified and Subi was reopened.
Source defaults are also separated for the next build; installed binaries remain
dev.19 with a persisted port override. See
[port repair](subi-desktop-port-fix-2026-10-19.md) for checks and evidence.

## October 19 platform and new-logo update — dev.19

Latest installed Windows CLI, extension bundle and desktop now contain dev.19.
The supplied glossy white ribbon logo replaces prior assets across local CLI,
extension, shared app/sign-in/web and Windows/Linux/macOS packaging sources.
The installed Windows desktop opens and switches Build/Plan successfully.
See [platform audit](subi-platform-audit-2026-10-19.md) for verification, artifacts,
backups and limitations. Linux/macOS native qualification remains pending.
The older sections below describe historical checkpoints.

## October 19 CLI presentation update

Latest installed CLI is **dev.18**, restoring the large centered SUBICODE welcome
wordmark requested after dev.17. It stays while typing, disappears on send, and
returns on a fresh session. [Welcome update](subi-cli-welcome-2026-10-19.md) records
the 100 repeated design/logo/lifecycle checks, 49 existing regression passes,
root check, actual Windows terminal verification and artifact/backup locations.

The approved minimal monochrome CLI design and configured shortcut hints are
implemented in the main Subi 2.0 tree. The final TUI suite passes 1,507 tests
(12 existing skips), the new design/theme checks pass ten repetitions, and root
check passes 36/36. The dev.17 Windows binary passes actual private-profile ConPTY
checks, including menus, settings and resizing. See
[October 19 CLI design report](subi-cli-design-2026-10-19.md) for source, artifacts,
previews, backups and installed CLI status. Extension and desktop GUI redesigns
remain follow-up phases; the installed dev.16 extension/desktop are retained.

Work in `D:\LearnSmart\Subi 2.0`. The original Subi and OpenCode directories
remain reference sources. This copy has no Git metadata. Preserve existing
artifacts and account state. Bulky logs, deployment snapshots and disposable
test profiles are in `C:\Users\Admin\AppData\Local\Temp\subi2-20261018`.

## Installed Windows components and desktop startup repair — dev.16

The user authorized installation. The global npm CLI now prints subi v2.0.0-dev.16.
The VS Code learnsmart.subicode@2.0.0 extension is installed; use Open Subi Code.
Older learnsmart.subi and sst-dev.opencode extensions were retained. The old global
CLI package/shims were backed up outside the repo before npm replacement.

Subi Code Dev is installed per-user at
C:\Users\Admin\AppData\Local\Programs\subicode-desktop\Subi Code Dev.exe,
with desktop and Start menu shortcuts. The first desktop package reproduced a
black screen: Electron could not load external @opencode/util/src/product.ts.
The desktop build now bundles that TypeScript workspace dependency. The existing
bundling test preserves its old assertions and additionally checks the utility's
real compiled output. All 135 desktop tests pass; the two packaging tests pass
ten repetitions. Root check passes 36/36.

Use the corrected installer artifacts/2026-10-18/desktop-dev16-startup-fix/subi-desktop-win-x64.exe;
SHA256 01806BF7F72130B3713C0626DFCFD807A93F922FDD027B6693CF4D3498F00BAF.
Do not reinstall the original desktop-dev16 package; it is preserved as regression
evidence. The corrected installed desktop reaches the production home/composer
and starts its local service in the disposable-profile native fixture (4,808 ms,
zero captured renderer errors). Installed bytes match the corrected package.

See docs/subi-installation-2026-10-18.md for commands, locations, limits and hashes.
Logs/screenshots/private test profiles remain under the external temp directory.
No live inference, payment, account login/logout, deployment or publishing occurred.
The earlier broader NOT READY release verdict remains. Historical statements below
about no normal-profile installation apply to the earlier branding/billing phases.

## Current presentation branding — dev.16

Latest CLI: packages/cli/dist/subi-branding-final-20261018/cli-windows-x64-baseline/bin/subi.exe.
SHA256 FBBA34E8359B106B53F1DD09716A452B1CFE37CF72525B4DFAA6DD62A972AC82.
Latest VSIX: artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev16.vsix.
SHA256 8ECD00FA2FF98AB9EC9F4AA80657730A3DE15264996972DAE7CC8C2CD9DEA082.
Embedded VSIX and desktop CLI bytes match. Earlier dev.15 artifacts remain saved.

Subi Code now owns the shared app/native-menu/feature translation presentation,
About/help/pairing copy, theme display names, tool/skill labels, installer paths,
VS Code metadata and Linux package metadata. The 13 built-in catalogs adapt
their own English and lazy locale values; external plugin/user/provider content
is preserved. Original MIT/license notices and internal protocols/configuration
names remain intact. No new dependency, RPC/schema or account authority.

Root check passes 36/36; strict changed-GUI lint has zero diagnostics in 50 files.
Configured app 762 unit +176 browser-condition, TUI 1500 pass/12 skip, CLI 309
pass/8 skip, desktop 135, GUI extensions 178 pass/1 skip, UI 152 and session UI
251 pass. Core skill two and product one pass. Actual Chrome host/graph tests
25/25 pass. Native Windows ConPTY verifies title, Settings theme, Ctrl+P and
signed-out /account on the compiled CLI. Web and desktop main/preload/renderer
builds pass. Upstream automatic updates/downloads and release highlights remain
disabled. WSL only stages a supplied version-checked Subi binary; SSH discovers
Subi. No normal-profile install, live inference, payment or backend deployment.

Start the new executable with --standalone; /settings shows Subi Code and Ctrl+P
opens commands. School/individual model/credit/permission behavior is preserved.
Provider-hosted OAuth names still require the user's future app registrations.
Native Linux/macOS/WSL/SSH qualification, individual model discovery latency, and
the earlier full coding/recovery/promotion release fixtures remain outstanding.
Overall release verdict stays NOT READY. See docs/subi-branding-2026-10-18.md for
the complete commands, evidence, compatibility exceptions, files and logs.

## Preserved individual billing integration — dev.15

Latest CLI: `packages/cli/dist/subi-billing-final-20261018/cli-windows-x64-baseline/bin/subi.exe`.
SHA256 `2BE4404425416C1B8467708E6500135CB4721B1BADFD6DD6D3A920130510487B`.
Latest VSIX: `artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev15.vsix`.
SHA256 `A63934C8796F70FAA4FFA8B3856C6E136EE05E618BB43B563599A8F9184B8897`.
Embedded VSIX/desktop resource CLI bytes match. Extension packaging/type checks
pass with 42 existing semicolon lint warnings, zero lint errors. Normal VS Code
profiles have not been upgraded. Desktop main/preload/renderer and web builds
pass; their outputs are not signed installers. The CLI has no embedded web UI.

Run the new CLI with `--standalone`, then `/account`. `p` opens top-up for an
active individual subscription; `n` opens purchase/renewal; `r` refreshes after
payment. Mouse links also work. Web/desktop expose the same account data under
Settings → Providers (search credits or LearnSmart). Purchases and receipts stay
on the existing LearnSmart website; use the same account there. No local token
or account ID enters the checkout URL, and no credit is added optimistically.

Added monthly grant/remaining, rollover, purchased/reserved/available credits,
cycle dates, inactive renewal guidance, and refresh on return after opening
checkout. Explicit school quotas override stale individual login metadata for
purchase actions. Account switching/logout dispose pending requests and clear
old balances. No backend source, payment SDK, schema/RPC, deployment, credit
record or subscription record changed. Manual renewal remains manual checkout.

Final checks: root 36/36; app 761 unit + 176 browser tests; TUI 1500 pass,
12 skipped, zero failed (108082 assertions); managed 76 pass; core account
boundary four pass. Browser keeper ten isolated runs passed; two TUI scenarios
each repeated ten times passed (320 assertions). Native compiled private PTY
opened `/account`; Chrome desktop/mobile fixture checks passed. No real payment
or inference. The first missing-rollover and stale-school-action regression
failures are retained. Dev.14's partial candidate is superseded; use dev.15.

Full commands, source changes, source evidence, logs and limitations:
`docs/subi-billing-integration-2026-10-18.md`. Logs remain in the external temp
folder above. Broader release qualification and model-discovery latency remain
open; the new billing controls do not close those gates.

## Preserved LearnSmart login follow-up — dev.13

The private loopback LearnSmart login page now uses the supplied transparent
logo, blue/purple palette, responsive card, labelled fields, visible keyboard
focus, and matching error/success states. It is self-contained, without scripts
or remote assets. Authentication, credential storage, origin/host validation,
request bounds, cancellation and completion ownership are unchanged. CSP adds
only `img-src data:` for the embedded existing logo.

- CLI: `packages/cli/dist/subi-login-20261018/cli-windows-x64-baseline/bin/subi.exe`,
  version `2.0.0-dev.13`, SHA256
  `7732230ABAED17E8504B5641154B0E4D48437D39CDEA53444DDD55F46EB057A3`.
- VS Code package: `artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev13.vsix`,
  SHA256 `D87D62F2336CE73194348D957821818F26BA8F112F5FF20D05B34741D59FDE62`.
  VSCE packaging and extension type checks passed; lint completed with zero
  errors and 42 existing semicolon warnings. Extracted CLI bytes match.
  This package has not been installed into the user's normal VS Code profile.
- Start a new LearnSmart sign-in attempt from this executable. Existing pages
  belong to the older running executable and cannot receive this source update.
- Boundary regressions first failed on the old page (2 pass / 2 fail). After
  implementation: `bun run script/test.ts test/plugin/provider-learnsmart.test.ts
test/oauth-page.test.ts` from core: 11 pass, zero fail, 110 assertions.
- `bun typecheck` from core passed. Headless installed Chrome used the actual
  production loopback server with a fake Firebase transport: desktop 1280x900,
  mobile 320x720, loaded logo, keyboard order, browser form Origin, rejected login
  then successful retry, success without form, zero external requests/errors.
  No real account sign-in or inference was performed. Native compiled CLI checks
  passed help/version, empty isolated auth, new page, two rejected origins and
  owned listener shutdown. Desktop resource staging matches the CLI hash.
- Logs/previews outside the repo: `login-red.log`, `login-green.log`,
  `login-typecheck.log`, `login-browser.log`, `login-native.log`, `login-build.log`,
  `login-desktop-stage.log`, and `login-{desktop,mobile,error,success}.png`.
  `login-artifacts.json` records matching VSIX/CLI hashes; `login-vsix.log`
  records packaging checks. Source check: 400 original-manifest paths differ,
  zero upstream OpenCode paths changed, zero whitespace errors
  (`login-source-check.log`).
  This bounded follow-up does not rerun the previous full-suite baseline or
  qualify native macOS/Linux installations.

### Individual model loading investigation remains open

Read-only diagnostics found an active individual account. Initial access and
model requests each timed out at the current 12-second limit; later discovery
returned 11 assigned, tool-capable models with context metadata. Two later
access/model pairs measured 3444/635ms and 1123/1554ms. Sampled backend config
requests were mostly about 0.35–0.6 seconds and no startup event was observed in
that sample; cold starts are not established as the cause.

Account RPC currently awaits bootstrap and then native refresh. Those paths
repeat access/catalog calls, while bootstrap waits for other account display
data and usage. Native refresh serializes discovery and turns some failures
into an empty catalog. Investigate bounded request sharing and error visibility
with operation-count regressions while preserving current authorization.
No latency fix was implemented in this login design change. Private diagnostic
logs remain outside the repository; do not copy account identifiers into reports.

## Preserved visual follow-up — dev.12

The user requested the previous large terminal SUBI CODE lettering, using the
logo colors instead of a pixel icon beside small white text. The exact five-row
wide wordmark is restored: SUBI blue `#087dfd`, CODE purple `#7038ff`. Compact
layouts are preserved. App/desktop/extension icon artwork remains unchanged.

- Latest CLI: `packages/cli/dist/subi-lettering-20261018/cli-windows-x64-baseline/bin/subi.exe`, `2.0.0-dev.12`.
  SHA256 `2A71058F27A6A223611CCCA021A821EED14F8A51EA927C5C475CCF247BED089A`.
- Latest VSIX: `artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev12.vsix`.
  SHA256 `3F5415FA9CC71E8D2073B2B776FCF453A62AE022683234B36FB7F7450610ADC6`.
  Extracted bundle hash matches the tested CLI; desktop staging also matches.
- Four width/color regressions and TUI type-check passed. Actual Windows PTY
  startup confirmed the original glyph rows and both exact RGB foregrounds.
  The native settings/startup smoke passed, with zero inference. Previous full
  suites and installed extension-host checks below describe dev.11.

## Preserved dev.11 artifacts and qualification

- Windows x64 CLI: `packages/cli/dist/subi-final-20261018/cli-windows-x64-baseline/bin/subi.exe`, version `2.0.0-dev.11`.
  SHA256 `B184116A10CC08F34247F8B138866357E3C59CACE2A26CBFEC3A2F1999FFAF87`.
- VSIX: `artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev11.vsix`.
  SHA256 `825E81C752AA580ABF265AF3D061592A7618596A262F9CBA158FDACC5F96918E`.
  Its bundled CLI matches the hash above. Installed and exercised in a
  disposable native VS Code profile; commands, actual process, title change,
  terminal reuse and explicit new tab passed. Normal profiles were not replaced.
- Desktop source output: `packages/desktop/out`, staged with the matching CLI.
  Electron main, preload and renderer builds passed. This is not a signed
  installer or a native Linux/macOS execution qualification.

Launch the new CLI from the intended project directory, not System32:

```powershell
Set-Location 'D:\learnsmart pdf\CBSE\Class 11\NCERT\CHE\Portfolio'
& 'D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-lettering-20261018\cli-windows-x64-baseline\bin\subi.exe' --standalone
```

The build intentionally uses `--skip-web-ui`; it does not embed the web app.
Older binaries remain available as fallbacks. The user must select the new
executable to receive local persistence and shell-guidance changes.

## Changes

1. Ctrl+R refreshes the model picker, including its empty state. Refresh is
   single-flight, preserves search/dialog state, handles failure and disposal,
   and avoids LearnSmart calls for BYOK-only connections.
2. VS Code tracks owned Terminal objects instead of their mutable names. The
   CLI changes its title to `subi`; this no longer causes duplicate terminals.
3. Settings/theme display, update UI, permission hints, crash report, onboarding
   and stats show Subi Code. Saved compatibility identifiers remain intact.
4. The supplied logo is preserved byte-for-byte in
   `assets/brand/subi-code-source.png`. `script/brand-assets.py` generates native
   icons, browser/extension images, shared UI and callback images, and terminal
   half-block artwork. Shared Wordmark, About and notifications were also
   corrected. Splash completion still releases startup.
5. Completed parallel provider calls without streaming indices previously
   merged into one call. The backend parser now preserves their positions and
   replaces completed fields after deltas. It still withholds executable calls
   until successful durable settlement. Safe errors display their category;
   internal diagnostics allow only fixed categories and numeric status.
6. Concurrent Windows readers caused EPERM on atomic tab JSON replacement.
   The same rename now retries transient EPERM/EBUSY at most five times (300ms
   total delay), preserving the old file and retaining failure cleanup.
7. Read-only history established that the screenshot's shell command tested
   `$LASTEXITCODE` after `ls`. The folder exists. The model-visible PowerShell
   tool description now directs `Test-Path`, `$?` for cmdlets, and
   `$LASTEXITCODE` only for native commands. This guidance does not guarantee
   that every model will generate a correct command.

## Verification evidence

Commands used the pinned Bun 1.4.2 runtime and Node 22.19.0. Package commands
ran from their package directories; root `bun run check` is the canonical
lint/type-check gate. No direct root test run is counted.

| Check                                                               | Observed result                                                                                      | External log                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Root `bun run check`                                                | 36/36 tasks successful, 27 cached, 124.938s; existing lint warnings                                  | `final-root-check.log`                                                               |
| TUI `bun run test`                                                  | 1500 pass, 12 skipped, 0 failed; 108063 assertions; 1512 cases / 179 files; 181.84s                  | `final-tui-all.log`                                                                  |
| CLI `bun run test`                                                  | 308 pass, 8 skipped, 0 failed; 1162 assertions; 316 cases / 51 files; 374.55s                        | `final-cli-all.log`                                                                  |
| Backend `node --test test/*.test.js`                                | 978 pass, 0 failed, 20.617s                                                                          | `native-parser-final-full.log`                                                       |
| Backend boundary and no-leak scripts                                | Both passed                                                                                          | `native-parser-boundaries.log`, `native-parser-leak.log`                             |
| Native parser/error contracts, ten isolated Node processes          | 10 cases each, 100 passes total                                                                      | `native-parser-isolated-1.log` through `-10.log`                                     |
| Core shell/OAuth/native-client regressions                          | 53 pass, 63 skipped, 0 failed; 296 assertions; 55.46s                                                | `final-core-regressions-rerun.log`                                                   |
| Two shell cases that timed out under build load, repeated ten times | 20 pass, 0 failed; 100 assertions; 18.79s                                                            | `final-core-shell-repeat.log`                                                        |
| Persistence/session-tab regressions repeated ten times              | 270 pass, 0 failed; 600 assertions; 82.46s, before expanded error table                              | `persistence-after-repeat.log`                                                       |
| Existing recovery/worker suites repeated ten times                  | 850 pass, 0 failed; 3400 assertions; 348.05s                                                         | `recovery-workers-repeat.log`                                                        |
| Native Windows installer ACL regression                             | 1 pass, 0 failed; 15 assertions; 76.27s on isolated rerun                                            | `windows-installer-final.log`                                                        |
| Real Chromium, actual shared Wordmark/About/splash components       | Supplied image, Subi wordmark, settled About and startup animation callback passed; 0 browser errors | `brand-browser-final.log`, `brand-browser.png`                                       |
| Native dev.11 PTY settings and Ctrl+R model picker                  | Both passed; 9 assigned models matched display names/context limits                                  | `native-live-settings.log`, `native-live-picker.log`, `dev11-live-catalog-final.log` |
| Native packaged dev.11 VS Code host                                 | Isolated installation, bundle hash, process, renamed-terminal reuse/new tab passed                   | `vscode-dev11-host.log`                                                              |
| Platform image conversion                                           | 153 desktop images decoded; original unchanged; alpha and ICO/ICNS readback checked                  | `check-brand.py`, `brand-preview.png`                                                |

Earlier core full suite: 5232 pass / 1475 skipped / 0 failed. Its final changes
were subsequently covered by the focused core regressions above. The final
compiled CLI and native extension bundle have the identical SHA256 recorded
above; the desktop stages the same binary. Source checkpoint completion is
recorded in the execution ledger.

Failures retained in logs: two obsolete terminal-art expectations were replaced
with the new glyph while keeping complete resume-command assertions. Concurrent
tab failures reproduced real Windows rename errors and led to the bounded fix.
Two shell cases timed out during simultaneous builds; the isolated repeats and
the complete affected-file rerun passed. The native installer first timed out
during tool downloads and passed on the isolated rerun. Negative-test logs also
contain expected ENOSPC, HTTP 503 and missing-editor errors; passing suites are
not described as warning-free.

## Backend deployment

Only `subiManagedAgentApi` in project `learnsmart-c2a7e`, `asia-south1`, was
updated. Active revision: `subimanagedagentapi-00049-yup`. The service account,
512MiB memory, 540s timeout and `SUBI_NATIVE_AGENT_ENABLED=1` were preserved.

Command from `integrations/learnsmart`:

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT='30'
firebase deploy --only functions:subi:subiManagedAgentApi --project learnsmart-c2a7e --config firebase.json --non-interactive
```

The first deployment stopped in local discovery at its 10s limit. Independent
index loading succeeded in 1195ms; the second deployment succeeded with a 30s
local discovery allowance. This was not an increased model/runtime timeout.
The previous deployed source ZIP and private configuration are saved outside
the repository. No unrelated function, account, quota, credit, secret or IAM
policy was changed.

Historical production logs establish `PROVIDER_UNAVAILABLE` after provider
acceptance, with accounting finalized. They lack the new diagnostic category,
so they do not prove the screenshot was caused by the reproduced parser bug.
Live discovery/status passed after deployment; no live generation was requested
by this qualification and no paid provider calls were made.

## Remaining qualification

- Have the user try a real coding request with dev.16. If it fails, investigate
  the safe error code and new allowlisted server failure category. Do not
  automatically replay ambiguous provider requests or tool mutations.
- Complete the realistic failure/repair/fresh-verification/saved-completion,
  restart continuation and duplicate-promotion fixtures from the earlier brief.
  Existing recovery tests do not replace these full fixtures.
- Native macOS/Linux application builds, signing/installers, every provider,
  all account types/billing paths and extension/desktop live inference remain
  unqualified. Hosted provider consent names require the user's future OAuth
  app registrations. Restricted OpenCode-hosted free services remain disabled;
  never spoof upstream identity to bypass that restriction.
- The broad release verdict remains **NOT READY** until its outstanding gates
  have direct current evidence. These development artifacts are suitable for
  the user's next local check, not an all-platform release claim.
