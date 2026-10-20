# SubiCode workflow verification — 20 October 2026

The four E2E TypeScript diagnostics recorded in the 19 October report are resolved. The full repository lint/type check and supplemental E2E type check pass. The installed Windows CLI, desktop and VS Code extension each completed an actual read → edit → shell test → final response workflow in an isolated test profile.

## Changes

- `packages/app/e2e/performance/terminals/probe.ts`: forward native `drawImage` overloads with `Reflect.apply`, preserving the receiver and original arguments.
- `packages/app/e2e/performance/timeline/session-timeline-stream-probe.ts`: forward both native `scrollTo` overloads with `Reflect.apply`. Both reflective proxies have narrowly scoped, explained lint exceptions; neither uses an unsafe type assertion or allocates a bound function per measurement.
- `packages/app/e2e/regression/timeline-stream.spec.ts`: accept `Event` in the animation listener and narrow it to `AnimationEvent` before reading `animationName`. This fixes both listener variance errors.
- `packages/app/e2e/performance/unit/desktop-startup.test.ts`: update two stale expectations from the upstream color-scheme storage key to the existing `subi-color-scheme` key. The preload implementation was already correct.
- `.opencode/skills/app-e2e-tests/SKILL.md`: replace the stale four-error allowance with a requirement for a clean E2E type check.

No production implementation, design, account, saved task or setting was changed. The installed CLI/desktop remain **2.0.0-dev.37** and the installed VS Code extension remains **2.0.6**. These test-only changes require no reinstall.

## Checks performed

| Check | Result |
| --- | --- |
| Root `bun run check` | 36/36 tasks successful; existing lint warnings remain |
| App `bun run typecheck:e2e` | Zero diagnostics |
| `bun test ./e2e/performance/unit` | 52 passed, 0 failed, 131 assertions |
| Existing animation regression keepers using the corrected listener | 2 passed |
| Production browser terminal benchmark, `visible-output`, draw probe enabled | Passed; 12,000 lines through Windows ConPTY, WebSocket fixture and actual terminal renderer; 185,592 canvas draw calls |
| Production browser streaming benchmark with CPU/visual profiling enabled | Passed; four history turns, four deltas, 1× CPU; scroll proxy recorded two calls and all deltas completed |
| Installed Windows CLI coding workflow | Passed |
| Installed Windows desktop coding workflow | Passed; final response visible, no renderer errors |
| Installed VS Code extension coding workflow | Passed in native extension host; bundled executable verified and existing terminal reused |

The two browser probe runs were serial and used a production build. They exercise the changed instrumentation; the reduced timeline workload is not a comparative performance or full-load qualification. Installed Chrome was used because this host lacks the pinned Playwright browser/video dependencies. One dev-mode animation run emitted a ResizeObserver loop warning while both assertions passed.

## Coding workflow evidence and scope

Each client received a fresh disposable workspace containing `sum.cjs` implemented as subtraction and a real Node test expecting addition. The test failed before the task. A scripted localhost model requested the real `read`, `edit` and `shell` tools, received their actual results, and returned its verification marker only after seeing a passing test. An independent Node test then passed, and the resulting source was checked exactly. Each client made four local model requests; no live model credentials or credits were used.

CLI used the installed executable with `run --standalone --auto --format json`. Desktop used the installed executable and submitted the prompt through its actual composer. The installed VS Code extension launched its bundled CLI in a native integrated terminal, accepted the prompt, completed the tool workflow and reused that terminal through its normal command.

Initial one-off harness setup issues were corrected before the successful runs: the noninteractive CLI needed stdin EOF, and the extension prompt needed to wait for CLI initialization instead of just its initial terminal title. The terminal benchmark also required a process-local PowerShell execution-policy setting to execute its known local fixture script. No system execution policy or product code was changed for those issues. Fixture-owned services were stopped; existing user services were left running.

This validates client/provider/tool/result wiring with a deterministic local provider. It does **not** validate live LearnSmart/provider availability, billing or model reasoning. It is also not a run of every repository E2E test.

## Native platform status

Windows x64 executed all three installed products. This machine has no WSL installation, configured remote macOS/Linux host, Git metadata or connected CI run. Native macOS/Linux runtime checks therefore remain pending. The existing six-target `.github/workflows/subicode-platforms.yml` remains the route for testing those hosts when available; no CI execution, signing, publication or all-platform release is claimed.

## Saved evidence

Logs and passing workflow results are retained in `artifacts/verification/2026-10-20/`. That folder includes the reproduced four-error baseline, final lint/type logs, unit/browser results, CLI tool events, independent before/after test output, native extension-host assertions and the completed desktop screenshot.

The isolated fixtures and one-off orchestration/config files remain under `C:/Users/Admin/AppData/Local/Temp/subi2-20261020/workflow-check/` for inspection.
