# SubiCode platform packages — October 19

## Current UI verification update — dev.37

Windows CLI/desktop **2.0.0-dev.37** and VS Code extension **2.0.6** are installed. Narrow MCP/plugin/skill fields now fit their forms; extension toolbar/terminal icons use transparent light/dark variants; browser pairing and service recovery messages use the `subi` command. The canonical check passed all 36 tasks. Native packaged desktop/extension checks and normal-profile checks passed, preserving 15 tasks and the selected theme. See the [UI verification report](subi-ui-verification-2026-10-19.md) for evidence, hashes, the four existing supplemental E2E typing errors, and remaining native macOS/Linux qualification. No all-platform release is claimed.

## Previous plugin/skill setup update — dev.35

Windows CLI/desktop dev.35 and extension 2.0.5 added shared plugin/skill setup forms, configured-source management, selected-server session actions and CLI shortcuts. Details: [extension source setup](subi-extension-source-setup-2026-10-19.md).

## Previous branding update — dev.34

Windows CLI and desktop **2.0.0-dev.34**, plus VS Code **2.0.4**, are installed. The expanded branding audit found zero old-name substring matches in 88,484 first-party messages across 759 catalogs after the fixes. Native packaged Settings/MCP branding, desktop startup/Build/Plan and extension-host execution passed. Installer exit 0; installed hashes match; normal-profile checks preserved fifteen tasks and the selected theme. See the [branding audit report](subi-ui-branding-audit-2026-10-19.md) for scope, compatibility behavior, artifacts and remaining native qualifications.

## Previous desktop startup update — dev.33

Desktop **2.0.0-dev.33** is installed with the centered icon above a Keania One title. Its native and installed-profile checks passed, including bundled font loading, Settings, MCP and saved tasks; installer exit 0. The standalone CLI and bundled desktop sidecar remain dev.32; VS Code remains 2.0.3. See the [centered startup report](subi-centered-startup-2026-10-19.md) for exact artifacts, visual checks and hashes. Linux/macOS native qualification remains pending.

## Previous installed update — dev.32

Windows CLI and desktop are now **2.0.0-dev.32**, with VS Code extension **2.0.3**. All three installed products contain the same Windows x64 CLI. This update includes the first-party branding cleanup and readable light-mode startup logo/title. See [branding and light-mode report](subi-branding-light-mode-2026-10-19.md) for visual evidence and audit scope.

Final root check: **36 successful tasks**. Packaged native desktop and extension-host qualification passed. Desktop installer exit: **0**. Installed-profile checks passed all twelve Settings sections, account navigation, MCP form/API, session Extensions menus and Recent tasks search/reopening/commands. **15 saved tasks** and the selected `nightowl` dark theme were preserved; no renderer errors were observed.

Installed CLI, desktop sidecar and extension CLI all match SHA-256 `A8ACE4DE57D43E3C6D56BC189696EC83BDB1EFE53DE03B3D7203E8D73AE36C46`. Installed and packaged desktop archives match SHA-256 `8991706BA7EDBF1AE7A72A7A1F9A4345A0DE0A8D47603444450C05D79A475FCB`.

Current artifacts: `artifacts/platforms/2.0.0-dev.32/win32-x64/`; native results: `packages/qualification.json` within that directory. Light/dark shared-component screenshots cover all three OS layouts under the sibling `visuals/` directory. These visual layout checks do not replace native Linux/macOS qualification, which remains outstanding as described below.

## Previous installed baseline — dev.30

The previous Windows CLI and desktop were **2.0.0-dev.30**, with VS Code extension **2.0.1**. All three installed products contained the same newly built Windows x64 CLI, including the redesigned Settings, Recent tasks and Add MCP connection form. The historical checks and hashes below refer to that baseline.

## Changes

