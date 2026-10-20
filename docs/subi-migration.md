# SUBI 2.0 migration

## Agreed product boundary

Develop in `D:\LearnSmart\Subi 2.0`. The OpenCode source at
`D:\LearnSmart\opencode-dev\opencode-dev` and the original SUBI project at
`D:\LearnSmart\Subi` are reference sources and remain unchanged.

OpenCode supplies the runtime: sessions, context management, agents, tools,
approvals, terminal, recovery, providers, BYOK, CLI, web and desktop packages.
Do not import the previous SUBI agent loop, file mutation engine, task completion
certificates, worker engine or BYOK vault into this product.

Reuse only SUBI's LearnSmart authentication, school/individual identities,
assigned models, account permission ceilings, existing limits and credit units,
purchase/renewal destinations, branding and visual design. LearnSmart logout
must remove managed authority and model selection without deleting unrelated
BYOK credentials. Backend responses remain authoritative for entitlements,
models, expiry and balances; a successful login alone does not grant inference.

Remove OpenCode Go/Plus/Zen subscription discovery and upgrade offers from the
shipped product. Preserve coding Plan mode and ordinary BYOK connections.
Copied upstream console, web and infrastructure sources are reference material,
not SUBI billing services to deploy. Do not redirect upstream Console requests
to LearnSmart: their authentication and inference protocols are different.

### Upstream maintenance, model access and product identity

The product name requested by the user is **Subi Code** across the CLI,
extension, app, desktop, installers, menus and provider attribution headers.
This is the target identity; remaining upstream strings and the existing
uppercase `SUBI Code` spelling have not all been migrated yet. Preserve real
third-party provider/model names and migrate technical identifiers only with
compatibility and storage checks.

LearnSmart assigned models are one access route, not the entire model catalog.
Retain supported BYOK providers and expose available provider-free and local
models alongside them. Derive free pricing, context limits and tool/image
capabilities from provider/backend evidence; missing pricing is not proof that
a model is free. Provider credentials, availability and rate limits still
apply. LearnSmart-funded requests retain backend account/quota enforcement;
external-provider usage must not be presented as LearnSmart credit usage.

Maintain the upstream source baseline separately from SUBI-specific changes.
Import upstream fixes into a development integration, resolve conflicts, run
account/permission/provider/host regressions, then build a SUBI release. An
OpenCode release must never automatically replace the SUBI executable or
application. The SUBI update feed remains unconfigured and upstream updating
disabled; automated upstream synchronization and SUBI release delivery are
future work, not implemented capabilities.

## Work sequence and evidence

1. Copy the complete upstream source and verify it against the frozen manifest.
2. Install the pinned Bun dependency graph, initially without lifecycle scripts.
3. Isolate SUBI data, desktop identity, launchers and update channels from OpenCode.
4. Remove upstream commercial provider discovery and upgrade UI.
5. Port the existing managed account service closure and its behavioral tests.
6. Connect login/logout, assigned models and credit presentation to native host
   integration APIs. Keep raw Firebase tokens out of rendered UI and logs.
7. Adapt the managed inference protocol to the OpenCode model boundary. Prove
   tools, streaming, cancellation and account restrictions with local fixtures.
   Do not advertise a working managed coding model before that path is tested.
8. Validate the CLI, app and desktop builds in isolated data directories. Native
   Windows qualification does not establish Linux/macOS readiness.

## Current evidence

The source manifest contains 8,559 regular files, 138,023,775 bytes and 35
immediate package directories. Source tree SHA-256:
`6e51469e3f53b2f299cec7d3fde67483a8ab4ddcea65712216ec89929e60bc3c`.
Robocopy completed with exit 1 (copied successfully). Full hash validation is
recorded separately before adaptation: all 8,559 source files and their target
copies matched, with zero hash or size differences. The target later gained
the separate `subi-managed` package, making 36 immediate package directories.

Bun 1.4.2 (744846f84), verified against the official release asset digest,
installed 2,124 packages with `install --frozen-lockfile --ignore-scripts`.
Lifecycle-dependent native assets still require explicit verification.

The account package pins Firebase 12.18.0, matching the existing SUBI SDK
version, and its complete typecheck passes. Desktop now explicitly depends on
the shared utility package that supplies distribution identity.

## Changes implemented so far

- `packages/subi-managed`: ported the existing authentication, access-first
  account bootstrap, models, limits, credits, renewal and purchase service
  closure. Only the managed permission contract was copied; no previous SUBI
  execution or BYOK engine was imported. Firebase uses a named app so another
  SDK application's default Firebase instance cannot supply SUBI identity.
  The new stateless `NativeLearnSmartAuth` transport now supplies Firebase
  password sign-in, account lookup, profile validation and refresh-token
  rotation to the native integration. It rechecks email verification,
  student/teacher role, reset requirements and the saved account UID.
- Native account caller: `ProviderPlugins` registers `subi.account.learnsmart`;
  its existing OAuth method is consumed by CLI/TUI/app integration interfaces.
  A private loopback form collects the password outside chat and the shared
  Form protocol. Native `Credential` owns ID/refresh tokens; only safe profile
  metadata becomes connection information. No separate SUBI credential vault
  or public HTTP schema was added. This reuses native credential storage;
  encrypted-at-rest storage or OS credential protection has not been qualified.
- `packages/util`: SUBI data/cache/config/state/tmp live under `subi-code`.
- App browser storage: physical local-storage keys, IndexedDB drafts,
  cross-window persistence channels, notification claims/locks and PWA routes
  now use SUBI namespaces. Logical native store IDs remain compatible with the
  copied engine. Locale bootstrap reads the same SUBI realm as persistence.
  Shared theme preferences and the startup preload now use SUBI keys too.
- Configuration discovery now stops at the configured home when it contains
  the location, using resolved paths. A regression seeds ecosystem config
  above that home and confirms it is excluded. System configuration and macOS
  managed-preference names are also distinct from the upstream installation.
- CLI: public command/help and session continuation use `subi`; built CLI
  command metadata uses the same name. Upstream update and automatic uninstall
  operations are disabled until SUBI has its own distribution mechanism.
- Core: the built-in OpenCode Console provider and its managed catalog entries
  are removed. Other provider plugins and their BYOK implementation remain.
  Agent identity text now names SUBI Code without changing the execution loop.
- TUI/app: Go/Zen priorities and Go upsell event handling are removed; provider
  selection prefers LearnSmart when it is registered. Coding Plan mode remains.
  Terminal lettering uses the existing SUBI brand; shared web logos reuse the
  original SUBI SVG paths and SUBI wordmark.
- Desktop: distinct app IDs, names, protocol registration and package metadata;
  no upstream update feed or automatic upstream updater. Every packaged build
  requires the locally built CLI. The development download helper rejects
  upstream CLI substitution.

## Native account integration checkpoint — 2026-10-17

