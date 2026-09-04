import * as vscode from 'vscode';
import { AgentMode, DEFAULT_AGENT_MODE, asAgentMode } from './AgentMode';

/**
 * Phase 10A: host-authoritative agent mode persistence.
 *
 * Mirrors the AccessModeService pattern (read/write subi.* keys in
 * globalState). Host is authority; the webview receives a safe mirror only.
 * Independent of accessMode — never conflated.
 */
export class AgentModeService {
  private readonly context: vscode.ExtensionContext;
  private static readonly STORAGE_KEY = 'subi.agentMode';
  private static readonly STATE_KEY = 'subi.agentMode.active';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public getAgentMode(): AgentMode {
    const stored = asAgentMode(this.context.globalState.get<unknown>(AgentModeService.STORAGE_KEY));
    return stored ?? DEFAULT_AGENT_MODE;
  }

  public async setAgentMode(mode: AgentMode): Promise<AgentMode> {
    const safe = asAgentMode(mode) ?? DEFAULT_AGENT_MODE;
    await this.context.globalState.update(AgentModeService.STORAGE_KEY, safe);
    return safe;
  }

  public async clearAgentMode(): Promise<void> {
    await this.context.globalState.update(AgentModeService.STORAGE_KEY, undefined);
  }

  /** In-memory mirror for the active webview (not persisted). */
  public getActiveMirror(): AgentMode {
    const session = this.context.globalState.get<unknown>(AgentModeService.STATE_KEY);
    return asAgentMode(session) ?? this.getAgentMode();
  }

  public async setActiveMirror(mode: AgentMode): Promise<void> {
    const safe = asAgentMode(mode) ?? DEFAULT_AGENT_MODE;
    await this.context.globalState.update(AgentModeService.STATE_KEY, safe);
  }
}
