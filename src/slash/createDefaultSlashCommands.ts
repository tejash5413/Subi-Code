import { SlashCommandDefinition } from './SlashCommandTypes';

/**
 * Phase 10A: default slash commands.
 *
 * Only the metadata is registered here. The EXECUTION of each command
 * (e.g. /search → search_text tool, /ask → switch agentMode) lives in
 * the host dispatcher (SidebarProvider). The webview sends a typed
 * message; it never executes.
 *
 * Note: /files, /read, /search are user-initiated tool executions in
 * Phase 10A — they invoke the corresponding registered tool host-side.
 * There is no model in the loop.
 */
export function createDefaultSlashCommands(): SlashCommandDefinition[] {
  return [
    // MODE
    {
      name: '/ask',
      description: 'Switch to ASK mode (read-only questions and inspection).',
      category: 'mode',
      available: true,
      agentModes: ['ask'],
    },
    {
      name: '/plan',
      description: 'Switch to PLAN mode (read-only plan generation, no writes).',
      category: 'mode',
      available: true,
      agentModes: ['plan'],
    },
    {
      name: '/build',
      description: 'Switch to BUILD mode (locked in Phase 10A).',
      category: 'mode',
      available: false,
      agentModes: ['build'],
      unavailableReason: 'Build mode is locked. Available after safe write/patch support is added.',
    },

    // TOOLS
    {
      name: '/tools',
      description: 'Show the list of registered tools and their availability.',
      category: 'tools',
      available: true,
    },
    {
      name: '/files',
      description: 'List project files (invokes the find_files tool).',
      category: 'tools',
      argumentHint: '/files [filter]',
      available: true,
    },
    {
      name: '/read',
      description: 'Read a text file by workspace-relative path (invokes the read_file tool).',
      category: 'tools',
      argumentHint: '/read <relative-path>',
      available: true,
    },
    {
      name: '/search',
      description: 'Search file names or contents (invokes the search_text tool).',
      category: 'tools',
      argumentHint: '/search <query> [files|content]',
      available: true,
    },

    // PROJECT
    {
      name: '/context',
      description: 'Show current safe context: workspace, mode, model, recent tool activity.',
      category: 'context',
      available: true,
    },

    // SESSION
    {
      name: '/clear',
      description: 'Clear the current chat history (per active access mode).',
      category: 'session',
      available: true,
    },
    {
      name: '/help',
      description: 'Show available commands and current agent mode.',
      category: 'session',
      available: true,
    },

    // COMING SOON
    {
      name: '/diff',
      description: 'Show a unified diff for the working tree (Phase 19).',
      category: 'coming soon',
      available: false,
      unavailableReason: 'Available after Git support is added.',
    },
    {
      name: '/terminal',
      description: 'Open a terminal session in the workspace (Phase 16).',
      category: 'coming soon',
      available: false,
      unavailableReason: 'Available after terminal support is added.',
    },
    {
      name: '/git',
      description: 'Show git status (Phase 19).',
      category: 'coming soon',
      available: false,
      unavailableReason: 'Available after Git support is added.',
    },
    {
      name: '/tests',
      description: 'Run project tests (Phase 17).',
      category: 'coming soon',
      available: false,
      unavailableReason: 'Available after test-runner support is added.',
    },
  ];
}
