import { ToolDefinition } from '../../tools/ToolTypes';
import { AgentModelInputField, AgentModelToolDefinition } from './AgentModelTypes';

/**
 * Phase 10B.1: safe projection from host ToolDefinition to a model-facing
 * AgentModelToolDefinition.
 *
 * The projection is intentionally lossy. The model never sees:
 *   - the `execute` function
 *   - permission internals
 *   - host dependencies
 *   - locked tools
 *   - the agent mode filter (the gateway filters before calling this)
 *   - implementation paths or absolute machine paths
 *
 * The result is the only object the gateway hands to a provider codec.
 */
export function toAgentModelToolDefinition(
  tool: ToolDefinition
): AgentModelToolDefinition {
  const m = tool.metadata;
  const inputSchema: AgentModelInputField[] = m.inputSchema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    description: f.description,
    ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
  }));
  return {
    name: m.name,
    description: m.description,
    inputSchema,
  };
}

/** Project a list of tool definitions; preserves order. */
export function toAgentModelToolDefinitions(
  tools: ReadonlyArray<ToolDefinition>
): AgentModelToolDefinition[] {
  const out: AgentModelToolDefinition[] = [];
  for (const t of tools) {
    out.push(toAgentModelToolDefinition(t));
  }
  return out;
}
