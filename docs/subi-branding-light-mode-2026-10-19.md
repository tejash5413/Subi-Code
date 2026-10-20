# SubiCode branding and light startup screen

The light startup screen used an outlined wordmark, a faint foreground token and a white raster ribbon without the existing light-theme contrast treatment. It now uses solid theme text and the same darkened transparent ribbon as the rest of the application. Dark mode retains the silver ribbon. Theme selection remains available.

The shared `Wordmark` now marks its image with the existing `brand-mark` slot and loads its stylesheet directly. Desktop startup removes the outline and faint opacity. This fixes every consumer of this shared wordmark and the desktop's Windows, macOS and Linux startup layouts.

## Verification

The actual production `LoadingSplash` and theme resolver were rendered in Chromium for all three OS layout values, in light and dark modes. All six passed. Light uses `rgb(22, 22, 22)` text on white and `brightness(0.3)` on the ribbon; dark uses `rgb(250, 250, 250)` text on `rgb(22, 22, 22)` and no ribbon filter. Screenshots were visually inspected. These are shared-component checks on Windows, not native macOS/Linux execution.

Screenshots and results are under `artifacts/platforms/2.0.0-dev.32/visuals/`.

## Branding audit

The runtime application dictionary audit checked **54,655 messages in 63 dictionaries after presentation branding**. No `OpenCode` or standalone `opencode` remained in that audited text. Fixes include localized Extensions configuration labels and translated pairing instructions. Existing translation keys are preserved.

Other changes:

- Shared product presentation name is **SubiCode**.
- CLI statistics link to LearnSmart, including their empty state.
- Model-not-found help no longer displays the legacy config filename.
- Desktop theme schema title and description use SubiCode.
- Native desktop menu and recovery translations already pass through the shared presentation branding layer.
- Existing saved theme IDs, package imports, protocols, storage keys and compatible configuration paths retain their backend identities. License and copyright credits are preserved. User content and external provider responses are not rewritten.

The application dictionaries contain inherited product text in source; rendering transforms it through `brandMessages`. Searching raw source alone therefore overcounts visible branding. This audit does not claim that user messages, external consent pages, backend debug output or required third-party license credits are first-party UI branding.

## Checks

- Root `bun run check`: 36 successful tasks.
- Product presentation regression: 10 repeated passes.
- CLI statistics regression: 120 repeated passes.
- GUI extension English/lazy French catalog checks: 30 repeated passes.
- Server error-formatting tests passed.
- Windows titlebar menu browser regression passed with its updated SubiCode accessible label.
- Six shared startup visual cases passed.

Native packaging and installed-version details are recorded in the platform packaging report and the current handoff. Linux/macOS and Windows ARM64 native qualification remain pending their native jobs.

## Installed Windows update

Windows CLI and desktop **2.0.0-dev.32**, plus VS Code extension **2.0.3**, are installed. The desktop installer exited **0**. The packaged native harness passed desktop startup, Build/Plan, all twelve Settings sections, the Add MCP form, isolated VSIX installation, bundled CLI startup and terminal reuse. Its disposable background service was stopped after the checks.

The normal installed profile also passed Settings, account navigation, MCP API/form, session Extensions menus, Recent tasks search/reopening and commands. **15 saved tasks** were present; the selected `nightowl` dark theme was preserved. No renderer errors were observed. No model prompt or new connection was submitted in the normal profile.

Installed CLI, desktop sidecar and extension CLI SHA-256 all match:
`A8ACE4DE57D43E3C6D56BC189696EC83BDB1EFE53DE03B3D7203E8D73AE36C46`.

Installed desktop archive matches the tested package:
`8991706BA7EDBF1AE7A72A7A1F9A4345A0DE0A8D47603444450C05D79A475FCB`.

Final packages and native qualification results are under `artifacts/platforms/2.0.0-dev.32/win32-x64/`. The corrected light startup preview is `artifacts/platforms/2.0.0-dev.32/visuals/windows-light.png`. Installed-profile results are saved in `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev32/installed-result.json`.
