# SubiCode desktop workspace — 19 October 2026

Approved desktop design implemented in the shared app frontend. Windows package version: 2.0.0-dev.23; bundled managed server remains the qualified 2.0.0-dev.20 build.

## Changes

- Workspace sidebar with the transparent Subi emblem, new-task action, task history, real open tabs, models, integrations, MCP/plugins and LearnSmart account/credits navigation.
- Project/account header and the approved welcome layout. Three task suggestions prepare an editable draft without sending; Explore and Review select Plan when available, Fix selects Build. Existing model selection stays unchanged.
- Existing composer owns attachments, paste, cursor/selection, Build/Plan, model selection, submit and stop. Permissions opens the existing general settings. School/individual account allowances, payments, renewal, BYOK, provider authentication and execution policies retain their existing backend behavior.
- Semantic theme colors support existing light/dark/custom theme choices. The new Workspace sidebar is the default for fresh settings. Explicit horizontal/vertical tab preferences remain supported under Settings → General → Tabs.
- App/window/installer product name is SubiCode for all desktop release channels. Application IDs and storage locations are unchanged.
- Window registry now remembers an initial window before its first focus event. A second launch can reveal an initially hidden window.

## Verification

- Canonical root check: passed, 36 tasks.
- App unit tests: 762 passed, zero failures.
- Browser production build: 37 cases passed initially; the other two used stale selectors for horizontal tabs and the old OpenCode menu name. Both passed after correcting those selectors. Combined coverage: all 39 composer/tab cases passed.
- New welcome and workspace-navigation cases: 20/20 repeated runs passed, five workers, no retries.
- Browser previews: dark/light at 1440×920, narrow at 900×760, mobile at 390×844; no page errors or horizontal document overflow.
- The redesign initially introduced nested scrolling that hid the caret after long pastes. Removed that nested overflow; the existing 25,000-line crash-report and RTL/LTR multiline-paste keeper cases now pass using the original composer scroll view.
- Desktop registry/distribution checks passed before packaging. Packaged dev.22 native check reproduced a hidden initial launch, revealed it on second launch, and verified the SubiCode title with zero renderer errors.
- E2E type-check still reports the four previously documented errors in terminal/timeline benchmark probes and timeline-stream tests. No errors were reported in the edited test files. Production app and desktop type checks pass.

## Installation

Installed successfully with installer exit code 0:

- Installer: `artifacts/2026-10-19/desktop-dev23-workspace/subi-desktop-win-x64.exe`
- Application: `C:/Users/Admin/AppData/Local/Programs/subicode-desktop/SubiCode.exe`
- Desktop and Start menu: `SubiCode.lnk`, normal-window launch style, correct executable and icon.
- Installed EXE, app.asar and bundled CLI SHA256 hashes all match the qualified package.
- EXE: `BCBCB416D0D80E14482D52699BCA146868705972D981BBFFD4BD495FEC4B37B2`
- app.asar: `9E02461C639E2C955DFEA065E6927DF9C5DADFDF418CB86E6E388F36E4A51240`
- CLI: `4257B4543A917364F17EEE25E8C862F61AA1A82E59979C6C12900EBF607AC85E`

Packaged dev.23 native checks pass: startup, welcome/sidebar visibility, Build/Plan selection, exact SubiCode title, and hidden-window recovery on second launch, with zero renderer errors. Normal-profile startup reused the existing healthy dev.20 managed service at 127.0.0.1:46513; the original OpenCode service at 45278 was left alone.

The user's existing profile retained Horizontal tabs, initially hiding the approved sidebar. Using the actual Settings controls, selected Workspace sidebar and the approved Dark color mode. The existing theme selection and theme options remain available. Verified on the installed normal profile: Models, Integrations, MCP/plugins, account/credits and Preferences all open and return to the draft; the selected LearnSmart model is preserved and no renderer errors occur. The app is left open on the new welcome screen.

The layout-preference keeper covers Workspace sidebar → Horizontal → Vertical, persistence after reload, and return to Workspace sidebar. Both it and the existing settings/history case pass against the production build.

A first installed-profile automation attempt hit a File submenu positioning/stability timeout; opening Settings through its existing Ctrl+, shortcut succeeded. No application renderer error was reported. The initial browser dev run is retained for diagnosis; it included intermediate CSS and hot-reload failures, so the final immutable production-build results above are the qualification evidence.

Real installed screenshot: `docs/previews/subicode-workspace-installed.png`.

## UI-to-feature mapping

| UI control | Existing implementation retained |
| --- | --- |
| New task | `tab.new` command and durable draft/session creation |
| Open tasks | Original session tab selection, close, unread/busy status and reorder |
| Recent tasks | Existing home/project/session browser |
| Workspace | Return from Settings to the original draft/session |
| Models | Existing model catalog, assigned LearnSmart models, provider/model selection and context metadata |
| Integrations | Existing provider connections and BYOK/OAuth flows |
| MCP & plugins | Existing Extensions settings; MCP, plugins, skills and language-server views |
| Account and credits | Existing LearnSmart school/individual account, allowance, credits, top-up and renewal card |
| Project header and worktree row | Existing project picker, Git status, worktree selector, branch and workspace actions |
| Explore / Fix / Review | Draft text plus existing Plan/Build selector; never submits automatically |
| Prompt / attachments / send / stop | Original composer, paste/undo, cursor/selection, attachments, queue and execution callbacks |
| Permissions | Existing general/project permission settings; no permission policy changed |
| Theme and layout | Existing Settings controller, with an additive Workspace sidebar option |
| Responses / file editing / review / terminal | Existing session, editor and extension implementations within the shared shell |

Only presentation, navigation composition and initial-window recovery changed. Account, model routing, credits, provider authorization and agent execution implementations were not replaced by mock/sample data.

## Limits of this qualification

Native macOS/Linux execution and installers require their respective hosts and are not qualified by Windows/browser checks. No hosted deployment, publishing, live paid inference, or credit purchase was performed. CLI and VS Code extension installations were not changed by this desktop design task.
