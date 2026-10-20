# Plugin and Skill Setup Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Work inline; the user has requested no subagent work.

**Goal:** Replace configure-file shortcuts for plugins and skills with usable SubiCode setup forms in the desktop/web shared UI and CLI.

**Architecture:** Extend the existing typed global configuration patch endpoint with atomic per-source plugin/skill changes. Reuse existing plugin loading and skill discovery. A shared GUI form serves Settings and session details; CLI dialogs use the same patch contract. Global configuration changes reload through existing events.

**Tech Stack:** Bun, Effect schemas/services, SolidJS, OpenTUI, existing generated clients and JSONC editor.

**Spec:** User-approved in-chat design: Add plugin (package/local source and optional settings) and Add skill (folder/compatible collection URL), matching Add MCP connection styling and keeping current functionality.

## Global Constraints

- Shared Windows/macOS/Linux implementation, including CLI and the extension's bundled CLI.
- SubiCode branding; keep backend protocol/config identities compatible.
- Keep JSONC comments, unrelated settings and project configuration intact.
- Remote setup writes to the selected server, not the desktop machine.
- Existing plugin/skill discovery and third-party code behavior remain unchanged.
- No real-account changes or external plugin installation during verification; use disposable local fixtures.
- Run client generation after changing the public configuration payload.
- Native Mac/Linux qualification remains pending available native hosts.

## Review Focus

- Existing settings, concurrent source edits and duplicate submissions must not be lost.
- Earlier global documents must not resurrect removed sources; handle supported legacy source declarations.
- Invalid settings JSON/source URLs must stay in the form with actionable feedback.
- Saved configuration is distinct from successful plugin activation or skill discovery.
- Empty inventories and session/remote menus must still expose Add actions with keyboard access.

### Task 1: Typed source persistence

**Files:** schema/config.ts, core/config.ts, server/test/config.test.ts, generated client files.

- [x] Add failing real HTTP tests for plugin/skill add/edit/remove, duplicates, preservation and reload.
- [x] Extend Config.Patch with keyed plugin options/null and skill add/remove flags.
- [x] Apply source changes under the existing global update lock using JSONC edits.
- [x] Generate clients and pass targeted server tests.

### Task 2: Shared GUI forms and Settings

**Files:** ui/forms/extension-source-form.tsx, UI export/i18n, app/settings/providers/extensions.tsx and supporting source list module.

- [x] Build one source form with plugin options or skill folder/URL fields, validation and error/busy/cancel states.
- [x] Replace manage-file prompts with Add plugin/Add skill, source lists and edit/remove/refresh actions.
- [x] Show configured and runtime status without claiming failed plugins loaded.
- [x] Verify actual forms with local fixtures and invalid submissions.

### Task 3: Session details and project entry points

**Files:** gui-extensions/details/server-panel.tsx, app/settings/workspaces/project-extensions.tsx, English source messages.

- [x] Replace Plugins/Skills configure actions with the shared form, including empty inventories and remote sessions.
- [x] Save through the selected session server and refresh its inventory.
- [x] Retain LSP configuration behavior.

### Task 4: CLI forms

**Files:** tui/component/dialog-extension-source.tsx, dialog-skill.tsx, feature-plugins/system/plugins.tsx.

- [x] Add keyboard-accessible Add plugin/Add skill dialogs using current prompt and list components.
- [x] Validate input and save through the current server, retaining existing plugin and skill actions.
- [x] Refresh inventories and keep failures visible.

### Task 5: Integration and UI verification

- [x] Run named backend/form keeper tests and canonical root check.
- [x] Exercise Settings/session/CLI forms with local plugin and skill fixtures; verify persistence across reopen.
- [x] Verify small/light/dark layouts and unchanged MCP behavior.

### Task 6: Package, install and handoff

- [x] Build matching Windows CLI/VSIX/desktop artifacts and qualify their native startup.
- [x] Install the tested Windows packages; verify installed hashes and preserved normal-profile state.
- [x] Record evidence and native platform limits in the handoff.
