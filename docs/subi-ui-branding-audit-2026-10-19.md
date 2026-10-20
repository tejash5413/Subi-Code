# SubiCode user-facing branding audit

The expanded audit checks any case of the `opencode` substring, including digits and inflected suffixes. The earlier whole-word check missed `opencode2` and some translated forms.

## Changes

- Localized CLI installation messages now name the actual `subi` command rather than `opencode2`.
- WSL missing/cannot-run messages display SubiCode while retaining the surrounding translation and grammatical suffixes.
- Worktree settings display `$SUBI_WORKTREE_BASE` and `$SUBI_WORKTREE_PATH`. Startup commands receive those variables with the same values as their existing `OPENCODE_…` counterparts; old scripts remain compatible.
- The CLI internal-plugin list, its failure notice and diagnostic source labels present SubiCode names. Selection keys, registered plugin IDs, activation/deactivation targets and source references stay unchanged internally. Search accepts the visible name as well as the original target.
- The packaged qualification harness checks that all twelve Settings sections and the Add MCP form contain no OpenCode text in its disposable profile.

These presentation changes do not rewrite user content, external plugin identities, provider responses or required legal notices. Backend imports, protocols, storage paths and compatibility IDs remain intact.

## Source verification

The real presentation branding layer was applied to all available dictionaries:

| Area | Catalogs | Messages | Remaining substring matches |
| --- | ---: | ---: | ---: |
| Application | 63 | 54,655 | 0 |
| Shared UI | 63 | 16,040 | 0 |
| GUI extensions | 633 | 17,789 | 0 |
| Total | 759 | 88,484 | 0 |

Before the fix, the expanded check found 62 localized installation messages, seven WSL messages, and 126 Worktree-variable hints. The presentation regression cases failed before the correction and then passed: 70 tests across ten repetitions. The existing real Worktree setup-script test failed with missing SubiCode variables before the backend aliases; the complete Worktree suite then passed 35 tests, retaining the old-variable coverage too.

Installed dev.32 CLI help was also audited: root help and twelve subcommand help pages had no OpenCode matches. VS Code's product metadata and command labels use SubiCode/Subi Code. Required upstream copyright credits remain in license files.

Source changes are shared across desktop platforms. Native macOS/Linux and Windows ARM64 verification is still pending; Windows qualification and installation results are appended below after package checks.

## Final Windows qualification and installation

Windows CLI and desktop **2.0.0-dev.34**, plus VS Code extension **2.0.4**, are installed. Desktop installer exit: **0**.

- Final root `bun run check`: **36 successful tasks**.
- Packaged desktop: startup, Build/Plan, all twelve Settings sections and Add MCP connection passed. The qualification additionally asserted no `opencode` substring in those Settings sections or the MCP form.
- Packaged VSIX: isolated installation, commands, native bundled CLI startup and terminal reuse passed.
- Normal installed profile: font loading, all Settings pages, account navigation, MCP API/form, session Extensions menus and Recent tasks search/reopening/commands passed. Fifteen tasks and the existing `nightowl` dark theme were preserved. No renderer errors or model inference calls.
- Installed CLI, desktop sidecar and extension CLI all match SHA-256 `AF5B4492072136F375E3661977F0387FD332AA8E5BDBDE82CDEADADBF10DB19F`.
- Installed desktop archive matches the tested package SHA-256 `9C402F4C05368616AD7CB591FA863CBA3F5BABA9494A2070CB6082928FFC3E21`.

Artifacts and packaged native results: `artifacts/platforms/2.0.0-dev.34/win32-x64/`, with `packages/qualification.json` recording the native status. Full dictionary counts are in the sibling `branding/catalogs.json`. Installed-profile results are copied to `win32-x64/installed-qualification.json`; local logs remain under `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/`.
