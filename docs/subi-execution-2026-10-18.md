# Execution ledger — plan: docs/subi-resume-2026-10-17.md

The user approved resuming the saved work on October 18, 2026.

- [x] Task 1: refresh full TUI baseline: 1,487 pass, 12 skipped, zero failed. Dev.8 built without replacing dev.7.
- [x] Task 2: dev.8 native Windows PTY Ctrl+R, empty catalog, live assigned-model picker/refresh, nine models/name/context matches; zero inference.
- [x] Task 3: reproduce and repair VS Code terminal reuse; package and test VSIX (dev.9 and dev.10 native packaged-host checks passed).
- [ ] Task 4: review recovery, worker and coding qualification gaps and run applicable checks.
- [ ] Final review and evidence update.

Pre-flight: the shared CLI runtime feeds the VS Code bundled binary; qualify
the CLI first and bundle the exact artifact. The existing native backend is
already deployed; no backend change or deployment is required for refresh.

Ruling: continue in the user's explicit `D:\LearnSmart\Subi 2.0` copy, which
has no Git metadata. Git worktree/commit helper scripts cannot apply here.
Preserve existing changes, keep file snapshots and bulky logs outside the
repository, and record results here. Creating a replacement checkout would
discard the saved integration state the user asked to continue.

Ruling: the saved approved plan and existing refresh behavior supply the design;
do not restart brainstorming or reimplement the already tested feature.

Logs for this run: `C:\Users\Admin\AppData\Local\Temp\subi2-20261018`.

Task 3 progress: native host reproduced duplicate terminals after the CLI
changed the terminal name to `subi`; ownership now uses Terminal object identity.
Dev.8 VSIX packaged, installed into a disposable VS Code profile and passed
native process/reuse/new-tab checks with a matching bundled CLI hash.

Task 4 progress: configured shared-core suite passed 5,232 tests, 1,475 skipped,
zero failures, 101,321 assertions (632.70s). Configured CLI suite passed 308,
eight skipped, zero failures, 1,162 assertions (288.87s). These suites do not
replace the still-open realistic full coding/recovery/promotion fixtures.

Scope update: the user reported Settings still displaying `opencode` and asked
for Subi Code branding. Theme display aliases preserve saved keys and custom
names. Settings, theme picker, devtools label and theme error toast use the
aliases. Adjacent update, permission, terminal, onboarding and stats labels and
command hints were corrected. Crash copying now produces a local Subi Code
report instead of an upstream GitHub issue URL. New settings/update/onboarding
regressions failed before changes (six failures), and crash-copy and stats-site
regressions separately failed before their fixes.

Repeated combined checks initially found six test failures: the refresh test
asserted the request count after a pending UI frame but before the asynchronous
integration read completed. The fixture now awaits the actual request signal;
all count and duplicate-trigger assertions remain. Final repeated branding,
refresh and stats checks passed 150 executions, zero failures, 620 assertions.

Ruling: keep `Subi Code 2` as the display label of the experimental second
theme; the user specified product branding, not alternative spacing. Saved
`opencode2` remains compatible, and no new theme schema is introduced.

Final review: a read-only reviewer initially inspected the work. The user
requested stopping that agent and using GPT-6.1 Sol; it was interrupted and the
remaining read-only review ran on GPT-6.1 Sol. No critical/important
implementation issue was found. Its two minor observations were acted on
within the user's explicit scope: stats still displayed the upstream site, and
the native test needed to wait for the title change before asserting reuse.
The stats-site regression failed before its correction; the native runner now
requires the changed title and is being requalified with the final package.

Final: Ruling: the review's whole-fork/backend/billing/inference exclusions are
outside this client change; retain explicit release gaps rather than marking
them qualified from client tests. Build/VSIX and test claims are established
by the executor's actual runs, not the read-only review. Compatibility package,
protocol and saved theme keys are intentionally retained; truthful external
provider attribution is not rewritten into a claim of Subi-owned service.

The user supplied `C:\Users\Admin\Downloads\Subi_Code_Logo_Transparent.png`.
Its exact bytes are preserved as `assets/brand/subi-code-source.png`.
Windows remains the local qualification platform.

Dev.9 qualification completed: full TUI 1,492 pass / 12 skipped / zero failed;
root check 36/36; native CLI model refresh/settings and packaged VSIX host pass.

## Supplied logo and managed failure follow-up

