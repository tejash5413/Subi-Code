import { ProjectFileService } from '../../services/ProjectFileService';
import { ToolDefinition, ToolError, ToolResult } from '../ToolTypes';

/**
 * Phase 10A: find_files tool.
 * Reuses ProjectFileService registry (which is symlink-resolved, 2000-file capped,
 * excludes .git / node_modules / out / dist / build / .venv / target / .gradle /
 * vendor / __pycache__).
 *
 * Optional relative-path prefix filter (substring match, case-insensitive).
 * vscode-free so the file is unit-testable.
 */

const MAX_RESULTS = 200;
const MAX_ARG_LENGTH = 200;

export interface FindFilesPayload {
  count: number;
  items: Array<{ displayPath: string; workspaceFolderName: string }>;
  truncated: boolean;
}

export function createFindFilesTool(projectFileService: ProjectFileService): ToolDefinition<Record<string, unknown>, FindFilesPayload> {
  return {
    metadata: {
      name: 'find_files',
      description: 'List project files. Optionally filter by a substring of the relative path.',
      category: 'files',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [
        {
          name: 'filter',
          type: 'query',
          required: false,
          description: 'Optional case-insensitive substring of the relative path.',
          maxLength: MAX_ARG_LENGTH,
        },
      ],
      displayLabel: 'Find Files',
      locked: false,
    },
    async execute(args) {
      // Ensure the registry is populated (delegates to ProjectFileService).
      const all = await projectFileService.ensureFilesListed();
      if (all.length === 0) {
        throw new ToolError('WORKSPACE_NOT_OPEN', 'No workspace is open.', 'find_files');
      }
      const filter = typeof args['filter'] === 'string' ? (args['filter'] as string).toLowerCase() : '';
      const filtered = filter
        ? all.filter((f) => f.displayPath.toLowerCase().includes(filter))
        : all;
      const truncated = filtered.length > MAX_RESULTS;
      const slice = truncated ? filtered.slice(0, MAX_RESULTS) : filtered;
      return {
        count: slice.length,
        items: slice.map((f) => ({
          displayPath: f.displayPath,
          workspaceFolderName: f.workspaceFolderName,
        })),
        truncated,
      };
    },
  };
}

export type FindFilesResult = ToolResult<FindFilesPayload>;
