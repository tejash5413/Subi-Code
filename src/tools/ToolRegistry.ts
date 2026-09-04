import { AgentMode } from '../agent/AgentMode';
import { ToolDefinition, ToolError, ToolMetadata } from './ToolTypes';

/**
 * Phase 10A: provider-independent tool registry.
 *
 * Owns the source-of-truth list of registered tools. Safe metadata is the
 * only thing exposed to the webview. The executor is the only component
 * allowed to invoke a tool; the registry never holds execution authority.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** Register a tool. Rejects duplicates. */
  public register<TArgs, TOutput>(tool: ToolDefinition<TArgs, TOutput>): void {
    if (!tool || typeof tool !== 'object') {
      throw new Error('Tool definition must be an object.');
    }
    const meta = tool.metadata;
    if (!meta || typeof meta.name !== 'string' || meta.name.length === 0) {
      throw new Error('Tool metadata.name is required.');
    }
    if (this.tools.has(meta.name)) {
      throw new ToolError('INTERNAL', `Tool "${meta.name}" is already registered.`, meta.name);
    }
    this.tools.set(meta.name, tool as unknown as ToolDefinition);
  }

  /** True if a tool with this name is registered. */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get a tool by name. */
  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** All registered tool metadata. Defensive shallow copy per entry. */
  public listMetadata(): ToolMetadata[] {
    const out: ToolMetadata[] = [];
    for (const tool of this.tools.values()) {
      out.push({ ...tool.metadata });
    }
    out.sort((a, b) => {
      if (a.category === b.category) {
        return a.name.localeCompare(b.name);
      }
      return a.category.localeCompare(b.category);
    });
    return out;
  }

  /** List tools filtered by category. */
  public listByCategory(category: ToolMetadata['category']): ToolMetadata[] {
    return this.listMetadata().filter((m) => m.category === category);
  }

  /** List tools that are available in the given agent mode and not locked. */
  public listForMode(mode: AgentMode): ToolMetadata[] {
    return this.listMetadata().filter(
      (m) => !m.locked && m.availableInModes.includes(mode)
    );
  }

  /**
   * Validate that a tool is available to invoke in the given mode and is
   * not locked. Returns the tool, or throws a ToolError.
   */
  public resolveForInvocation(name: string, mode: AgentMode): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`, name);
    }
    if (tool.metadata.locked) {
      throw new ToolError(
        'TOOL_LOCKED',
        tool.metadata.lockedReason ?? `Tool "${name}" is currently locked.`,
        name
      );
    }
    if (!tool.metadata.availableInModes.includes(mode)) {
      throw new ToolError(
        'TOOL_NOT_ALLOWED',
        `Tool "${name}" is not available in ${mode} mode.`,
        name
      );
    }
    return tool;
  }

  /** Total number of registered tools. */
  public size(): number {
    return this.tools.size;
  }
}
