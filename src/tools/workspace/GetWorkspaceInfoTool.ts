import type { WorkspaceService } from '../../services/WorkspaceService';
import { ToolDefinition, ToolError, ToolResult } from '../ToolTypes';

/**
 * Phase 10A: get_workspace_info tool.
 * Returns safe project data (no absolute machine paths).
 */
export interface WorkspaceInfoPayload {
  name: string;
  projectType: string;
  workspaceFolderCount: number;
  isMultiRoot: boolean;
}

export function createGetWorkspaceInfoTool(workspaceService: WorkspaceService): ToolDefinition<Record<string, never>, WorkspaceInfoPayload> {
  return {
    metadata: {
      name: 'get_workspace_info',
      description: 'Return the current workspace summary: name, project type, and root count.',
      category: 'workspace',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [],
      displayLabel: 'Workspace Info',
      locked: false,
    },
    async execute() {
      const info = await workspaceService.getCurrentWorkspaceInfo();
      if (!info) {
        throw new ToolError('WORKSPACE_NOT_OPEN', 'No workspace is open.', 'get_workspace_info');
      }
      return {
        name: info.name,
        projectType: info.projectType,
        workspaceFolderCount: info.workspaceFolderCount,
        isMultiRoot: info.isMultiRoot,
      };
    },
  };
}

export type GetWorkspaceInfoResult = ToolResult<WorkspaceInfoPayload>;