Approved scope: use the exact supplied image throughout Subi's terminal, shared
UI, extension and platform icon assets. Preserve existing architecture, account
and provider boundaries. `script/brand-assets.py` derives 153 desktop icon
files plus browser/extension/terminal assets. PNG/ICO/ICNS decode checks passed;
the original matches byte-for-byte and transparent corners are preserved.
Windows executable extraction confirms the compiled CLI includes the icon.

Shared logo, OAuth callback pages, shared Wordmark, About animation and desktop
notifications use the supplied artwork/Subi Code. The splash now fades the SVG
with the same completion event name. A real Chromium fixture rendered the actual
components, observed `SUBI CODE`, decoded the embedded image and received the
startup completion callback, with zero browser errors. Asset generation and
source builds do not qualify native Linux/macOS execution.

Managed request investigation: recent production failures had
`PROVIDER_UNAVAILABLE`, providerAccepted=true, HTTP status 0 and finalized
accounting. Historical logs cannot identify their precise parser branch.
A local failing regression reproduced completed parallel tool calls without
delta indices being merged into one invalid call. The parser now uses array
positions and replaces completed fields after earlier deltas. Safe error codes
are visible; logs add only allowlisted failure categories and numeric status.
No provider bodies, credentials or raw error text are introduced into logs.

Backend configured suite: 978 pass, zero failed. Native parser/error contracts:
10 cases in each of ten isolated processes, all passed. Both static gates pass.
Only `subiManagedAgentApi` was deployed: revision
`subimanagedagentapi-00049-yup`, ACTIVE. Service account, memory, runtime timeout
and native flag preserved. First local Firebase discovery attempt timed out;
the entrypoint then loaded in 1,195ms independently. A second deployment with
30s local discovery allowance succeeded. This does not change runtime limits.
Rollback source/configuration are outside the repository in the run log folder.

Screenshot shell diagnosis: read-only history confirmed `ls node_modules`
followed by `if ($LASTEXITCODE -eq 0)`. `node_modules` and package.json exist.
The condition is invalid evidence for a PowerShell cmdlet. The model-visible
shell context now explains `Test-Path`, `$?`, and native-only `$LASTEXITCODE`.
The test uses the actual session context hook, not the unshaped registry text.

Final suite triage reproduced Windows EPERM replacing tab-state JSON while
concurrent TUIs read it. A failing fault-injection regression preceded the fix.
Atomic replacement now retries only Windows EPERM/EBUSY, five retries / 300ms
total delay. It retains the old target and cleans up a failed temporary file.
270 repeated persistence/session-tab executions passed; coverage was expanded
to both transient categories and permanent failure bounds. Final configured
TUI: 1,500 pass, 12 skipped, zero failed, 108,063 assertions, 1512 cases / 179
files (181.84s). Earlier failures are retained in external logs.

Native Windows installer regression initially exceeded its 120s budget while
fetching tools, then passed alone in 76.27s, 15 assertions. Full live inference
and original complete coding/restart/promotion qualification remain open.

Dev.11 is built and qualified for the next Windows local check. Final CLI:
308 pass, eight skipped, zero failed, 1,162 assertions, 316 cases / 51 files
(374.55s). Final root check: 36/36 tasks, 27 cached (124.938s). Core affected
files: 53 pass, 63 skipped, zero failed, 296 assertions (55.46s). Two shell
cases timed out under concurrent build load; they passed all 20 isolated
repetitions and the affected-file rerun. Do not erase those failed-run logs.

Final VSIX installed and ran in a disposable native VS Code profile, including
the changed-terminal-title regression. Its CLI hash equals the standalone
artifact and staged desktop binary. Electron main/preload/renderer built
successfully. Native PTY settings, nine assigned-model name/context matches,
and Ctrl+R refresh all passed against the deployed native capability. Zero
live inference calls. Shared desktop notification output contains the same
canonical PNG bytes.

GPT-6.1 Sol follow-up found no remaining issue in the bounded changes. The
complete commands, artifact hashes and outstanding release gates are saved in
`docs/subi-resume-2026-10-18.md`. Do not infer end-to-end release readiness
from the review, client tests, or discovery-only live checks.

Final source checkpoint: 400 original-manifest paths differ in the Subi copy;
zero original OpenCode paths changed, and zero whitespace errors remain under
`git -c core.autocrlf=false diff --no-index --check`. The first check found 13
generated SVG CRLF endings; normalized them to LF and made the generator emit
LF explicitly. This was text-formatting only, with unchanged image data. New
text assets and this handoff are also checked separately against NUL.

