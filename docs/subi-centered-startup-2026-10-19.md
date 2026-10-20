# Centered desktop startup branding

The desktop first-launch splash now places a large ribbon icon above a centered `SUBI CODE` title. The title uses Keania One Regular, matching the user's supplied Google Fonts reference. The group is centered in the client area below the native titlebar and scales down with short or narrow windows.

The shared Wordmark has an optional stacked layout. Its other consumers retain their horizontal layout. Startup animation and reduced-motion behavior are preserved. Light mode keeps the darkened transparent ribbon and solid foreground text; dark mode retains the silver ribbon.

Keania One is bundled locally as `packages/ui/src/assets/fonts/KeaniaOne-Regular.ttf`, with its original [SIL Open Font License](https://raw.githubusercontent.com/google/fonts/main/ofl/keaniaone/OFL.txt). Both files come from the [Google Fonts source directory](https://github.com/google/fonts/tree/main/ofl/keaniaone). Desktop packages include the license under `resources/licenses/KeaniaOne-OFL.txt`. No Google Fonts request is required at startup.

## Verification

- Final canonical `bun run check`: 36 successful tasks; existing repository warnings remain.
- Actual production splash and final compiled CSS: 12 visual cases passed, covering Windows/macOS/Linux layout values, light/dark modes and 1440×900/360×640 viewports. Checks confirm the image is above the title, both share the horizontal center, the requested font loads and the light/dark contrast treatment remains active.
- Visual artifacts: `artifacts/platforms/2.0.0-dev.33/visuals/`.

These shared-component visual checks run on Windows. Native macOS/Linux qualification remains outstanding. This is a desktop UI update; it uses the existing dev.32 CLI sidecar and does not change the installed standalone CLI or VS Code extension.

## Installed Windows package

Desktop **2.0.0-dev.33** is installed; installer exit **0**. Native packaged checks passed font loading through the desktop asset protocol, Build/Plan, all Settings pages, light/dark theme switching, Recent tasks and real local MCP save/connect/tool discovery/disconnect/reconnect/refresh/remove, including adding a connection from session details. No model inference was sent.

Normal installed-profile checks passed font loading, Settings, account navigation, MCP API/form, session Extensions menus and Recent tasks search/reopening/commands. **15 saved tasks** and the selected `nightowl` dark theme were preserved. No renderer errors were observed. The installed font license is present at `resources/licenses/KeaniaOne-OFL.txt`.

Installed desktop archive matches the tested package SHA-256:
`FFA65009F6DDAF751F234B37F00F1175C56BCF40F4E5D5B1AA0B72BB164964D9`.

The desktop installer is `artifacts/platforms/2.0.0-dev.33/win32-x64/desktop/subi-desktop-win-x64.exe`. Native qualification is saved beside that directory as `desktop-qualification.json`; installed checks are in `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev33/installed-result.json`. Standalone CLI remains dev.32 and VS Code remains 2.0.3.
