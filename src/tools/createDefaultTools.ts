import { ProjectFileService } from '../services/ProjectFileService';
import { ProjectSearchService } from '../services/ProjectSearchService';
import { WorkspaceService } from '../services/WorkspaceService';
import { ToolDefinition, ToolMetadata } from './ToolTypes';
import { createFindFilesTool } from './files/FindFilesTool';
import { createReadFileTool } from './files/ReadFileTool';
import { createSearchTextTool } from './search/SearchTextTool';
import { createGetWorkspaceInfoTool } from './workspace/GetWorkspaceInfoTool';

/**
 * Phase 10A: tool factories.
 *
 * LOCKED FUTURE TOOLS (not registered, listed only in /tools panel):
 *  - get_diagnostics   (Phase 17)
 *  - propose_patch     (Phase 14)
 *  - apply_patch       (Phase 15)
 *  - run_command       (Phase 16)
 *  - terminal_status   (Phase 16)
 *  - git_status        (Phase 19)
 *  - git_diff          (Phase 19)
 *  - run_tests         (Phase 17)
 */

export interface ToolRegistryPorts {
  workspaceService: WorkspaceService;
  projectFileService: ProjectFileService;
  projectSearchService: ProjectSearchService;
}

/** Tools that are actually callable today (Phase 10A). */
export function createDefaultTools(ports: ToolRegistryPorts): ToolDefinition[] {
  return [
    createGetWorkspaceInfoTool(ports.workspaceService),
    createFindFilesTool(ports.projectFileService),
    createReadFileTool(ports.projectFileService),
    createSearchTextTool(ports.projectSearchService),
  ];
}

/** Metadata for callable tools (created via the factory). */
export function listCallableMetadata(ports: ToolRegistryPorts): ToolMetadata[] {
  return createDefaultTools(ports).map((t) => t.metadata);
}

/** Static catalogue of locked future tools (not executable). */
export function listLockedMetadata(): ToolMetadata[] {
  return [
    {
      name: 'get_diagnostics',
      description: 'Return language diagnostics for a file or workspace (Phase 17).',
      category: 'diagnostics',
      permission: 'read',
      availableInModes: ['ask', 'plan', 'build'],
      inputSchema: [{ name: 'path', type: 'path', required: false, description: 'Optional file path.' }],
      displayLabel: 'Get Diagnostics',
      locked: true,
      lockedReason: 'Available after diagnostics support is added.',
    },
    {
      name: 'propose_patch',
      description: 'Generate a unified diff without writing to disk (Phase 14).',
      category: 'edit',
      permission: 'read',
      availableInModes: ['plan', 'build'],
      inputSchema: [{ name: 'path', type: 'path', required: true, description: 'File to patch.' }],
      displayLabel: 'Propose Patch',
      locked: true,
      lockedReason: 'Available after the patch engine is added.',
    },
    {
      name: 'apply_patch',
      description: 'Write a proposed patch to disk (Phase 15, approval required).',
      category: 'edit',
      permission: 'write',
      availableInModes: ['build'],
      inputSchema: [],
      displayLabel: 'Apply Patch',
      locked: true,
      lockedReason: 'Available after safe write/approval support is added.',
    },
    {
      name: 'run_command',
      description: 'Run a shell command (Phase 16, approval required).',
      category: 'terminal',
      permission: 'execute',
      availableInModes: ['build'],
      inputSchema: [],
      displayLabel: 'Run Command',
      locked: true,
      lockedReason: 'Available after terminal support is added.',
    },
    {
      name: 'terminal_status',
      description: 'Return the status of a terminal session (Phase 16).',
      category: 'terminal',
      permission: 'read',
      availableInModes: ['build'],
      inputSchema: [],
      displayLabel: 'Terminal Status',
      locked: true,
      lockedReason: 'Available after terminal support is added.',
    },
    {
      name: 'git_status',
      description: 'Return git status for the workspace (Phase 19).',
      category: 'git',
      permission: 'read',
      availableInModes: ['ask', 'plan', 'build'],
      inputSchema: [],
      displayLabel: 'Git Status',
      locked: true,
      lockedReason: 'Available after Git support is added.',
    },
    {
      name: 'git_diff',
      description: 'Return a unified diff for the working tree (Phase 19).',
      category: 'git',
      permission: 'read',
      availableInModes: ['ask', 'plan', 'build'],
      inputSchema: [],
      displayLabel: 'Git Diff',
      locked: true,
      lockedReason: 'Available after Git support is added.',
    },
    {
      name: 'run_tests',
      description: 'Run a project test command and parse results (Phase 17).',
      category: 'tests',
      permission: 'execute',
      availableInModes: ['build'],
      inputSchema: [],
      displayLabel: 'Run Tests',
      locked: true,
      lockedReason: 'Available after test-runner support is added.',
    },
  ];
}

/** Full catalogue (callable + locked), sorted by category then name. */
export function listFullToolCatalog(ports: ToolRegistryPorts): ToolMetadata[] {
  const out = [...listCallableMetadata(ports), ...listLockedMetadata()];
  out.sort((a, b) => {
    if (a.category === b.category) {
      return a.name.localeCompare(b.name);
    }
    return a.category.localeCompare(b.category);
  });
  return out;
}