User visual correction: keep the previous large terminal SUBI CODE lettering;
use the supplied artwork's blue/purple colors instead of a large pixel icon
beside small white text. The main header now restores the exact five-row
wordmark at wide widths, with blue SUBI and purple CODE. Compact text and
narrow monogram behavior are preserved. App/desktop/extension icons remain
the supplied image. Four width/color regressions and TUI type checking passed.
A fresh dev.12 CLI and matching VSIX are built; dev.11 remains preserved.
Native Windows PTY output confirms the original large lettering and both RGB
colors (`38;2;8;125;253` and `38;2;112;56;255`). Its model/settings startup
smoke passed with zero inference. The VSIX's embedded executable hash matches
the tested CLI. Desktop resource staging now uses the same dev.12 binary.
This follow-up changes the terminal header only; prior full-suite results
remain the dev.11 baseline. New checks: four width/color regressions, TUI
type-check and changed-file whitespace checks, all passed.

LearnSmart login design follow-up (dev.13): supplied logo and blue/purple theme
now appear on the private browser sign-in, error and success pages. Responsive
desktop/mobile browser checks exercised the production loopback server with
fixture Firebase responses, including a failed submission followed by success.
Zero remote browser assets, browser errors, live sign-ins or inference calls.
Existing origin/host, size, replay, single-flight and cancellation boundaries
remain in place. Only the embedded PNG allowance was added to CSP. Added page
regressions failed before implementation; affected login/OAuth suites now pass
11 tests / 110 assertions and core type-check passes. Native compiled dev.13
startup, empty auth, branded page, foreign origins and listener shutdown passed.
CLI and desktop staging hashes match; full-suite results above remain dev.11.
Exact artifact paths and commands are saved in the resume document.

Individual model discovery latency is investigated, not fixed: the active
individual account eventually returned 11 models after earlier 12s timeouts.
Later access/catalog calls took 3444/635ms and 1123/1554ms. Backend sampled
request latency was mostly 0.35–0.6s with no observed startup event. Repeated
sequential client access/model checks and waits for account display data are
identified follow-up paths; retain current access authority when optimizing.

Individual billing integration is added in dev.15: detailed credit/cycle data,
trusted hosted top-up/renewal actions, explicit expired guidance, bounded
single-flight refresh and focus-return refresh in terminal and shared app
settings. A reproduced stale-login-metadata case now hides individual actions
when the backend says school quotas. LearnSmart remains the payment, quote,
subscription and wallet authority. No live purchase, backend edit or deployment.

Final root check 36/36; configured app 761 unit + 176 browser passed; configured
TUI 1500 passed / 12 skipped / zero failed, 108082 assertions; managed 76 passed;
core account four passed. Ten isolated browser keeper runs and ten repetitions
of both TUI scenarios passed. Fresh CLI/VSIX hashes and desktop staging match;
native compiled Windows account route and Chrome responsive fixture checks
passed. Web and Electron main/preload/renderer builds pass. Native paid checkout
and Linux/macOS execution remain unqualified. Details and exact artifacts:
`docs/subi-billing-integration-2026-10-18.md`. Normal profiles were not replaced.

Presentation/packaging pass saved as dev.16. Shared translations (including all
13 built-in feature catalogs), themes, About/help/pairing, skill/tool labels,
native installer paths, VS Code metadata and Linux metadata use Subi Code.
Compatibility IDs and required license text remain; external content is not
rewritten. Automatic upstream downloads/highlights stay disabled. Remote
discovery now selects Subi, and a supplied WSL binary must pass version checks
before promotion. Real shell regressions preserve a separate upstream install.

Current root check 36/36, strict changed-GUI lint 0/50 files. App 762+176,
TUI 1500/12 skipped, CLI 309/8 skipped, desktop 135, GUI extensions 178/1 skipped,
UI 152 and session UI 251 pass; core skill 2 and product 1 pass. Actual Chrome
extension host/graph 25/25 pass. Native compiled Windows ConPTY checks title,
Settings, Ctrl+P and signed-out account. Fresh CLI/VSIX hashes match desktop
staging; web and Electron source builds pass. No live inference/payment,
normal-profile installation, deployment or native Mac/Linux qualification.
Exact artifacts, commands, limitations and source manifest:
`docs/subi-branding-2026-10-18.md`. Broader release verdict remains NOT READY.