- `packages/desktop/scripts/distribute.ts` builds the current host's CLI, self-contained npm package, platform-specific VSIX and desktop installer. Explicit release versions and matching CLI versions are required. No packages are published.
- `distribution-packages.ts` stages packages without modifying the source extension or user profiles. It verifies PE/ELF/Mach-O format and architecture, embeds the correct executable, and refuses to overwrite a previous stage. A Unix CLI and launcher retain executable permissions.
- Desktop packaging now checks native terminal libraries on Linux and macOS as well as Windows, including embedded libraries and the macOS spawn helper.
- `.github/workflows/subicode-platforms.yml` provides native Windows, Linux and macOS jobs, each on x64 and ARM64. It installs each host's dependencies, builds CLI/VSIX/desktop artifacts, and runs the packaged desktop and VS Code extension host in disposable profiles. Linux uses Xvfb. Qualification artifacts are unsigned and unpublished; macOS notarization is disabled for these development packages.
- `qualify-distribution.mjs` checks packaged desktop startup, Build/Plan, all twelve Settings sections and the Add MCP form, plus VSIX installation, bundled CLI startup and terminal reuse. It captures the desktop's private XDG paths so its managed server can be stopped during cleanup.
- VS Code display name is SubiCode. Older `learnsmart.subi@0.1.0` and `sst-dev.opencode@1.0.0` integrations were backed up, then uninstalled; unrelated extensions were retained.

## Windows verification

- Canonical root `bun run check`: **36 successful tasks**; existing repository lint warnings remain.
- Explicit lint on changed packaging files: **0 warnings, 0 errors**.
- Packaging contract tests: **110 passes** across ten repetitions. Cases cover six targets, bundled bytes/manifests, unsupported platforms, mismatched native architecture and refusing to overwrite artifacts.
- Packaged VSIX native host: passed commands, bundled process startup and terminal reuse.
- Packaged desktop deep check: passed Build/Plan, all Settings sections, dark/light themes, Recent tasks, and a real local MCP server's save/connect/tools/disconnect/reconnect/refresh/remove flow. Session details' Add MCP form also saved and connected successfully. No renderer errors; no live model inference or external OAuth authorization.
- Installer exit code: **0**. Installed desktop archive matches the packaged archive. Installed CLI, desktop sidecar and extension CLI all match the compiled binary.
- Normal installed profile: passed twelve Settings sections, account navigation, MCP dialog/footer, Extensions panel and Recent tasks search/reopening/commands. Twelve saved tasks and the existing dark theme were preserved. No account or model settings were changed.

CLI SHA-256: `1BA9BFF81149BB5F810DC982876D5C905DF52077A562253D607D5E021FF01CDE`.

Installed desktop archive SHA-256: `98E2D172DFA1ACB72F1E01A9787F1875B76A29983CA5CE965D753D9BF49E50D6`.

Artifacts: `artifacts/platforms/2.0.0-dev.30/win32-x64/`. The package qualification status is recorded in `packages/qualification.json` there. Local logs, screenshots, previous-extension backups and detailed native results are under `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev30/` and the adjacent `platform-dev30-*` logs.

## Native qualification still outstanding

**Linux, macOS and Windows ARM64 are not yet certified.** Their source packaging paths and native jobs are implemented, but these jobs have not run. This checkout has no Git metadata or connected CI run, and the available machine is Windows x64 without WSL or a Mac host. No Linux/macOS installer is being represented as built or installed here.

The six runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Run the manual **SubiCode native packages** workflow after this source is in the project's GitHub repository. Each platform must pass its own native qualification before distribution. Signed public releases still require the project's signing/notarization credentials.

## Reproduce on a native host

Install the pinned Bun version and root dependencies, then install `sdks/vscode` dependencies using its frozen lockfile. Set `OPENCODE_VERSION` to a new explicit version and `OPENCODE_CHANNEL=dev`, then run:

```text
bun run packages/desktop/scripts/distribute.ts
```

The script chooses the current host and architecture. `OPENCODE_CLI_DIST` may point to an already built matching CLI distribution. Then compile extension tests with `bun run compile-tests` in `sdks/vscode` and run:

```text
node packages/desktop/scripts/qualify-distribution.mjs <artifact-directory>
```

An existing VS Code executable may be supplied as the next argument. Windows installations with a versioned resources directory may supply the corresponding `resources/app/out/cli.js` as one further argument. Without these arguments the harness downloads the stable editor. Linux needs an active display or `xvfb-run -a`.

To check the installed Windows CLI, open a new terminal and run `subi --version`, then `subi` in the desired project folder. Reload VS Code to activate its updated extension.
