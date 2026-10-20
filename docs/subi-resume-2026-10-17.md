# Saved handoff — October 17, 2026

Work stopped at the user's explicit request. No further build, deployment,
installation or background work is scheduled. The user confirmed the CLI is
working after the LearnSmart gateway deployment.

## Working deployment and CLI

- Repository: `D:\LearnSmart\Subi 2.0`. Keep the original Subi, OpenCode and
  LearnSmart backend source checkouts read-only.
- Firebase project `learnsmart-c2a7e`, region `asia-south1`, single function
  `subiManagedAgentApi`, active revision `subimanagedagentapi-00048-bir`.
- `SUBI_NATIVE_AGENT_ENABLED=1`. Existing account permissions, assignments,
  subscription, quotas and credit enforcement settings were left unchanged.
- Actual compiled CLI discovery returned all nine assigned LearnSmart models
  with matching names and context limits. Authenticated capability HTTP 200;
  unauthenticated HTTP 401. Zero live inference calls.
- The working executable is
  `D:\LearnSmart\Subi 2.0\packages\cli\dist\subi-native-managed-20261017\cli-windows-x64-baseline\bin\subi.exe`
  (`2.0.0-dev.7`). Use `--standalone` to avoid adopting the older running server.
- SHA-256:
  `C43EEF8B329A66E22684E2496A5106CEA9D87DC300FB470B71DC31922C76DEBB`.

## Saved refresh shortcut changes

The model picker now has a configurable `model.dialog.refresh` action, default
**Ctrl+R**, with a visible footer hint. It refreshes connected integrations,
refreshes LearnSmart account/model discovery when connected, invalidates and
reloads the provider/model caches, and preserves the search and open dialog.
It shows pending/error feedback, prevents duplicate requests and aborts the
account request when the dialog closes.

Changed source:

- `packages/tui/src/component/dialog-model.tsx`
- `packages/tui/src/config/keybind.ts`
- `packages/tui/test/model-refresh.test.tsx`

The shortcut is saved in source only. **It is not included in the dev.7 binary.**
No dev.8 executable has been built or installed.

Verification completed before stopping:

- New regression before implementation: 0 passed, 2 failed because Refresh was
  absent (`model-refresh-before.log`).
- Targeted picker/account/sorting regressions repeated ten times: **130 passed,
  zero failed, 450 assertions**, 19.70s (`model-refresh-repeat.log`). Covers
  narrow/wide terminals, empty-to-populated assigned models, pending single
  flight, failed refresh/retry, BYOK without managed requests and retained search.
- Canonical root `bun run check`: **36/36 successful**, 35 cached, 7.223s
  (`model-refresh-root-check.log`). This check had already finished when the
  stop request was handled; no matching check process remained.
- The full TUI suite was not run for this shortcut change. A new binary build
  and native smoke of the shortcut remain outstanding.

## Next authorized work when the user resumes

1. Review the saved picker changes and run the full configured TUI suite.
2. Build a new Windows CLI artifact with the refresh shortcut; do not overwrite
   the working dev.7 executable. Verify model discovery and the new shortcut,
   then provide the exact new command or install it if requested.
3. Continue the unresolved VS Code native-host terminal reuse failure before
   claiming extension qualification or packaging/installing an updated VSIX.
4. Continue the broader release qualification recorded in `subi-migration.md`.
   Full coding/repair, recovery, workers, live inference and other platforms
   must not be marked qualified without execution evidence.

The native backend does not need redeployment for a TUI-only shortcut change.
Deployment setup and rollback notes are in `integrations/learnsmart/README.md`.
Bulky logs, source/configuration backups and safe live results remain outside
the repository in
`C:\Users\Admin\AppData\Local\Temp\subi2-20261017`.
