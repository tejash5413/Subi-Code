# Subi Code for VS Code

Open Subi Code in an editor terminal, keep the current workspace, and insert file references into the CLI prompt.

## Launch and file references

- **Open Subi Code:** `Ctrl+Esc` on Windows/Linux or `Cmd+Esc` on macOS. Reuses a terminal created by this extension even when the CLI changes its title.
- **New tab:** `Ctrl+Shift+Esc` or `Cmd+Shift+Esc`, or the editor title button.
- **Insert file reference:** `Ctrl+Alt+K` or `Cmd+Option+K`. Inserts the active workspace-relative filename and selected line range into the active Subi terminal without submitting it.

Windows can reserve the Escape combinations for system commands. These actions are also available from VS Code's Command Palette and can be rebound in Keyboard Shortcuts.

Platform-specific VSIX packages include the matching SubiCode CLI for Windows, Linux or macOS, on x64 or ARM64. Install the VSIX matching your OS and CPU. To use another build, set the machine-scoped `subicode.executablePath` to the executable's full path. A source-only development extension requires `subi` on PATH.

Within the CLI, connect LearnSmart for assigned school/individual models or connect your own provider. The model picker supports **Ctrl+R** to refresh models and account assignments. LearnSmart model execution remains subject to the account's server permissions, subscription, limits and credits.

## Development

Open this directory in VS Code and run its configured scripts:

```powershell
bun install --ignore-scripts
bun run compile
bun run compile-tests
```

Use a disposable VS Code profile for native extension-host tests. The test runner verifies bundled executable selection, native process startup and terminal reuse. A Windows development package does not qualify Linux/macOS or live model inference. See the repository's `docs/subi-migration.md` for the current release limitations.
