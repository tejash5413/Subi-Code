# SubiCode desktop UI follow-up — October 19, 2026

The user identified Recent tasks as an inherited screen after the dev.26 Settings
update and requested a consistent design across Windows, macOS and Linux.

## Changed shared UI

- Recent tasks now has a page heading, short description, flat full-width
  surface, aligned search/new-session toolbar, compact project navigation and
  task row dividers. Narrow windows use the existing project dropdown.
- Task search, groups, unread/busy state, project filters and actions, keyboard
  navigation, middle-click/background opening, rename, export, delete and live
  updates retain their existing controllers and callbacks.
- Dialogs, project popovers, menus, select menus and command search share the
  same neutral borders, surfaces and corners. Theme roles remain authoritative;
  no platform-specific fixed color palette was introduced.
- Welcome/Workspace, Models, Integrations, MCP/plugins, Account/credits and
  Settings retain the SubiCode shell and previously redesigned pages. This
  follow-up changes the remaining history/browser and shared overlay surfaces;
  it does not replace the existing editor, terminal, timeline or model engine.

## Surface-to-function audit

| Surface | Existing functionality retained |
| --- | --- |
| Workspace/New task | Durable drafts, composer, Plan/Build, files and attachments, selected model, send/stop |
| Recent tasks | Session search, chronological groups, project/server filters, reopen/background-open, rename/export/delete |
| Projects | Add/select/reorder, context actions, server sign-in, worktree/project settings, reveal/import/close |
| Models | Assigned models, BYOK catalog, model/variant pickers and available metadata |
| Integrations | LearnSmart and supported provider authentication/account management |
| MCP/plugins | App name/URL form, real tools, authorization, connection controls, plugin/skill inventory |
| Account/credits | Existing school/individual snapshot, allowance, purchase/top-up/renewal links |
| Settings | All 12 pages, theme/font/language choices, shortcuts, notifications, pairing and About notices |
| Commands and shared dialogs | Existing search, keyboard selection, focus restoration, actions and error states |
| Response/review/editor/terminal | Existing implementations inside the shared app shell; data and execution behavior unchanged |

## Verification checkpoint

- The existing slow-data Home keeper was extended with the accessible Recent
  tasks heading: it failed before the change and passed after the change.
- Canonical check: 36 successful tasks, no lint errors. Existing repository lint
  warnings remain in the full log.
- App unit tests: 762 pass, 0 fail, 108 files.
- Production web and Electron builds: exit 0.
- Production visual checks: dark/light wide, dark narrow, light mobile; task
  search, context menu, project picker and command palette. Four cases pass, no
  renderer errors or main-panel horizontal overflow.
- Independent source review: no actionable findings in the Home layout,
  sticky offsets, project dropdown or shared portal styling.

- Browser keeper suite: 114 cases have passing evidence across the initial run
  and targeted rechecks. The initial run passed 104 and failed ten; two Home
  cases, one command case, six model-picker cases and one password-change case
  passed after correcting their test setup. This was not a single green
  114-case run. Raw failures and traces remain in the task directory.
- Private packaged Electron check: pass, no renderer errors. Build/Plan,
  all twelve Settings pages, theme switching, account navigation, Recent tasks,
  plugin inventory and real local MCP add/tools/disconnect/reconnect/refresh/
  removal passed. A compiled CLI addition appeared in the same GUI service.
- Windows installer: exit 0. Installed executable, application archive and
  bundled service hashes match the packaged files.
- Normal installed profile: version 2.0.0-dev.27, window title SubiCode,
  twelve Settings pages, account navigation and MCP form/API pass. Twelve saved
  tasks were found; reopening, search and Commands passed. Existing dark theme
  was preserved, and no renderer errors were reported. The app is left on
  Recent tasks.

Initial visual fixture failures came from an omitted mock folder inventory and
an incorrect assumption that the existing project popover had no dialog role.
Correcting the fixture and asserting the actual Projects dialog passed without
production changes. Existing Home tests also assumed horizontal tabs while the
product now defaults to Workspace sidebar; those tests now explicitly select
their supported horizontal layout. Workspace navigation remains owned by the
existing tabs keeper.

Model-picker tests still seeded old, unprefixed persistence keys; the shared
storage fixture now writes the current SubiCode keys. The password-change test
updated its mock server after typing the new password, although typing starts
the real credential preview. Updating the mock server before typing models the
actual sequence and passes. Neither correction changed production behavior.

The old home/tab benchmark assumes the removed default horizontal layout and
timed out looking for titlebar tabs before production edits. A production Home
index baseline (500 roots, 64 visible rows) passed three runs before edits;
the same benchmark is used for the after comparison. All performance claims
must identify the measured renderer scope, rather than imply full desktop RAM
or native cross-platform performance.

The final serial production comparison used three runs per version, 500 roots,
12 directories and 64 visible rows. Median results:

| Metric | Before | After |
| --- | ---: | ---: |
| Rows ready | 659.7 ms | 522.8 ms |
| Post-list processing | 143.3 ms | 96.8 ms |
| Renderer thread time | 854.2 ms | 808.2 ms |
| Layout time | 84.0 ms | 97.9 ms |
| Renderer heap used | 19.93 MB | 19.27 MB |
| DOM nodes | 2,143 | 2,148 |
| List requests / bytes | 1 / 257,100 | 1 / 257,100 |

These are local measurements, not performance guarantees. Layout time increased
with the added heading and structure; overall row readiness did not regress in
this sample. An earlier after-run overlapped packaging and browser tests and is
retained as diagnostic data, excluded from this serial comparison.

## Installed package identity

| File | SHA-256 |
| --- | --- |
| SubiCode.exe | 9FC173AFCC95537C0B7CB729A6C82DD51EE69CD0F8843819D5886690B563E1DA |
| resources/app.asar | 17BCB1711AA77D0880AD232DC3181D37E2986AD73489947CB15AFBCACB0FC9B0 |
| resources/opencode-cli.exe | E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD |

Installed executable:
`C:\Users\Admin\AppData\Local\Programs\subicode-desktop\SubiCode.exe`.

Screenshots: [Installed Recent tasks](previews/subicode-recent-tasks-installed.png),
[dark wide](previews/subicode-recent-tasks-dark.png),
[light mobile](previews/subicode-recent-tasks-mobile.png).

## Distribution scope

Target frontend: dev.27. Qualified bundled CLI service remains dev.25; no CLI
backend or VS Code extension code changes were needed for these app surfaces.
All three desktop targets import the same updated renderer. Windows is built
and installed here; native macOS/Linux installation and integration testing
still require those hosts. Existing E2E type-check limitations in untouched
terminal/timeline test code remain documented in the dev.26 Settings report.

Artifacts: `artifacts/2026-10-19/complete-ui-dev27/desktop`.
Before-edit backups, logs and helpers:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\complete-ui-dev27`.