The account bridge uses the documented [Firebase Authentication REST API](https://firebase.google.com/docs/reference/rest/auth)
and [Firestore REST authentication](https://firebase.google.com/docs/firestore/use-rest-api).
It implements the existing LearnSmart identity rules without importing the
old execution loop. Firebase client identifiers remain public configuration.
All qualification requests used local fixtures, with no real credentials.

| Boundary                     | Production caller and authority                                                       | Current evidence                                                                                                   | Remaining qualification                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Sign-in                      | Native `Integration` → `LearnSmartPlugin` → loopback form → Firebase identity/profile | 14 transport cases and native account integration tests                                                            | Live LearnSmart and native GUI sign-in not executed                                |
| Persistence/refresh          | Native `Credential` and OAuth refresh method                                          | Saves safe metadata separately from tokens, reloads plugin, rotates tokens, revalidates UID and role               | Full process-restart and OS credential-storage audit pending                       |
| Logout                       | Native integration connection removal                                                 | Removes LearnSmart connection while preserving a BYOK sentinel credential                                          | Native GUI/logout refresh propagation still needs qualification                    |
| Cancellation/replay          | Native OAuth attempt scope and private loopback listener                              | Aborts in-flight sign-in; rejects foreign hosts/origins, oversized forms, late requests and concurrent submissions | Remote-server browser login is not qualified                                       |
| Account service availability | Guarded built-in plugin plus configuration policy                                     | Explicit removals and wildcard removals cannot disable LearnSmart sign-in or policy enforcement                    | Tool permission ceilings are not yet connected                                     |
| Models and billing           | Existing managed configuration client/controller                                      | Prior ported validators and service fixtures pass                                                                  | Production native catalog, credits/renewals UI and inference admission remain open |

No LearnSmart inference provider or selectable managed model is advertised
yet. Successful identity authentication alone grants no managed inference.
The BYOK providers continue to use OpenCode's native runtime.

The first native login integration run exposed an early socket close: settling
the attempt closed its scope before the browser received the response. The
page now flushes before the completion signal settles the native attempt.
The preserved regression passed afterward and in ten isolated test processes.

## Reproduced archive defects

The first full check failed with TS1128 at
`packages/app/src/custom-elements.d.ts`. Its entire content was the relative
path of a symlink target. The supplied source archive contains that same text.
The new project now uses a TypeScript reference to the actual declaration.

A subsequent bounded scan found 42 additional flattened links: public icons,
share images and VS Code icon assets. All resolved to files inside the copied
tree. Their target bytes were materialized in SUBI 2.0, with a repair hash log
outside the repository. No original source files were changed.

## Reproduced browser isolation defects

Browser persistence initially read and removed OpenCode's keys when both apps
used the same origin. Two upstream sentinel regressions failed before the fix.
The shared local-storage wrapper now prefixes every named and default scope
with `subi:`; migration aliases and quota eviction stay inside that realm.
Existing migration, schema, draft, quota and notification-ledger fixtures were
updated to seed SUBI's physical keys. Their behavioral assertions remain.

Direct consumers also shared the PWA route, initial locale and notification
claims. Four assertions failed before those keys were isolated: the upstream
route was restored, SUBI navigation wrote the upstream key, the upstream locale
won, and an upstream claim suppressed SUBI's notification. The fixes preserve
upstream sentinel values and SUBI's duplicate-notification protection.

The theme preload also preferred upstream theme/color/CSS keys. Five assertions
failed before its shared keys and preload were changed together; seven cases
then passed ten repeats. Actual native theme interaction remains unexecuted.

## Checks completed

Commands below use the verified Bun 1.4.2 executable; `bun` is shorthand for
that executable, not a global toolchain installation.

| Working directory       | Command                                                                                                                                                                                                                 | Result                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| repository root         | `bun install --frozen-lockfile --ignore-scripts`                                                                                                                                                                        | 2,124 packages installed                                                           |
| repository root         | `bun install --ignore-scripts` after managed package addition                                                                                                                                                           | 65 packages installed; lockfile saved                                              |
| `packages/util`         | `bun test test/global.test.ts`                                                                                                                                                                                          | 3 passed; the new isolation assertion failed before the directory fix              |
| `packages/subi-managed` | `bun test`                                                                                                                                                                                                              | 62 passed across 5 files                                                           |
| `packages/subi-managed` | `bun typecheck`                                                                                                                                                                                                         | passed                                                                             |
| `packages/core`         | `bun run script/test.ts test/plugin/models-dev.test.ts`                                                                                                                                                                 | 13 passed                                                                          |
| `packages/app`          | `bun test --conditions=solid --isolate --preload ./happydom.ts ./src/session/usage-exceeded-dialogs.test.ts`                                                                                                            | 4 passed                                                                           |
| `packages/tui`          | `bun test --timeout 30000 --only-failures test/util/presentation.test.ts test/prompt test/mini/prompt.editor.test.ts test/clipboard.test.ts test/cli/tui/dialog-integration.test.tsx test/cli/tui/prompt-move.test.tsx` | 102 passed across 19 files                                                         |
| `packages/tui`          | `bun test --timeout 30000 --only-failures test/cli/cmd/tui/integration-options.test.ts test/cli/cmd/tui/model-options.test.ts`                                                                                          | 13 passed                                                                          |
| `packages/tui`          | `bun test --timeout 30000 --only-failures test/session-home.test.tsx`                                                                                                                                                   | 17 passed                                                                          |
| `packages/cli`          | `bun test --timeout 30000 --only-failures test/auth-login-choices.test.ts test/auth-form.test.ts test/mcp-auth-choices.test.ts`                                                                                         | 17 passed                                                                          |
| `packages/desktop`      | `bun test --timeout 30000 src/main/lifecycle/deep-link.test.ts`                                                                                                                                                         | 2 passed                                                                           |
| `packages/desktop`      | `bun test --timeout 30000 scripts/subi-distribution.test.ts`                                                                                                                                                            | 4 passed                                                                           |
| repository root         | `bun run check` after archive repair                                                                                                                                                                                    | lint passed; 36 typecheck tasks successful, 17 cached; 41 packages in scope        |
| repository root         | `bun run check` after browser isolation fixes (`root-check-storage.log`)                                                                                                                                                | 36 tasks passed; 0 cached; lint reported 1,309 warnings and zero errors            |
| `packages/cli`          | `bun run src/index.ts --help` with isolated HOME/USERPROFILE/XDG roots                                                                                                                                                  | exit 0; displays `subi`                                                            |
| `packages/app`          | `bun run build` before browser storage changes                                                                                                                                                                          | passed; native GUI execution not performed                                         |
| `packages/app`          | `bun run build` after browser storage fixes (`app-build-storage.log`)                                                                                                                                                   | passed; 1,616 PWA entries, 35,214.16 KiB; native GUI execution not performed       |
| `packages/app`          | `bun run test` after shared browser storage fix                                                                                                                                                                         | 760 unit + 173 browser-condition tests passed; browser tests use happy-dom         |
| `packages/app`          | `bun run test` after all direct browser storage fixes                                                                                                                                                                   | 760 unit + 175 browser-condition tests passed; 108 + 41 files                      |
| `packages/app`          | six affected browser persistence suites with configured browser conditions/preload                                                                                                                                      | 53 passed                                                                          |
| `packages/app`          | configured unit runner, `src/runtime/persistence/storage.test.ts`                                                                                                                                                       | 8 passed; upstream sentinel values preserved                                       |
| `packages/app`          | configured browser runner, `test-browser/distribution-storage.test.ts test-browser/pwa-route.test.ts --rerun-each 10`                                                                                                   | 80 passed; 8 distinct cases repeated ten times                                     |
| `packages/subi-managed` | `bun test --only-failures` including native authentication                                                                                                                                                              | 76 passed across 6 files                                                           |
| `packages/subi-managed` | `bun typecheck` after native authentication                                                                                                                                                                             | passed                                                                             |
| `packages/core`         | `bun typecheck` after native authentication                                                                                                                                                                             | passed                                                                             |
| `packages/core`         | native account suite in 10 consecutive isolated `script/test.ts` processes                                                                                                                                              | all 10 exited 0; 3 cases per process                                               |
| `packages/core`         | native account suite after adding concurrent submission coverage, `--rerun-each 10`                                                                                                                                     | 40 passed; 4 distinct cases                                                        |
| `packages/core`         | integration, credential, catalog and native account regression group                                                                                                                                                    | 37 passed across 4 files before concurrent-submission case addition                |
| `packages/app`          | configured unit runner, theme preload, `--rerun-each 10`                                                                                                                                                                | 70 passed; 7 distinct cases                                                        |
| `packages/app`          | configured browser runner, Playwright configuration, `--rerun-each 10`                                                                                                                                                  | 90 passed; 9 distinct cases                                                        |
| `packages/app`          | full `bun run test` after account/theme/config-test changes                                                                                                                                                             | 761 unit + 175 browser-condition tests passed                                      |
| repository root         | `bun run check` after account/theme changes (`root-check-account.log`)                                                                                                                                                  | 36 tasks passed, 27 cached; later core configuration fixes require another check   |
| repository root         | focused `oxlint --deny-warnings` over seven new/changed account/config fixtures                                                                                                                                         | zero warnings/errors                                                               |
| `packages/cli`          | `bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-qualification` with dev version 2.0.0-dev.0                                                             | native build passed; CLI-only, no embedded app; predates later configuration fixes |
| compiled Windows CLI    | `--help` and `auth list --standalone --format=json` under fresh HOME/USERPROFILE/XDG/DB roots                                                                                                                           | both exit 0; SUBI help, empty account list                                         |

## Broad core qualification and defect triage

The first complete copied-core suite executed 6,685 cases across 266 files:
**5,190 passed, 1,480 skipped, 15 failed**. This was a real failed baseline,
not a release pass. The skips do not qualify their unavailable capabilities.

- Unix `sleep` and shell-specific `echo`/`printf` made three fixture groups
  fail on Windows. Their portable replacements retain the same live-process,
  exact-output and subagent/prompt assertions.
- The core isolation fixture still expected `opencode` XDG paths, and its
  runner set the old config root. Both now consistently use `subi-code`.
- The recorded request still named OpenCode in its identity instruction.
  Only that identity text was adapted; the recorded response was retained and
  replay subsequently passed without live inference or rerecording.
- The evicted-subagent observer cases passed in a focused run but hit their
  redundant 2-second internal deadline under load. They now await the same
  model-request signal within their existing 20-second test budget. All
  exactly-once notification, cancellation and request-count assertions remain.
- Configuration discovery crossed the configured home into another profile's
  ecosystem directories. A fixture-owned parent sentinel reproduced this
  independently of installed user configuration. The shared discovery fix
  bounds that walk at the configured home; assertions were preserved.
- Supervisor assertions about a mandatory upstream Console connection were
  replaced by the product requirement: mandatory LearnSmart sign-in and policy
  enforcement, with the upstream Console absent. The native account plugin is
  now guarded against repository removal directives.
- The native PowerShell oracle exceeded its unchanged 45-second child budget
  during the concurrent suite. It already used one child, but traversed each
  AST three times. One traversal now collects the same command and execution
  exclusions. Standalone local duration changed from 35.13s to 17.05s with all
  25 cases/99 assertions passing; this is an observation, not a speed guarantee.

Affected follow-ups: Windows daemon/isolation fixtures passed 100 executions
(10 cases repeated ten times); context/command/worker/recorded tests passed 56
cases; configuration/supervisor/spawn tests passed 83 cases with one skip.
The complete fixed core suite finished with **5,205 passed, 1,480 skipped,
zero failed**, 101,940 assertions across 266 files (`bun run test` in core;
`core-full-account-fixed.log`). The skipped capabilities remain unqualified.
The first complete CLI run reported 289 passed, 10 skipped and 40 failed;
its findings and current follow-ups are recorded below.

The earlier focused migration suites contain 237 test cases. They are not the full repository
test suite. Catalog, UI and SDK fixtures do not establish successful live
managed inference or native GUI execution. The fresh canonical check passed
all 36 tasks; it was not warning-free. One new spacing warning in the sentinel
test was corrected after that lint phase. The new distribution-storage fixture
also passed focused lint with `--deny-warnings` (zero warnings/errors).

The initial broad app run exposed old physical-key fixture assumptions and two
5-second Playwright-config child-process timeouts. After fixture adaptation,
the next complete app run passed without changing timeouts or removing cases.
These are configuration subprocess tests, not native browser qualification.

Two Go preference persistence tests were removed with the explicitly removed
upsell feature; the ChatGPT/BYOK usage-limit cases remain. The reasoning-variant
fixture now uses an independent MiniMax provider instead of a removed Go
provider, preserving the same variant assertions. Commercial-priority tests
now assert LearnSmart ordering while retaining BYOK/MCP ordering and stable IDs.

## Shared service and CLI follow-up

A failing local HTTP sentinel fixture reproduced a client isolation defect:
default discovery still read `opencode/service.json`, and both client ports
defaulted to launching `opencode`. The shared fallback now reads
`subi-code/service.json`; both default commands are `subi`. The regression
checks that neither client probes the upstream sentinel, that both discover
the SUBI registration and that the upstream file remains byte-for-byte intact.
It passed ten repetitions plus ten consecutive isolated processes. A focused service group passed 61 cases with four
platform skips; that diagnostic command used a 30-second budget. The later
configured five-second complete client run exposed a fixture race and must be
rerun before treating the complete client package as passing.

ACP now advertises `SUBI Code` and launches `subi auth login`; the stable
`opencode-login` protocol ID and child-session protocol relationships remain.
An updated wire regression failed before this change and passed afterwards.

The initial CLI failures included obsolete brand/path expectations and an
unavailable Unix `mktemp` fixture. Fixtures now use SUBI paths and portable
temporary directories, retain the same behavioral assertions and give child
processes private configuration roots and `USERPROFILE`. The debug-path
fixture explicitly sets its own config override rather than inheriting the
outer qualification profile. LearnSmart priority replaces the removed Go/Zen
commercial ordering while preserving stable BYOK ordering.

The old upstream installer tests expected npm/Homebrew/WinGet downloads that
SUBI intentionally disables until its own feed exists. Those assertions encode
the removed upstream distribution architecture; the reference source retains
them. Their replacement covers every supported updater method and automatic,
manual and direct-apply entry points, requiring no network/installer dispatch,
no removal command, no completion callback and unchanged executable bytes.
It reproduced exposed removal/direct-apply paths before their guards were
added. Nine cases passed ten repetitions (90 executions, 550 assertions).
Updater, ACP and mini configuration tests passed 15 cases together. No real
package-manager install or account change was performed.

The configured client run (225 passed, four skipped, one failed) caught shared
fixture output overwritten by competing handoff candidates. The environment
fixture now elects one owner, records all started PIDs for cleanup and writes
process-specific output; assertions read the elected PID's environment/ticket.
No production handoff logic or assertion was relaxed. The targeted handoff
regression passed ten repetitions under the configured five-second budget;
the complete configured client rerun passed **226 cases, four skipped, zero
failed**, 912 assertions across 22 files.

The targeted CLI follow-up passed its actual service election, port, CORS,
stale-registration, failed-start and shutdown cases. It also reproduced a
debug-path environment assumption and upgrade-fixture cold-transpilation
timeouts during simultaneous builds. The former now explicitly owns its
configuration override; the latter now uses the prescribed `isolatedEnv`
shared transpiler cache, retaining the original 30-second budget. The final
complete configured CLI rerun passed **305 cases, eight skipped, zero failed**,
1,156 assertions across 50 files in 234.12 seconds (`bun run test` in CLI;
`cli-full-configured-fixed.log`). Seven skips are the pre-existing real-service
lifecycle suite disabled on Windows; they do not qualify those scenarios.

Fresh `bun run check` passed all 36 tasks (41 packages in scope), with 1,307
lint warnings and zero errors; it is not warning-free. A separate
focused lint pass over eight changed source/fixture files reported zero
warnings and errors. Final client and CLI package typechecks also passed after
the last fixture edits. `git diff --no-index --check` against the untouched
reference source passed for 17 existing files changed in this follow-up;
there is no `.git` checkout in the copied target.

`bun run build` in app completed successfully. The Windows x64 baseline CLI
build also passed:

```text
OPENCODE_CHANNEL=dev OPENCODE_VERSION=2.0.0-dev.0
bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-qualification
```

The artifact is still an internal `bin/opencode.exe`, with public help naming
`subi`. Its SHA-256 is
`6C1D80978B2DECB505D79A858C948367FE53D0FFDCFDDE99CC4E9EC2124E76E6`.
It is a development CLI-only build without an embedded web UI, not an installed
or release-qualified package. Fresh private-profile `--help` and standalone
authentication-list smoke checks passed in an empty temporary workspace and
in the full SUBI source project with file watchers enabled. The authentication
list was empty; no live account or model invocation was used.

An earlier simultaneous-build smoke check hit the existing five-second
server plugin-activation gate (`Location plugins did not finish activating`).
Later successful checks do not qualify startup under resource pressure or
erase that observation. Load-sensitive startup remains an explicit release
qualification gap. Build success cannot qualify GUI interaction, managed
inference, live providers or the Windows-skipped lifecycle suite.

## Required work still open

- Qualify the new native LearnSmart method through actual CLI/TUI/app login
  interactions and a full process restart. API-level fixtures and plugin reload
  are established; they do not prove a native GUI or real-account lifecycle.
- Bind account/model/permission updates to every active native location and
  invalidate managed authority on logout, expiry and account changes. The
  copied permission type currently enforces no native tool boundary.
- Add the managed inference adapter. The old `/agent/turn` endpoint owns a
  frozen tool catalog and uses a custom SSE/canonical-turn protocol. It is
  not an OpenAI-compatible base URL. Native OpenCode tools cannot safely be
  advertised as supported until protocol translation or a compatible backend
  route is implemented and qualified.
- Connect safe account displays, assigned-model names/context, school limits,
  individual credits and purchase/renewal refresh actions to the hosts.
- Complete channel-specific icons, remaining brand text, installation
  launchers, VS Code integration and packaging. Internal `@opencode/*` scopes
  remain for runtime compatibility; they are not a SUBI publishing namespace.
- Qualify native theme changes and finish remaining branding. Shared theme
  storage/preload isolation is fixed, but all copied packages have not yet been
  qualified.
- Finish desktop/VSIX builds, native interaction fixtures and the remaining
  applicable suites. App and CLI qualification builds have passed; they do not
  qualify installed hosts. No new CLI, VSIX or desktop package has been
  installed over the user's existing applications by this migration.

Release verdict: **NOT READY**. Account lifecycle qualification, account-state
and permission binding, managed inference and distribution qualification remain
open. The latest requested roughly 30% progress
estimate describes engineering scope, not a measured release score. Source-copy
completion does not establish working product integration.

Large logs and baseline manifests are outside the repository under
`C:\Users\Admin\AppData\Local\Temp\subi2-20261017` and
`C:\Users\Admin\AppData\Local\Temp\subi-opencode-migration-20261017-1204`.

This is a migration in progress, not a release-readiness claim. No live
inference, billing changes, deployment, publishing or normal-profile account
changes are part of this work.

## 2026-10-17 provider branding and native sign-in follow-up

The user's browser reported **`Invalid sign-in origin.`**. The private loopback
form supplied `Referrer-Policy: no-referrer`, which causes a browser's form
navigation POST to serialize its Origin as `null`. The strict same-origin POST
check correctly rejected that request. The form now supplies
`Referrer-Policy: same-origin`; the Host, nonce path, content type, body bound,
single-use attempt and exact Origin checks remain enforced. Literal `null` and
foreign origins remain rejected. This follows the
[Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header).

The existing native integration fixture first failed on the old response
policy (`learnsmart-origin-before.log`). After the fix, four actual local HTTP
integration cases passed ten repetitions: **40 executions, 320 assertions,
zero failures**, in `learnsmart-origin-after-repeat.log`. These cover connection,
credential persistence/reload/refresh/logout, concurrent requests, replay,
foreign Host/origins, oversize requests and cancellation. Firebase responses in
these fixtures come from an owned temporary server; neither a browser nor a
live LearnSmart account was qualified. The browser error is reproduced at its
response-policy boundary, not through browser automation.

Public product identity is now `Subi Code` in `packages/util/src/product.ts`.
CLI help and packaging expose `subi`; new native builds emit `bin/subi.exe`.
The CJS launcher accepts only `SUBI_BIN_PATH` as its product override and
ignores inherited `OPENCODE_BIN_PATH`. Internal workspace scopes, protocol IDs,
target selectors and desktop sidecar resource names retain compatibility.

The TUI home/session/plugin terminal titles and notification default title use
the shared product identity. Compact mode now uses `[S]`, `subi mini` and
`subi mini -s ...`, preserving narrow-width and complete-command behavior.
The existing splash fixture retained width/color/metadata/property assertions;
its focused rerun passed **30 cases, 57,309 assertions**. The first complete
branding TUI run exposed two obsolete wide-logo assertions (1,480 passed,
12 skipped, two failed); those were repaired to assert the new SUBI glyph.
The earlier full lifecycle check passed **32 cases, two skipped**; three
title/rename/SIGHUP cases passed ten repetitions (**30 executions**).

Provider attribution now uses Subi Code and the LearnSmart website for
OpenRouter, NVIDIA, Kilo, LLM Gateway, Vercel and Zenmux. Cerebras integration
and OpenAI originator headers use `subi`. Explicit custom provider headers are
preserved. Shared success/error/pending OAuth pages, including their actual
JavaScript completion flow, show Subi Code. Initial ChatGPT registration uses
`agent_name_hint=Subi Code` with the documented `dynamic_agent_client` flow;
issued client IDs continue to be persisted and reused. See the
[official ChatGPT registration contract](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#2-register-the-client-during-sign-in).
Saved registrations may retain their existing provider-hosted name; no existing
credential was deleted or revoked to force a cosmetic re-registration.

The user explicitly confirmed that Subi Code OAuth registrations for GitHub
Copilot, GitLab, xAI and DigitalOcean will be created later. Their existing
client IDs and registration-specific attribution are retained for now.
Provider-hosted consent text cannot be changed by replacing local HTML. Actual
provider names, third-party service names and legal notices are not rewritten
as invented SUBI services. Live external sign-in remains unqualified.

Changed provider/app/OAuth fixture group: **66 passed, zero failed**, 302
assertions across 12 files (`all-provider-brand-after.log`). Launcher, ACP,
mini and remote-pairing group: **28 passed, zero failed**, 131 assertions across
five files (`cli-brand-focused.log`). Desktop channel IDs/product names and
distribution configuration: **11 passed, zero failed**, 192 assertions
(`desktop-brand-distribution-fixed.log`); this is configuration coverage, not
native desktop execution. The real catalog fixture retained external free,
paid, unknown-price and local models without LearnSmart authentication:
**14 passed, zero failed**, 114 assertions (`free-external-local-catalog.log`).
Catalog presence does not establish available inference or free access.

The development build in `dist/subi-branding-20261017` is version
`2.0.0-dev.1`. Its help/version/private standalone auth-list smokes passed;
it predates the sign-in origin correction and must not be used to qualify it.
The older `dist/subi-qualification/.../bin/opencode.exe` also predates these
changes. Neither output has been installed globally. A separate new build is
required for the corrected sign-in page; do not overwrite an executable the
user may still be running.

Remaining source audit findings include copied desktop/web localization,
onboarding/crash/update copy and upstream documentation links. Some names
identify real upstream services or technical compatibility contracts, while
other strings still need SUBI branding. The compact model footer also retains
an upstream-provider-specific free badge. These findings are open, not PASS.
This checkpoint does not complete the account ceilings, credits, native managed
inference, desktop/VSIX qualification or platform release gates listed above.

### Native login build and account display integration

Version `2.0.0-dev.2` was built into
`packages/cli/dist/subi-login-fix-20261017/cli-windows-x64-baseline/bin/subi.exe`.
Its private-profile native checks passed help/version/empty-auth, the real
compiled LearnSmart sign-in page's `same-origin` and `no-store` headers,
rejection of two hostile Origin values, and listener cleanup when the owner
exited (`native-login-v2-smoke.log`). The user subsequently confirmed login
worked, then reported that assigned models, limits and credits were missing.
That was an integration gap: the native login method had no caller for the
ported managed account bootstrap.

An additive per-location plugin RPC contract, `subi.learnsmart.account.get`,
now connects the existing native credential resolver to the existing validated
`LearnSmartManagedService` and `ManagedSessionController`. No `HttpApi` shape,
generated client, storage schema or external dependency was changed. The shared
minimal browser-safe snapshot contract lives in
`packages/schema/src/learnsmart-account.ts`; the existing RPC transport carries
it. This is a necessary addition for the reproduced missing account-data
boundary, rather than a replacement agent architecture.

Production path:

```text
TUI builtins -> /account / command palette -> AccountPage.load
-> client.rpc(LearnSmartAccount.Contract).get
-> Server RpcHandler (await native plugin activation)
-> LearnSmartPlugin / registerLearnSmartAccount
-> native integration.connection.active + resolve (including token refresh)
-> ManagedSessionController.bootstrap
-> /managed/access-status first
-> /managed/models + /managed/monthly-limit
-> /managed/subicode-status + /managed/usage
-> whitelisted snapshot -> account screen
```

The screen shows backend-assigned model **names** and context sizes, school
token allowance/usage/remaining tokens, or individual credit balances and
renewal status. It includes the existing trusted purchase/renewal destinations
and an `r` refresh action. Unknown balances stay unknown. Values are read from
the backend rather than reconstructed as limit-minus-usage. Each read obtains
fresh credentials and fetches fresh account data; no credit or quota snapshot
is persisted as authority. Logout/account switch abort pending account reads;
the final connection check discards a response produced for a replaced account.
The UI cancels obsolete requests and clears its prior display before reload.
Opening no account screen incurs no managed-account HTTP request.

Access denial does not load models/limits/usage. The existing controller does
make a best-effort subscription-status request while denied, to retain renewal
context without granting access; the new regression preserves that behavior.
Malformed managed model data is rejected. Tokens, provider model IDs and host
permission policy are excluded from the snapshot. The new RPC is display data,
not a tool-authorization boundary.

Regression before wiring: two native account cases failed with
`rpc.unavailable` (`native-account-before.log`); two terminal cases failed
because `/account` was absent (`account-tui-before.log`). After wiring, four
native account cases passed ten repetitions (**40 executions, 460 assertions**)
for school/individual data, denied/corrupt responses, logout and account switch
during a held real local HTTP request (`native-account-races-repeat.log`).
Two terminal cases passed ten repetitions (**20 executions, 160 assertions**)
at 100 and 44 columns, checking refresh, model names/context, credit/token
display, removal of obsolete data and navigation (`account-tui-repeat.log`).
These use an owned backend fixture and the OpenTUI test renderer, respectively;
they are not real-account or native terminal interaction qualification.

Focused lint across eight new/changed contract/core/TUI files passed with zero
warnings/errors. Core's source-and-test typecheck and the TUI typecheck passed.
The latter first caught a missing `created` timestamp in the sign-out event
fixture; the fixture now uses the complete existing event contract. Importing
the ported controller under core's compiler also exposed two pre-existing
unused type imports, which were removed.

The configured full CLI suite passed **308 cases, eight skipped, zero failed**,
1,162 assertions across 51 files (`cli-full-login-brand.log`), before the new
account integration. The first full TUI rerun after compact copy changes passed
1,475, skipped 12 and failed seven: six obsolete brand expectations and one
intermittent plugin-dialog test that submitted before input/layout settled.
The expectations were updated without removing behavioral assertions. The
dialog fixture now waits for its real input focus and visual idle, preserving
its original budget; its four race cases passed ten repetitions (**40
executions, 420 assertions**, `plugin-dialog-idle-repeat.log`). A focus-only
attempt had still failed once out of 40 and is retained in the external log.
The final full account TUI/root-check runs are recorded separately when done.

Version **`2.0.0-dev.3`** is the account display development artifact:

```powershell
& "D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-account-20261017\cli-windows-x64-baseline\bin\subi.exe" --standalone
# Then enter /account in the terminal UI.
```

Build command: `OPENCODE_CHANNEL=dev OPENCODE_VERSION=2.0.0-dev.3 bun run
script/build.ts --target=opencode-windows-x64-baseline --skip-install
--skip-web-ui --outdir=dist/subi-account-20261017` (from CLI).
SHA-256: `73B536EBEA781E83FB9CCAFC00AE5B2809044D9AB9F595578B07B86C89EC5C0B`.
Fresh private-profile native help/version/empty-auth/sign-in policy/shutdown
checks passed, along with a request to the **compiled server's actual account
RPC** returning the safe signed-out snapshot (`native-account-v3-smoke.log`).
The first native RPC smoke used a JSON-valued location query and correctly got
400; the harness now uses the protocol's `location[directory]` serialization.
No production query parser was changed to accommodate a harness error.
No paid inference, real-account API call, install or profile migration ran.

**Mapped inference remains open.** Account assignments are visible in
`/account`; they are not yet selectable native inference providers. The wire
explicitly reports `inferenceAvailable: false`, and the screen explains this.
The backend's `/agent/turn` accepts its own canonical protocol and supplies its
own tool schemas/system prompt; its `/chat` is text-only. Neither is a native
OpenAI-compatible transport for the copied agent. Adding a model row alone
would produce a nonfunctional coding choice and would not bind account
permission ceilings. The managed transport and native account permission
enforcement need implementation and qualification before claiming those models
work for coding. Desktop/web account screens remain unbound as well.

### Free provider catalog and current verification result

The user confirmed that `/account` now shows their live school allowance,
usage, renewal and assigned models. Their model picker remains empty for
LearnSmart because catalog display and managed inference are distinct native
boundaries. Do not classify the latter as fixed. The user then explicitly
requested OpenCode's free models only, without Go/Zen upgrades after limits.

`ModelsDevPlugin` now retains the `opencode` catalog only for active text
models with a nonempty price definition whose input, output, cache read/write
and every tier are zero. The provider is keyless, displayed as `Free models`,
activated with the upstream public credential, and registers no Console or Go
sign-in. `opencode-go`, paid entries and unknown prices remain excluded.
The existing catalog refresh machinery reapplies this filter on new catalogs.
Other providers retain ordinary BYOK behavior. Upstream service URLs and real
provider attribution remain accurate; this is not a SUBI-hosted free service.

The normalizer previously defaulted a missing cost to zero for all providers.
A new raw-catalog regression first failed on that behavior; the OpenCode
normalization branch now preserves a missing cost as an empty/unknown price
list so it cannot pass the free filter. Other providers retain existing
compatibility. This follow-up is after the `dev.4` binary described below.

An isolated provider hook replaces OpenCode free-provider HTTP 402/429 response
copy with a neutral free-model limit message. HTTP status and Retry-After are
retained; stale content encoding/length headers are removed. Successful
responses and other providers are unchanged. No auto-switch or paid sign-in
occurs. The four success/limit/provider-isolation cases passed ten repetitions:
**40 executions, 200 assertions**, `free-limit-repeat.log`. The free catalog
test rejects missing prices, paid input/output/cache and paid context tiers.
The complete focused catalog/account/provider group passed **27 cases**, 212
assertions (`free-account-after.log`). These are local fixtures; no inference
request was sent to a public free endpoint.

An unauthenticated read of `https://models.opencode.ai/api.json` found 44
zero-price records, of which ten were non-deprecated at observation time
(`public-free-catalog.json`, checked 2026-10-17). The native compiled server
catalog independently returned **ten free models, zero Go models**. Native
help/version/private empty-auth/account RPC/sign-in policy/shutdown smokes
passed as well (`native-free-v4-smoke.log`). Catalog discovery does not prove
live model response availability or capacity.

The free-catalog development executable is **`2.0.0-dev.4`**:

```powershell
& "D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-free-models-20261017\cli-windows-x64-baseline\bin\subi.exe" --standalone
```

Build command used the same isolated Windows baseline flags with
`OPENCODE_VERSION=2.0.0-dev.4 --outdir=dist/subi-free-models-20261017`.
SHA-256: `8F5E29E40A61A1CCC7C4044B8BB0DA246350BE6BE29E08EAC9709BB25D5145EA`.
It includes account display and the initial free filter, but predates the
normalizer's unknown-price correction. It is not globally installed and has
no embedded web UI. Managed LearnSmart inference is still unavailable.

The final configured account TUI run passed **1,484 cases, 12 skipped, zero
failed**, 107,994 assertions and two snapshots across 174 files in 250.04s
(`tui-full-account-final.log`). A fresh canonical root check passed all 36
tasks (41 packages), with existing lint warnings (`account-root-check.log`).
After the free-provider changes, 21 focused TUI account/model/tool-label cases
passed (`tui-free-account-focused-fixed.log`). An attempted rename of the real
OpenCode web-search provider label to `Free models` was reverted: it described
a different provider capability and would have misrepresented attribution.

The configured full core run exposed **13 failures**: 5,213 passed, 1,475
skipped, 13 failed across 268 files/6,701 cases, 101,292 assertions, 667.25s
(`core-full-account-free.log`). Eleven failures were old product User-Agent or
client-name expectations. Those exact expectations now assert `subi` while
preserving session correlation, compaction, title, OAuth refresh and Copilot
header assertions. Their six affected files passed **343 cases, zero failed**,
1,601 assertions, 21.72s (`core-brand-regressions-fixed.log`), including the
raw missing-price normalization regression.

The remaining failures were a pending organization-plugin reload and the
PowerShell parser oracle's existing 45-second subprocess timeout. The reload
case passed **ten executions, 40 assertions** on an unchanged isolated rerun
(`organization-reload-repeat.log`). The actual PowerShell oracle suite passed
**25 cases, 99 assertions**, 26.10s in isolation
(`powershell-oracle-isolated.log`), without changing its timeout or assertions.
These reruns do not establish a passing full concurrent core suite; load/race
qualification remains open. No failing assertion was suppressed or skipped.

Source checkpoint hashing observed **zero changes to all 8,559 original
OpenCode source files**. At that checkpoint 195 copied files differed, and
`git -c core.autocrlf=false diff --no-index --check` reported no whitespace
errors across those modified existing files (`source-checkpoint.json`). This
checkpoint predates the newest free-provider edits; it is not a final manifest.

Current verdict remains **NOT READY**. Account data and free-catalog discovery
have evidence; LearnSmart selectable coding inference, native account ceiling
enforcement, installed GUI/VSIX parity and full concurrency qualification do not.

### Current native checkpoint: 2.0.0-dev.5

The current source was rebuilt successfully with pinned Bun 1.4.2 using
`bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-free-pricing-fix-20261017`
with `OPENCODE_CHANNEL=dev` and `OPENCODE_VERSION=2.0.0-dev.5`.
The executable is
`D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-free-pricing-fix-20261017\cli-windows-x64-baseline\bin\subi.exe`.
SHA-256: `81EC1520A897828F5A6690CDEA88D0CBEE5BABE18E860ECBA40CF5E5280A3FC2`.
This build includes the missing-price correction and restored web-search attribution.

The compiled Windows executable passed private-profile help/version, empty-auth,
local sign-in page, same-origin policy, rejection of two foreign/null origins,
owned-listener shutdown and unauthenticated account RPC checks. Its real native
model catalog contained **10 free models and zero Go models**, with **zero
inference calls** (`native-free-v5-smoke.log`). Live account execution was
unexecuted in this isolated smoke. This is a CLI development artifact, not a
global installation or a GUI/VSIX qualification.

The final canonical `bun run check` passed **36/36 tasks**, 30 cached, in
56.398s (`free-final-root-check.log`); existing lint warnings remain. The latest
source checkpoint found 203 changed copied files, zero changes to the 8,559
original OpenCode source files, and zero whitespace errors for modified existing
files (`source-checkpoint.json`). These counts exclude newly added files.

The release verdict remains **NOT READY** for the unresolved requirements above.

### Hosted free-tier rejection: current evidence supersedes catalog discovery

The user's next screenshot demonstrated a real request failure after selecting
DeepSeek V4.1 Flash Free. Catalog discovery did not establish inference access;
the earlier ten-model smoke must not be interpreted as ten working models.

A single bounded request to the current public catalog's explicitly zero-priced
`deepseek-v4.1-flash-free` endpoint reproduced **HTTP 403**, with error type
`FreeTierError` and the provider's statement that its free tier is restricted to
OpenCode. The request identified itself as `subi/dev/2.0.0-dev.5/subi`, sent a
stable session ID, used only the public credential, and requested at most 16
output tokens. No private account or repository content was sent and no paid
call was made. Evidence: external `free-access-probe.ts` and
`free-access-probe.json`; the other nine catalog entries were not inference
qualified. This is an observed access denial, not a context-window, quota or
model-list parsing error. Source-code reuse does not establish hosted service
access. No client identity spoofing or restriction bypass was added.

The smallest shared-core correction changes `ModelsDevPlugin`'s OpenCode
zero-price provider definitions to `activation: disabled`; they no longer appear
as keyless default/available models. Definitions still exclude unknown prices,
paid input/output/cache tiers, deprecated models and Go. Existing connected
external providers and their free/local model definitions retain their existing
behavior. Explicit user configuration can still override provider activation,
but it does not override the provider's remote access decision.

`FreeModelsPlugin` recognizes only the provider's typed `FreeTierError` on 403
and presents an accurate unavailable-to-Subi-Code message. It preserves 403,
keeps this distinct from quota exhaustion, and adds no download/Go/Zen upgrade
prompt. Unrelated 403 responses and other providers remain unchanged. Existing
402/429 neutral limit handling remains covered. Regression changes are in
`packages/core/test/plugin/models-dev.test.ts` and
`packages/core/test/plugin/provider-free-models.test.ts`; production changes are
their owning `src/plugin/models-dev.ts` and `src/plugin/provider/free-models.ts`.

Before the correction, the two new behavioral assertions failed: restricted
provider activation and the 403 diagnostic (`free-access-before.log`: 20 passed,
two failed). An initial follow-up assertion incorrectly used `Model.get` to
inspect a disabled provider; this was corrected to inspect the authoritative
provider definition snapshot while preserving the no-available-model assertion.
The affected two files passed **220 executions, zero failed, 1,500 assertions**
using `bun run script/test.ts test/plugin/models-dev.test.ts test/plugin/provider-free-models.test.ts --rerun-each 10`
from `packages/core` (`free-access-after.log`). The integrated catalog, free
provider, LearnSmart auth/account and stateless generation suites passed
**33 cases, zero failed, 235 assertions** across five files
(`free-access-integrated.log`). Canonical root `bun run check` passed **36/36
tasks**, 30 cached, 53.056s (`free-access-root-check.log`); existing warnings
remain. The full concurrent suite was not rerun for this focused correction;
its previously documented qualification gaps remain open.

The current development artifact is **2.0.0-dev.6**:

```powershell
& "D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-access-fix-20261017\cli-windows-x64-baseline\bin\subi.exe" --standalone
```

SHA-256: `F869A9E5DA313C39919DE1603A2A111B990152C9E6A9F2FCE77C7667FA823F58`.
Build command: `bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-access-fix-20261017`,
with `OPENCODE_CHANNEL=dev` and `OPENCODE_VERSION=2.0.0-dev.6`.
The compiled executable passed isolated help/version, empty auth, owned login
page/origin/shutdown, signed-out account RPC and actual native catalog checks.
The catalog correctly exposed **zero restricted OpenCode models and zero Go
models** (`native-free-v6-smoke.log`), with zero inference calls in that smoke.
No global installation, extension update, embedded web UI or live LearnSmart
account qualification is included in this artifact.

The LearnSmart follow-up was qualified with the existing backend's real pure
validator: the legacy request was accepted, a native chat-completion request
was rejected, and a superficially translated history containing native `bash`
was also rejected. The external `managed-native-contract-probe.cjs` performed
zero store/network calls and changed no backend files. Evidence is in
`managed-native-contract-probe.json`. A compatible backend contract and native
adapter are still required; the managed picker must remain unavailable until
streaming, tool execution, fresh permission ceilings, cancellation, replay and
quota/credit settlement are demonstrated. This correction does not implement
that integration or make the release READY.

### Native LearnSmart gateway: implemented and deployed October 17

This section supersedes the account-only limitation above. On the user's
explicit instruction to deploy and enable the integration, the staged backend
was deployed from `integrations/learnsmart/functions-subi`. The original
LearnSmart backend and original OpenCode checkouts remain read-only.

The shared client adapter in `packages/core/src/plugin/learnsmart-native.ts`
discovers protocol support on the application-owned gateway before publishing
assigned coding models. It uses the existing native provider SDK, session
execution, tool and permission services. Token-bearing requests are pinned to
the owned endpoint. Fresh account permission ceilings constrain mutations and
commands, and changing credentials interrupts affected sessions. Catalog refresh
is serialized; an observed overlapping-refresh defect previously produced an
empty catalog intermittently and is covered by repeated regressions. Pending
approval now reevaluates permission rules before allowing execution; the new
revocation regression failed before the shared permission fix.

The backend accepts bounded native text/tool manifests through the existing
managed agent route. It preserves the school/individual access, subscription,
assigned-model, capability, quota/credit, reservation, dispatch and settlement
checks. The backend never executes workspace tools. Executable tool calls are
withheld until settlement succeeds; malformed histories and replay are rejected.
The native capability gate is disabled unless
`SUBI_NATIVE_AGENT_ENABLED=1`. Deployment supplies this nonsecret setting through
an ignored dotenv file, retaining the pre-existing user environment setting.

Current qualification:

- `bun run script/test.ts test/plugin/provider-learnsmart-native.test.ts test/plugin/provider-learnsmart.test.ts test/plugin/provider-learnsmart-account.test.ts test/permission.test.ts test/session-model-request.test.ts --rerun-each 10`
  from `packages/core`: **1,240 passed, zero failed, 10,669 assertions**, 61.14s
  (`native-core-qualified.log`). Includes the actual native model resolver,
  request transport and provider SDK streaming against an owned HTTP fixture.
- The real permission suite separately passed **1,060 executions and 9,320
  assertions** after the pending-approval revocation correction.
- TUI account regressions passed **20 executions, 180 assertions**
  (`native-tui-repeat.log`). The account screen distinguishes unavailable
  gateway capability from a usable assigned-model catalog.
- Candidate backend `npm ci --ignore-scripts --no-audit --no-fund` installed
  **259 locked packages** with no manifest dependency additions. Its independent
  `npm test` passed **974 tests, zero failed/skipped**, 22.953s
  (`native-backend-deploy-test.log`). `npm run scan` passed both boundary and
  secret-leak gates, including during Firebase predeploy.
- Ten isolated Node processes passed **10 stalled-provider cancellations and
  20 school/individual success/replay cases** (`native-race-isolated-1.log`
  through `native-race-isolated-10.log`). Unknown usage conservatively charges
  the reservation while actual reported token counters remain zero.
- Canonical root `bun run check` passed **36/36 tasks**, zero cached, 2m16.376s
  (`native-root-check-final.log`). Existing lint warnings remain.
- Windows native CLI dev.7 passed help/version, isolated empty credentials,
  owned sign-in page, same-origin policy, foreign/null-origin rejection, listener
  shutdown, signed-out account RPC and catalog checks
  (`native-managed-cli-smoke.log`). Restricted hosted free models and Go remain
  absent; no inference was performed.
- Desktop source build succeeded (`desktop-native-build.log`), and **13
  focused packaging/identity regressions passed, 237 assertions**
  (`native-desktop-regressions.log`). This is not native desktop feature
  qualification. VS Code development-host testing remains open: its terminal
  reuse assertion failed. No new VSIX installation is claimed here.

The dev.7 CLI artifact was built using
`bun run script/build.ts --target=opencode-windows-x64-baseline --skip-install --skip-web-ui --outdir=dist/subi-native-managed-20261017`,
with `OPENCODE_CHANNEL=dev`, `OPENCODE_VERSION=2.0.0-dev.7` and pinned Bun 1.4.2.
SHA-256: `C43EEF8B329A66E22684E2496A5106CEA9D87DC300FB470B71DC31922C76DEBB`.

```powershell
& "D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-native-managed-20261017\cli-windows-x64-baseline\bin\subi.exe" --standalone
```

The user's running processes were still using dev.6. Close the old CLI and use
this artifact; `--standalone` avoids adopting the older running background
service. No global launcher was replaced by this deployment.

Deployment command, from `integrations/learnsmart`:

```powershell
firebase deploy --only functions:subi:subiManagedAgentApi --project learnsmart-c2a7e --config firebase.json --non-interactive
```

Firebase CLI 15.29.0 returned **Deploy complete**, exit 0. Only
`subiManagedAgentApi` was selected. The active revision is
`subimanagedagentapi-00048-bir`, updated October 17, 2026 at **19:15:55 IST**
(`2026-10-17T13:45:55.900373724Z`). The function remains Node.js 22, 512 MiB,
540-second timeout, on its existing managed-chat service account. The existing
agent operational gate, terminal gate, full capability and individual credit
enforcement settings were read for readiness and left unchanged. No Firestore
account, model, subscription, quota, credit, permission or IAM edits were made.

The previous revision `subimanagedagentapi-00047-gis` and configuration were
saved outside the repository. The downloaded deployed source archive SHA-256 is
`94502482A464FC9ABED7F01AB6E3FFB7A9F2B922357BD8D7B75B9A0C124C332B`;
all **103 source/package files** matched the read-only backend base. Existing
user environment settings were preserved. Firebase's generated reserved
`FUNCTION_SIGNATURE_TYPE=http` entry was omitted by this CLI deployment; the
function remains an HTTP trigger with the same entrypoint, and the authenticated
HTTP check below succeeded. An initial overly broad environment-equality check
reported this reserved-key difference; it is recorded rather than hidden.

Post-deployment verification used the currently selected LearnSmart credential
read-only, a separate disposable CLI profile, and the actual compiled dev.7
server. The protected capability endpoint returned **HTTP 200**, protocol 1,
text-only. Account refresh returned **allowed**, school account, with
`inferenceAvailable: true`. The model catalog returned **all 9 assigned
LearnSmart models**, and every model's display name and context limit matched
the account assignment. No upstream model identifiers, tokens, email or UID
were written to the safe result. The temporary credential/profile was removed,
and the original credential database was never written. Evidence:
`live-managed-catalog-result.json` and `live-managed-catalog.log` outside the
repository. **Live inference calls: zero**; generation against these nine
remote models remains unqualified.

This establishes deployed model discovery on Windows x64. It does not establish
full coding failure/repair completion, restart recovery, durable worker
promotion, all-host GUI parity, Linux/macOS execution, or production generation
against paid providers. The native request contract is text-only. Previously
documented full-suite and host qualification gaps remain open; the broader
release verdict remains **NOT READY**.

### User stop and saved model refresh work

The user confirmed CLI operation after deployment and then explicitly requested
that work stop and be saved for continuation tomorrow. The requested model-picker
Ctrl+R refresh control is implemented in source, with **130 repeated targeted
executions passing, zero failures, 450 assertions**, and canonical root checks
**36/36 successful**. It has not been built into the working dev.7 executable.
No full TUI suite or new CLI build was started for this change before stopping.
See `docs/subi-resume-2026-10-17.md` for the exact saved state and remaining work.

### October 18 continuation — final development artifacts

The saved refresh work is now built and tested in Windows CLI dev.11 and its
matching VSIX. VS Code terminal ownership, visible theme branding, the supplied
logo across shared UI/platform assets, and Windows atomic tab-state saving were
corrected. The managed gateway parallel-tool-call parser fix is deployed as
`subimanagedagentapi-00049-yup`; historical provider failures are not asserted
to have a proven single cause. PowerShell shell guidance now addresses the
misuse of `$LASTEXITCODE` seen in the user's command history.

Final configured TUI: 1500 pass / 12 skipped / zero failed. Final configured
CLI: 308 pass / eight skipped / zero failed. Backend: 978 pass / zero failed;
100 native parser/error contract executions in ten isolated processes passed.
Root check: 36/36. Native dev.11 PTY models/refresh/settings and packaged VSIX
terminal reuse passed. Desktop source build succeeded; no native Linux/macOS,
paid inference, or complete release qualification is claimed. Source checkpoint
confirmed zero OpenCode source changes and zero whitespace errors.

Artifact paths, SHA256 hashes, commands, failed-run triage and remaining release
gates are saved in `docs/subi-resume-2026-10-18.md` and the current execution
ledger. Use that handoff instead of the earlier source-only refresh stop state.

October 18 login design follow-up: dev.13 updates the shared private LearnSmart
browser login with the supplied logo and blue/purple design. Actual production
page desktop/mobile/error/retry/success browser checks passed with fake Firebase
transport; 11 affected tests / 110 assertions and core type-check passed. Fresh
Windows CLI and matching VSIX are built; desktop CLI resources are staged. New
login attempts use the update; existing pages stay owned by older processes.
Individual model-loading timeouts and duplicated client discovery requests are
documented as unresolved latency work, separate from this UI change. Full
release qualification remains open. See the current resume document for exact
artifacts, hashes, limitations and external log names.

October 18 individual billing integration (dev.15): `/account` now includes
complete credit bucket/cycle display and hosted top-up/renewal controls. The
shared app has an account panel in provider settings. Both preserve backend
authority, clear stale account data and refresh after returning from checkout.
School quota responses override stale individual metadata for purchase actions.
No LearnSmart source, live payment, credit record or deployment changed. Final
configured app/TUI/managed suites and root checks pass; new Windows CLI/VSIX and
web/desktop source builds are ready for local checking. See
`docs/subi-billing-integration-2026-10-18.md` and the current resume document.

October 18 branding pass (dev.16) applies Subi Code presentation across shared
app/native-menu/built-in feature translations, themes, About/help/pairing,
skills/tools and distribution metadata. Compatible backend IDs and original
license notices are retained. Upstream downloads and highlights are disabled;
Subi-owned remote discovery and version-checked local WSL staging are covered
by shell regressions. Windows CLI/VSIX, web and desktop renderer builds and
focused native/browser checks pass. Provider-hosted OAuth names require future
Subi registrations; native other-platform release testing is still open.
See `docs/subi-branding-2026-10-18.md` and the latest resume block for artifacts.
