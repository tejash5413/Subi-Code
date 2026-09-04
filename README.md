# Subi - Stage 1

Subi is a VS Code extension that aims to become a software development assistant similar to Cursor, Blackbox, Codex, Claude Code, and Emergent.

## Stage 1 Status

This is **Stage 1** - a UI shell only. Currently implemented:

- Activity Bar icon (Subi)
- Sidebar with:
  - SUBI header
  - Recent Tasks section (empty state: "No recent tasks")
  - Chat input with placeholder "Ask Subi anything..."
  - Send button (enabled when input has text)
  - Model selector showing "Auto" (disabled in Stage 1)
- Basic message passing from webview to extension (logged to console)

**Not yet implemented** (future stages):
- AI API connections (OpenRouter, Kimi, Claude, OpenAI, etc.)
- Terminal execution
- File editing
- Git operations
- Project scanning
- Code generation
- Autonomous agents

## Getting Started

### Prerequisites
- Node.js 20+
- VS Code 1.85+

### Installation

```bash
npm install
```

### Compilation

```bash
npm run compile
```

### Development (Watch Mode)

```bash
npm run watch
```

### Launch with F5

1. Open this folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. In the new window, click the Subi icon in the Activity Bar (left sidebar)
4. The Subi sidebar will open with the Stage 1 UI

## Project Structure

```
subi/
├── .vscode/
│   ├── launch.json      # F5 debug configuration
│   └── tasks.json       # Build tasks
├── src/
│   ├── extension.ts           # Extension entry point
│   ├── sidebar/
│   │   ├── SidebarProvider.ts # WebviewViewProvider implementation
│   │   └── SidebarView.ts     # HTML template generator
│   └── types/
│       └── index.ts           # Shared TypeScript interfaces
├── media/
│   ├── icon.svg         # Activity Bar icon
│   ├── sidebar.css      # Sidebar styles
│   └── sidebar.js       # Webview client-side JavaScript
├── package.json
├── tsconfig.json
└── .gitignore
```

## License

MIT