# SubiCode Settings redesign — October 19, 2026

The user approved the monochrome Settings preview before implementation.
Changes are in `D:\LearnSmart\Subi 2.0`; the older `Subi` checkout is unchanged.

## Implemented behavior

- A shared Settings header, breadcrumb and one navigation sidebar, grouped into
  Personal and Workspace. The workspace sidebar stays mounted but is hidden
  while Settings is open; Back restores it without losing the current draft.
- Flat, divider-separated rows, compact controls and consistent spacing across
  Preferences, Appearance, Notifications, Shortcuts, Projects, Worktrees,
  Providers, Models, Extensions, Server and About. Desktop-contributed Pairing
  keeps its existing implementation and receives the shared layout.
- Existing theme tokens remain authoritative. Light, dark and custom theme
  selection, fonts, language, shortcuts and all existing settings handlers are
  retained. Narrow windows use the existing page menu and searchable navigation.
- Account and credits opens the real Providers page containing the LearnSmart
  account panel. This redesign supplies no example account, model or credit data.
- MCP connection forms, tool discovery, authentication, refresh, disconnect,
  reconnect and removal keep the existing backend. Plugins and Skills remain
  connected to their actual inventories.
- About presents the real installed version, LearnSmart website/support links,
  and bundled third-party notices. Notices still load on demand.

## Verification

- The new single-navigation regression failed against the previous layout, then
  passed after implementation. Existing draft and tab-layout keepers were
  updated for the approved single-sidebar behavior.
- `bun run check`: exit 0; 36 successful type-check tasks, no lint errors.
  Existing repository lint warnings remain in the full log.
- Settings unit tests: 52 pass, 0 fail, eight files.
- Production web build and desktop Electron build: exit 0.
- Production visual verification: 11 core pages in both dark and light modes,
  plus four narrow-window pages; 26 screenshots, no horizontal overflow or
  renderer errors. Native Pairing is verified separately in desktop.
- Independent source review: no actionable findings. This was a source review,
  not a claim of additional native-platform qualification.
- Production browser keepers: 49 of 50 passed on the complete run; the last
  failure expected the old `opencode pair` instruction. Updating that expected
  text to the existing `subi pair` branding passed the targeted recheck. All 50
  current cases therefore have passing evidence against the same built app.
- Packaged Windows app in an isolated profile: all 12 pages, including Pairing;
  one sidebar; light/dark switching; notices; account navigation; Back; Build/Plan;
  real local MCP save, tools, disconnect, reconnect, refresh and removal; a
  compiled CLI MCP addition/removal against the same service; Plugins. No
  renderer errors.
- Windows NSIS package: exit 0. Silent install: exit 0. Installed EXE, app archive
  and bundled CLI hashes match the qualified package. Desktop and Start menu
  shortcuts point to SubiCode and use normal window style.
- Installed normal profile: all 12 pages, actual dev.26 version, MCP tools API,
  add/cancel form, account navigation and SubiCode branding verified. Existing
  light theme preserved. App remains open on Preferences, title SubiCode.
- Final canonical `bun run check`: exit 0, 36 successful tasks.

The old suite still tested upstream Console/Go entry points that the unchanged
SubiCode integration catalog intentionally filters. Those obsolete contracts were
retired. The replacement keeper proves LearnSmart/BYOK availability and the
absence of Console/Go offers on the page and provider chooser. The key/OAuth case
now uses Anthropic + Copilot; both existing generic OpenAI account-management
keepers remain. Source review confirmed this does not remove applicable generic
account coverage. Original failure evidence remains in the task logs.

The optional `bun run typecheck:e2e` check still reports four pre-existing errors
outside the changed Settings/tabs files: terminal canvas probe overloads,
timeline scroll probe overloads, and two timeline AnimationEvent listener types.
Those files were not modified by this UI task. The canonical repository check,
production builds, executed Settings tests and native checks pass. Do not treat
this task as full repository or all-platform release qualification.

## Scope and artifacts

Desktop package target: `artifacts/2026-10-19/settings-dev26/desktop`.
The installed desktop frontend is dev.26 and reuses the qualified dev.25 CLI service.
No CLI backend, terminal layout or VS Code extension code changed in this task.
The global CLI and installed extension remain dev.25.

The shared GUI source also supplies the web, macOS and Linux Settings screens.
Native macOS/Linux builds, installation and operating-system integration still
require those hosts. This task does not establish full cross-platform release
qualification. No hosted deployment, credit purchase or paid inference ran.

Logs, before-edit backups and qualification helpers:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\settings-design`.

## Installed SHA-256

| File | SHA-256 |
| --- | --- |
| SubiCode.exe | `2E983ABDCD154198D68E77B184F192CB9DA1F9885B6173A4906A4F0362F1AFA1` |
| resources/app.asar | `8F35A523BF0BDD43815D8F6D1E02E2090D9E9C2F2AF294933550E818E211B549` |
| resources/opencode-cli.exe | `E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD` |

Screenshots: [installed Preferences](previews/subicode-settings-installed.png),
[native dark](previews/subicode-settings-native-dark.png),
[installed MCP](previews/subicode-settings-mcp-installed.png),
[narrow Appearance](previews/subicode-settings-mobile.png).
