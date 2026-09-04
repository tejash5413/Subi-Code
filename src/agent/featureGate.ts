/**
 * Phase 10B: feature gate for autonomous agent read-tool loop.
 *
 * Independent of MANAGED_CHAT_ENABLED (which protects managed chat plumbing).
 * This gate protects the agent runtime that lets the model call SUBI tools.
 *
 * Phase 10B.1 default: false. The agent runtime is built and tested behind
 * this flag. No composer routing, no webview wiring.
 */
export const AGENT_READ_TOOLS_ENABLED = false;
