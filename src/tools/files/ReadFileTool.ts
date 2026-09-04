import { ProjectFileService } from '../../services/ProjectFileService';
import { ToolDefinition, ToolError, ToolResult } from '../ToolTypes';
import { isSecretFilePath } from './SecretFileGuard';

/**
 * Phase 10A: read_file tool.
 * Reuses ProjectFileService's existing read pipeline (1MB cap, binary
 * rejection, strict UTF-8). Resolution is done via the new
 * resolveRegisteredFileIdByPath adapter, which can only return files
 * already enumerated by vscode.workspace.findFiles with the standard
 * exclude patterns — so by construction the result is inside a workspace
 * folder and never a system/.git/etc path.
 *
 * Secret files (.env, *.pem, *.key, service-account*.json, …) are blocked
 * before any read.
 */

const MAX_PATH_LENGTH = 1000;
const MAX_PREVIEW_CHARS = 4000;

export interface ReadFilePayload {
  displayPath: string;
  size: number;
  content: string;
  truncated: boolean;
}

export function createReadFileTool(projectFileService: ProjectFileService): ToolDefinition<Record<string, unknown>, ReadFilePayload> {
  return {
    metadata: {
      name: 'read_file',
      description: 'Read a text file from the workspace by its relative path.',
      category: 'files',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [
        {
          name: 'path',
          type: 'path',
          required: true,
          description: 'Workspace-relative path of the file to read.',
          maxLength: MAX_PATH_LENGTH,
        },
      ],
      displayLabel: 'Read File',
      locked: false,
    },
    async execute(args) {
      const path = args['path'];
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new ToolError('TOOL_INVALID_ARGUMENTS', 'A non-empty "path" is required.', 'read_file');
      }
      const trimmed = path.trim();
      if (isSecretFilePath(trimmed)) {
        throw new ToolError('SECRET_FILE_BLOCKED', 'Refusing to read a known secret file.', 'read_file');
      }
      const fileId = await projectFileService.resolveRegisteredFileIdByPath(trimmed);
      if (!fileId) {
        throw new ToolError('FILE_NOT_FOUND', `File not found in workspace: ${trimmed}`, 'read_file');
      }
      const result = await projectFileService.readFile(fileId);
      if ('type' in result) {
        switch (result.type) {
          case 'notFound':
            throw new ToolError('FILE_NOT_FOUND', 'File not found.', 'read_file');
          case 'tooLarge':
            throw new ToolError('FILE_TOO_LARGE', 'File is too large to read.', 'read_file');
          case 'binary':
            throw new ToolError('BINARY_FILE', 'Binary files cannot be read as text.', 'read_file');
          case 'encoding':
            throw new ToolError('BINARY_FILE', 'File is not valid UTF-8 text.', 'read_file');
          case 'validation':
            throw new ToolError('TOOL_INVALID_ARGUMENTS', result.message, 'read_file');
          default:
            throw new ToolError('INTERNAL', result.message, 'read_file');
        }
      }
      const content = result.content;
      const truncated = content.length > MAX_PREVIEW_CHARS;
      return {
        displayPath: result.displayPath,
        size: result.size,
        content: truncated ? `${content.slice(0, MAX_PREVIEW_CHARS)}\n…` : content,
        truncated,
      };
    },
  };
}

export type ReadFileResult = ToolResult<ReadFilePayload>;
