import { ProjectSearchService } from '../../services/ProjectSearchService';
import { ToolDefinition, ToolError, ToolResult } from '../ToolTypes';

/**
 * Phase 10A: search_text tool.
 * Reuses ProjectSearchService for both filename and content search.
 * The existing service enforces 2-200 char query, 100/200 result caps,
 * 8-way concurrency, and silent skip of binary / oversized files.
 */

const MAX_QUERY_LENGTH = 200;

export interface SearchTextMatch {
  displayPath: string;
  line?: number;
  preview?: string;
}

export interface SearchTextPayload {
  mode: 'files' | 'content';
  count: number;
  matches: SearchTextMatch[];
  truncated: boolean;
}

export function createSearchTextTool(projectSearchService: ProjectSearchService): ToolDefinition<Record<string, unknown>, SearchTextPayload> {
  return {
    metadata: {
      name: 'search_text',
      description: 'Search for a string across the workspace (file names or file contents).',
      category: 'search',
      permission: 'read',
      availableInModes: ['ask', 'plan'],
      inputSchema: [
        {
          name: 'query',
          type: 'query',
          required: true,
          description: 'Search query (2-200 characters).',
          maxLength: MAX_QUERY_LENGTH,
        },
        {
          name: 'mode',
          type: 'string',
          required: false,
          description: '"files" matches file names; "content" searches inside files. Defaults to "content".',
        },
      ],
      displayLabel: 'Search Text',
      locked: false,
    },
    async execute(args) {
      const query = args['query'];
      const modeRaw = args['mode'];
      if (typeof query !== 'string' || query.trim().length < 2) {
        throw new ToolError('TOOL_INVALID_ARGUMENTS', 'Query must be at least 2 characters.', 'search_text');
      }
      let mode: 'files' | 'content' = 'content';
      if (typeof modeRaw === 'string') {
        if (modeRaw !== 'files' && modeRaw !== 'content') {
          throw new ToolError('TOOL_INVALID_ARGUMENTS', 'Mode must be "files" or "content".', 'search_text');
        }
        mode = modeRaw;
      }
      const results = mode === 'files'
        ? await projectSearchService.searchFiles(query)
        : await projectSearchService.searchContent(query);
      const max = mode === 'files' ? 100 : 200;
      const truncated = results.length > max;
      const slice = truncated ? results.slice(0, max) : results;
      return {
        mode,
        count: slice.length,
        matches: slice.map((r) => ({
          displayPath: r.displayPath,
          line: r.line,
          preview: r.preview,
        })),
        truncated,
      };
    },
  };
}

export type SearchTextResult = ToolResult<SearchTextPayload>;
