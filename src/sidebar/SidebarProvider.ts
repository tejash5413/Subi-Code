import * as vscode from 'vscode';
import { SidebarView } from './SidebarView';
import { WorkspaceService } from '../services/WorkspaceService';
import { ProjectFileService } from '../services/ProjectFileService';
import { ProjectSearchService } from '../services/ProjectSearchService';
import { AccessModeService } from '../services/AccessModeService';
import { AIService, PreparedStream } from '../services/ai/AIService';
import { SecretStorageService } from '../services/SecretStorageService';
import { AttachmentService } from '../services/attachments/AttachmentService';
import { LearnSmartAuthService } from '../services/auth/LearnSmartAuthService';
import { SubiIdentity } from '../types';
import { isLearnSmartMode as isLearnSmartAccessMode } from '../services/accessModeGates';
import { AIProviderRegistry } from '../services/ai/AIProviderRegistry';
import { ModelCatalogService } from '../services/ai/ModelCatalogService';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, WorkspaceInfo, ProjectSearchResult, AIProviderId } from '../types';
import { OnboardingStateMachine } from '../ui/onboarding/OnboardingState';
import { isSupportedProviderId, getProviderCredentialLabel, getProviderLabel } from '../config/providers';
import { AIErrorClass } from '../services/ai/AIError';
import { ManagedSessionController, toManagedWebviewState } from '../services/managed/managedSessionController';
import type { LearnSmartManagedService } from '../services/managed/learnsmartManagedService';
import { ManagedChatController } from '../services/managed/managedChatController';
import { MANAGED_ABSOLUTE_MAX_MS as MANAGED_STREAM_ABSOLUTE_MAX_MS, MANAGED_CHAT_ENABLED } from '../services/managed/managedChatService';
// Phase 10A: agent shell
import { AgentMode, isAgentMode, DEFAULT_AGENT_MODE } from '../agent/AgentMode';
import { AgentModeService } from '../agent/AgentModeService';
import { SlashCommandRegistry } from '../slash/SlashCommandRegistry';
import { createDefaultSlashCommands } from '../slash/createDefaultSlashCommands';
import { parseSlashInput } from '../slash/SlashCommandParser';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import { listFullToolCatalog } from '../tools/createDefaultTools';
import { createDefaultTools } from '../tools/createDefaultTools';
import { RecentToolActivity } from '../tools/RecentToolActivity';
import { ToolActivity } from '../tools/ToolTypes';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'subi.sidebar';

  private readonly extensionUri: vscode.Uri;
  private readonly sidebarView: SidebarView;
  private readonly workspaceService: WorkspaceService;
  private readonly projectFileService: ProjectFileService;
  private readonly projectSearchService: ProjectSearchService;
  private readonly accessModeService: AccessModeService;
  private readonly aiService: AIService;
  private readonly secretStorageService: SecretStorageService;
  private readonly attachmentService: AttachmentService;
  private readonly learnSmartAuthService: LearnSmartAuthService;
  private readonly registry: AIProviderRegistry;
  private readonly catalogs: ModelCatalogService;
  private readonly managedService: LearnSmartManagedService;
  private readonly managedController: ManagedSessionController;
  private readonly managedChatController = new ManagedChatController();
  private readonly onboardingStateMachine: OnboardingStateMachine;
  // Phase 10A: agent shell
  private readonly agentModeService: AgentModeService;
  private readonly slashCommandRegistry: SlashCommandRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly recentToolActivity: RecentToolActivity;
  private webviewView: vscode.WebviewView | undefined;
  private outputChannel: vscode.OutputChannel;
  private workspaceChangeListener: vscode.Disposable | undefined;
  private latestSearchRequestId = 0;
  private latestChatRequestId = 0;
  private isChatActive = false;
  private activeStreamController: AbortController | null = null;
  private static readonly STREAM_BATCH_MS = 24;
  private static readonly STREAM_BATCH_CHARS = 64;
  private static readonly STREAM_INACTIVITY_MS = 90_000;
  private static readonly STREAM_ABSOLUTE_MAX_MS = 600_000;

  constructor(
    extensionUri: vscode.Uri,
    workspaceService: WorkspaceService,
    projectFileService: ProjectFileService,
    projectSearchService: ProjectSearchService,
    accessModeService: AccessModeService,
    aiService: AIService,
    secretStorageService: SecretStorageService,
    registry: AIProviderRegistry,
    catalogs: ModelCatalogService,
    attachmentService: AttachmentService,
    learnSmartAuthService: LearnSmartAuthService,
    managedService: LearnSmartManagedService,
    managedController: ManagedSessionController,
    agentModeService: AgentModeService
  ) {
    this.extensionUri = extensionUri;
    this.sidebarView = new SidebarView(extensionUri);
    this.workspaceService = workspaceService;
    this.projectFileService = projectFileService;
    this.projectSearchService = projectSearchService;
    this.accessModeService = accessModeService;
    this.aiService = aiService;
    this.secretStorageService = secretStorageService;
    this.registry = registry;
    this.catalogs = catalogs;
    this.attachmentService = attachmentService;
    this.learnSmartAuthService = learnSmartAuthService;
    this.managedService = managedService;
    this.managedController = managedController;
    this.agentModeService = agentModeService;
    // Phase 10A: slash command registry
    this.slashCommandRegistry = new SlashCommandRegistry();
    for (const cmd of createDefaultSlashCommands()) {
      this.slashCommandRegistry.register(cmd);
    }
    // Phase 10A: tool registry + executor
    this.toolRegistry = new ToolRegistry();
    for (const tool of createDefaultTools({
      workspaceService: this.workspaceService,
      projectFileService: this.projectFileService,
      projectSearchService: this.projectSearchService,
    })) {
      this.toolRegistry.register(tool);
    }
    this.recentToolActivity = new RecentToolActivity();
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      (event: ToolActivity) => this.handleToolActivity(event)
    );
    // Managed bootstrap runs outside the constructor; every state
    // transition posts the safe projection (never tokens/keys/upstream IDs).
    this.managedController.onStateChanged = () => this.postManagedSession();
    this.onboardingStateMachine = new OnboardingStateMachine();
    this.outputChannel = vscode.window.createOutputChannel('Subi');
    // Sanitized auth diagnostics only: stage + safe Firebase/Firestore code.
    // Never email, password, tokens, UIDs, profiles, keys, or headers.
    this.learnSmartAuthService.onDiagnostic = (diagnostic) => {
      this.outputChannel.appendLine(
        `[LearnSmart Auth] stage=${diagnostic.stage} code=${diagnostic.code}`
      );
    };
  }

  private getCurrentAgentMode(): AgentMode {
    try {
      const mirror = this.agentModeService.getActiveMirror();
      return isAgentMode(mirror) ? mirror : DEFAULT_AGENT_MODE;
    } catch {
      return DEFAULT_AGENT_MODE;
    }
  }

  private handleToolActivity(event: ToolActivity): void {
    if (event.type === 'toolStarted') {
      this.postMessage({
        type: 'toolStarted',
        callId: event.callId,
        toolName: event.toolName,
        category: event.category,
        label: event.label,
      });
      return;
    }
    if (event.type === 'toolCompleted') {
      this.recentToolActivity.add({
        callId: event.callId,
        toolName: event.toolName,
        label: event.label,
        category: event.category,
        summary: event.summary,
        ok: true,
        durationMs: event.durationMs,
        timestamp: Date.now(),
      });
      this.postMessage({
        type: 'toolCompleted',
        callId: event.callId,
        toolName: event.toolName,
        category: event.category,
        label: event.label,
        durationMs: event.durationMs,
        ok: true,
        code: undefined,
        message: undefined,
        summary: event.summary,
        result: {
          ok: true,
          callId: event.callId,
          toolName: event.toolName,
          category: event.category,
          permission: 'read',
          label: event.label,
          summary: event.summary,
          durationMs: event.durationMs,
        },
      });
      return;
    }
    if (event.type === 'toolFailed') {
      this.recentToolActivity.add({
        callId: event.callId,
        toolName: event.toolName,
        label: event.label,
        category: event.category,
        summary: event.message,
        ok: false,
        code: event.code,
        message: event.message,
        durationMs: event.durationMs,
        timestamp: Date.now(),
      });
      this.postMessage({
        type: 'toolFailed',
        callId: event.callId,
        toolName: event.toolName,
        category: event.category,
        label: event.label,
        code: event.code,
        message: event.message,
        durationMs: event.durationMs,
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.sidebarView.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleMessage(message),
      undefined,
      []
    );

    this.workspaceChangeListener = this.workspaceService.onDidChangeWorkspace(
      (info: WorkspaceInfo | null) => this.onWorkspaceChange(info)
    );
  }

  private handleMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case 'ready':
        void this.handleReady();
        break;
      case 'sendMessage':
        void this.handleSendMessage(message);
        break;
      case 'requestFileList':
        void this.handleRequestFileList();
        break;
      case 'requestFileContent':
        void this.handleRequestFileContent(message);
        break;
      case 'requestSearch':
        void this.handleRequestSearch(message);
        break;
      case 'selectAccessMode':
        this.handleSelectAccessMode(message);
        break;
      case 'configureProvider':
        void this.handleConfigureProvider(message.provider);
        break;
      case 'removeProviderKey':
        void this.handleRemoveProviderKey(message.provider);
        break;
      case 'setProvider':
        void this.handleSetProvider(message.provider);
        break;
      case 'setModel':
        void this.handleSetModel(message);
        break;
      case 'requestModelCatalog':
        void this.handleCatalogRequest(message.provider, false);
        break;
      case 'refreshModelCatalog':
        void this.handleCatalogRequest(message.provider, true);
        break;
      case 'confirmModelCost':
        void this.handleConfirmCost(message.provider, message.modelId, message.confirmed);
        break;
      case 'clearChat':
        this.handleClearChat();
        break;
      case 'cancelChat':
        this.handleCancelChat(message.requestId);
        break;
      case 'resetOnboarding':
        void this.handleResetOnboarding();
        break;
      case 'requestAttachProjectFiles':
        void this.handleAttachProjectFiles();
        break;
      case 'requestAttachImages':
        void this.handleAttachImages();
        break;
      case 'removeChatAttachment':
        this.handleRemoveAttachment(message.attachmentId);
        break;
      case 'learnsmartSignIn':
        void this.handleLearnSmartSignIn(message.email, message.password);
        break;
      case 'learnsmartSignOut':
        void this.handleLearnSmartSignOut();
        break;
      case 'setManagedModel':
        void this.handleSetManagedModel(message);
        break;
      case 'retryManagedSession':
        void this.handleRetryManagedSession();
        break;
      // Phase 10A: agent shell
      case 'setAgentMode':
        void this.handleSetAgentMode(message.mode);
        break;
      case 'requestSlashCommands':
        this.handleRequestSlashCommands();
        break;
      case 'requestToolCatalog':
        this.handleRequestToolCatalog();
        break;
      case 'executeSlashCommand':
        void this.handleExecuteSlashCommand(message.name, message.argument);
        break;
      case 'invokeTool':
        void this.handleInvokeTool(message.callId, message.toolName, message.args);
        break;
      case 'requestContext':
        void this.handleRequestContext();
        break;
      case 'cancelTool':
        this.handleCancelTool(message.callId);
        break;
      default:
        this.outputChannel.appendLine(`Unknown message type: ${(message as unknown as { type: string }).type}`);
    }
  }

  private async handleReady(): Promise<void> {
    const selection = this.aiService.getSelection();
    const providers = await this.registry.getProviderStatuses();
    // The webview learns the authoritative access mode immediately on load
    // (before identity restore finishes), so LearnSmart mode can hide BYOK
    // surfaces with no flash of provider setup. managedChatAvailable mirrors
    // the Phase-8 production gate (always false until Phase 9 enforcement).
    const accessMode = this.accessModeService.getAccessMode();
    this.postMessage({ type: 'init', selection, providers, accessMode, managedChatAvailable: MANAGED_CHAT_ENABLED, agentMode: this.getCurrentAgentMode() });

    const workspaceInfo = await this.workspaceService.getCurrentWorkspaceInfo();
    this.sendWorkspaceInfo(workspaceInfo);

    const hasCompletedOnboarding = accessMode !== null;
    if (!hasCompletedOnboarding) {
      this.onboardingStateMachine.setState('welcome');
      this.postMessage({ type: 'onboardingState', state: 'welcome' });
    } else {
      if (accessMode === 'learnsmart') {
        // Session-scoped: revalidate the in-memory Firebase session. A full
        // VS Code restart clears it, correctly returning to welcome.
        const restored = await this.learnSmartAuthService.restoreSession().catch(() => null);
        if (restored) {
          this.onboardingStateMachine.complete();
          this.postMessage({ type: 'onboardingState', state: 'complete' });
          // Fresh managed bootstrap after every restore; never reuse a
          // previous snapshot.
          void this.managedController.bootstrap();
        } else {
          await this.accessModeService.clearAccessMode();
          this.postAccessMode();
          this.onboardingStateMachine.setState('welcome');
          this.postMessage({ type: 'onboardingState', state: 'welcome' });
        }
      } else if (accessMode === 'byok') {
        const configured = await this.registry.getConfiguredProviders();
        if (configured.length === 0) {
          await this.accessModeService.clearAccessMode();
          this.postAccessMode();
          this.onboardingStateMachine.setState('byokConfiguring');
          this.postMessage({ type: 'onboardingState', state: 'byokConfiguring' });
        } else {
          this.onboardingStateMachine.complete();
          this.postMessage({ type: 'onboardingState', state: 'complete' });
        }
      } else {
        this.onboardingStateMachine.complete();
        this.postMessage({ type: 'onboardingState', state: 'complete' });
      }
    }

    await this.pushProviderStatus();
    // Sync identity (account row) on every webview load.
    this.postIdentity();
    // Sync any surviving pending attachments (e.g. after webview reload).
    this.postMessage({ type: 'attachmentsSync', attachments: this.attachmentService.getPending() });
    // Proactively load catalogue for current selection (non-blocking).
    // Skipped in LearnSmart mode: the BYOK catalogue must never load there.
    if (!this.isLearnSmartMode()) {
      void this.handleCatalogRequest(selection.provider, false);
    }
  }

  private async pushProviderStatus(): Promise<void> {
    const providers = await this.registry.getProviderStatuses();
    const selection = this.aiService.getSelection();
    this.postMessage({
      type: 'providerStatus',
      payload: { providers, selectedProvider: selection.provider, selectedModelId: selection.modelId },
    });
    this.postMessage({ type: 'modelChanged', provider: selection.provider, modelId: selection.modelId });
  }

  private async onWorkspaceChange(info: WorkspaceInfo | null): Promise<void> {
    this.projectFileService.clear();
    this.latestSearchRequestId = 0;
    // Pending attachment IDs must not survive root changes (project files
    // revalidated anyway; external pending images cleared for a safe lifecycle).
    this.attachmentService.clearAllPending();
    this.postMessage({ type: 'attachmentsSync', attachments: [] });
    this.sendWorkspaceInfo(info);
    this.postMessage({ type: 'fileList', payload: [] });
    this.postMessage({ type: 'searchResults', requestId: 0, payload: [] });
  }

  private handleSelectAccessMode(message: Extract<WebviewToExtensionMessage, { type: 'selectAccessMode' }>): void {
    const { mode } = message;
    this.onboardingStateMachine.selectAccessMode(mode);
    this.postMessage({ type: 'onboardingState', state: this.onboardingStateMachine.getState() });
  }

  async handleConfigureProvider(provider: AIProviderId): Promise<void> {
    if (!isSupportedProviderId(provider)) {
      this.outputChannel.appendLine(`[Subi] Rejected configure for unknown provider`);
      return;
    }
    // Phase 7 Change 1: LearnSmart mode blocks BYOK provider setup.
    // Access mode alone is sufficient; identity restore may still be pending.
    if (this.isLearnSmartMode()) {
      this.outputChannel.appendLine(`[Subi] Rejected configureProvider in LearnSmart mode`);
      return;
    }
    const key = await vscode.window.showInputBox({
      prompt: `Enter your ${getProviderCredentialLabel(provider)}`,
      password: true,
      ignoreFocusOut: true,
    });
    const trimmed = key?.trim();
    if (!trimmed) {
      return;
    }
    await this.secretStorageService.setApiKey(provider, trimmed);
    await this.accessModeService.setAccessMode('byok');
    this.postAccessMode();
    // Leaving LearnSmart mode drops managed conversation state; BYOK
    // history is untouched.
    this.managedChatController.clearHistory();
    this.catalogs.clearCache(provider);
    await this.pushProviderStatus();
    this.notifyOnboardingComplete();
    void this.handleCatalogRequest(provider, true);
    vscode.window.showInformationMessage(`${getProviderLabel(provider)} API key configured successfully.`);
  }

  private async handleRemoveProviderKey(provider: AIProviderId): Promise<void> {
    if (!isSupportedProviderId(provider)) {
      return;
    }
    if (this.isLearnSmartMode()) {
      this.outputChannel.appendLine(`[Subi] Rejected removeProviderKey in LearnSmart mode`);
      return;
    }
    await this.secretStorageService.clearApiKey(provider);
    this.catalogs.clearCache(provider);
    const remaining = await this.registry.getConfiguredProviders();
    const current = this.aiService.getSelection();
    if (current.provider === provider) {
      if (remaining.length > 0) {
        // Safe UI-state fallback only; no automatic AI request.
        const fallbackProvider = remaining.includes('openrouter') ? 'openrouter' as AIProviderId : remaining[0];
        try {
          const { models } = await this.catalogs.listModels(fallbackProvider);
          const first = models[0];
          if (first) {
            await this.aiService.setSelection(first.provider, first.modelId);
          }
        } catch {
          // Catalogue failed; keep stale selection but status will show not-configured.
        }
      } else {
        await this.accessModeService.clearAccessMode();
        this.postAccessMode();
        this.onboardingStateMachine.setState('byokConfiguring');
        this.postMessage({ type: 'onboardingState', state: 'byokConfiguring' });
      }
    }
    if (remaining.length === 0) {
      const mode = this.accessModeService.getAccessMode();
      if (mode === 'byok') {
        await this.accessModeService.clearAccessMode();
        this.postAccessMode();
        this.onboardingStateMachine.setState('byokConfiguring');
        this.postMessage({ type: 'onboardingState', state: 'byokConfiguring' });
      }
    }
    await this.pushProviderStatus();
    vscode.window.showInformationMessage(`${getProviderLabel(provider)} API key removed.`);
  }

  private async handleSetProvider(provider: AIProviderId): Promise<void> {
    if (!isSupportedProviderId(provider)) {
      return;
    }
    // LearnSmart managed mode owns model selection via setManagedModel;
    // BYOK selection must not mutate while LearnSmart mode is active
    // (access mode alone gates this; identity may still be restoring).
    if (this.isLearnSmartMode()) {
      return;
    }
    if (this.isChatActive) {
      return;
    }
    if (!(await this.secretStorageService.hasApiKey(provider))) {
      this.postMessage({ type: 'modelCatalogError', provider, message: `${getProviderLabel(provider)} is not configured.` });
      return;
    }
    try {
      const { models } = await this.catalogs.listModels(provider);
      const first = models[0];
      if (first) {
        const sel = await this.aiService.setSelection(first.provider, first.modelId).catch(async () => {
          // If consent required, surface confirmation instead of failing silently.
          const trusted = this.catalogs.findModel(first.provider, first.modelId);
          if (trusted && this.aiService.needsConsent(trusted)) {
            this.postMessage({
              type: 'confirmationRequired',
              provider: trusted.provider,
              modelId: trusted.modelId,
              costClass: trusted.costClass,
              message: 'This model may use API credits or incur charges from your provider.',
            });
          }
          return undefined;
        });
        if (sel) {
          await this.pushProviderStatus();
          this.postMessage({ type: 'modelCatalog', provider, models, fromCache: true });
        }
      }
    } catch (e) {
      this.outputChannel.appendLine(`[Subi] setProvider failed: ${String(e)}`);
    }
  }

  public notifyProviderStatusChange(): void {
    void this.pushProviderStatus();
  }

  public notifyOnboardingComplete(): void {
    this.onboardingStateMachine.complete();
    this.postMessage({ type: 'onboardingState', state: 'complete' });
  }

  public notifyProviderStatusCleared(): void {
    this.onboardingStateMachine.setState('byokConfiguring');
    this.postMessage({ type: 'onboardingState', state: 'byokConfiguring' });
    void this.pushProviderStatus();
  }

  /**
   * Phase 7 Change 1: accessMode === 'learnsmart' is the PRIMARY BYOK/UI
   * isolation gate. It deliberately does NOT wait for identity restore:
   * during startup/session restore the identity can briefly be guest while
   * accessMode is already 'learnsmart', and BYOK must stay blocked.
   */
  private isLearnSmartMode(): boolean {
    return isLearnSmartAccessMode(this.accessModeService.getAccessMode());
  }

  /** Broadcast the authoritative access mode whenever it changes. */
  private postAccessMode(): void {
    this.postMessage({ type: 'accessModeChanged', mode: this.accessModeService.getAccessMode() });
  }

  private async handleCatalogRequest(provider: AIProviderId, force: boolean): Promise<void> {
    if (!isSupportedProviderId(provider)) {
      return;
    }
    // The BYOK catalogue must never load in LearnSmart mode, including
    // during identity restore (a manipulated webview could still ask).
    if (this.isLearnSmartMode()) {
      return;
    }
    this.postMessage({ type: 'modelCatalogLoading', provider });
    try {
      const models = force
        ? await this.catalogs.refreshModels(provider)
        : (await this.catalogs.listModels(provider)).models;
      const fromCache = !force && this.catalogs.getCachedModels(provider) !== undefined;
      this.postMessage({ type: 'modelCatalog', provider, models, fromCache });
    } catch (e) {
      const stale = this.catalogs.getCachedModels(provider);
      if (stale && stale.length > 0) {
        this.postMessage({ type: 'modelCatalog', provider, models: stale, fromCache: true });
      }
      const msg = e instanceof AIErrorClass ? e.message : 'Failed to load models for this provider.';
      this.postMessage({ type: 'modelCatalogError', provider, message: msg });
    }
  }

  private async handleConfirmCost(provider: AIProviderId, modelId: string, confirmed: boolean): Promise<void> {
    if (!isSupportedProviderId(provider)) {
      return;
    }
    // Cost consent is BYOK-only; never in LearnSmart mode.
    if (this.isLearnSmartMode()) {
      return;
    }
    try {
      await this.aiService.confirmCost(provider, modelId, confirmed);
      if (confirmed) {
        const sel = await this.aiService.setSelection(provider, modelId);
        await this.pushProviderStatus();
        this.postMessage({ type: 'modelChanged', provider: sel.provider, modelId: sel.modelId });
      }
    } catch (e) {
      this.outputChannel.appendLine(`[Subi] confirmCost failed: ${String(e)}`);
    }
  }

  private async handleSendMessage(message: Extract<WebviewToExtensionMessage, { type: 'sendMessage' }>): Promise<void> {
    const { requestId, provider, modelId, text } = message;
    const attachmentIds = Array.isArray(message.attachmentIds)
      ? message.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (this.isChatActive) {
      return;
    }
    // Phase 8: LearnSmart sends route to the managed gateway path, which
    // stays fail-closed behind MANAGED_CHAT_ENABLED (false) until Phase 9
    // quota enforcement. The BYOK pipeline below is never reached here.
    if (this.isLearnSmartMode()) {
      void this.handleManagedSendMessage(requestId, text ?? '', attachmentIds);
      return;
    }
    if (!isSupportedProviderId(provider)) {
      this.postMessage({ type: 'chatStreamError', requestId, error: { type: 'validation', message: 'Unknown provider.' } });
      return;
    }

    const trimmed = text?.trim() ?? '';
    if (trimmed.length === 0) {
      this.postMessage({ type: 'chatStreamError', requestId, error: { type: 'validation', message: 'Message cannot be empty.' } });
      return;
    }
    if (trimmed.length > 20000) {
      this.postMessage({ type: 'chatStreamError', requestId, error: { type: 'validation', message: 'Message exceeds maximum length of 20,000 characters.' } });
      return;
    }

    // Freeze the send snapshot, then preflight (resolve + gates) BEFORE
    // accepting. Pending composer chips are cleared only on accept, so
    // preflight failures keep the draft intact and create no chat turn.
    let prepared: PreparedStream;
    try {
      prepared = await this.aiService.prepareStream(provider, modelId, trimmed, attachmentIds);
    } catch (error: unknown) {
      this.postStreamError(requestId, provider, modelId, error);
      return;
    }

    this.latestChatRequestId = requestId;
    this.isChatActive = true;
    const controller = new AbortController();
    this.activeStreamController = controller;
    // Accept: detach exactly this snapshot from pending; later + activity
    // belongs to the next draft and cannot mutate the active request.
    this.attachmentService.clearResolved(attachmentIds);
    this.postMessage({ type: 'attachmentsSync', attachments: this.attachmentService.getPending() });
    this.postMessage({ type: 'chatStreamStarted', requestId });

    // Batching + timeout ownership lives here; adapters are pure signal-driven.
    let pending = '';
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (t: ReturnType<typeof setTimeout> | undefined): void => {
      if (t !== undefined) {
        clearTimeout(t);
      }
    };
    const cleanup = (): void => {
      clearTimer(batchTimer);
      batchTimer = undefined;
      clearTimer(inactivityTimer);
      inactivityTimer = undefined;
      clearTimer(absoluteTimer);
      absoluteTimer = undefined;
    };
    const isCurrent = (): boolean => requestId === this.latestChatRequestId;
    const flush = (): void => {
      if (pending.length === 0) {
        return;
      }
      if (isCurrent()) {
        this.postMessage({ type: 'chatStreamDelta', requestId, delta: pending });
      }
      pending = '';
    };
    const scheduleFlush = (): void => {
      if (batchTimer === undefined) {
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          flush();
        }, SidebarProvider.STREAM_BATCH_MS);
      }
    };
    const resetInactivity = (): void => {
      clearTimer(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abort('timeout');
      }, SidebarProvider.STREAM_INACTIVITY_MS);
    };
    resetInactivity();
    absoluteTimer = setTimeout(() => {
      controller.abort('timeout');
    }, SidebarProvider.STREAM_ABSOLUTE_MAX_MS);

    try {
      const result = await this.aiService.runPreparedStream(
        prepared,
        (event) => {
          if (!isCurrent()) {
            return;
          }
          // Only valid normalized provider data resets inactivity.
          resetInactivity();
          if (event.type === 'textDelta') {
            pending += event.text;
            if (pending.length >= SidebarProvider.STREAM_BATCH_CHARS) {
              clearTimer(batchTimer);
              batchTimer = undefined;
              flush();
            } else {
              scheduleFlush();
            }
          }
        },
        controller.signal
      );
      if (!isCurrent()) {
        return;
      }
      flush();
      this.postMessage({
        type: 'chatStreamCompleted',
        requestId,
        provider: result.provider,
        modelId: result.modelId,
        actualModelId: result.actualModelId,
      });
      this.postMessage({ type: 'modelChanged', provider: result.provider, modelId: result.modelId });
      await this.pushProviderStatus();
    } catch (error: unknown) {
      flush();
      if (!isCurrent()) {
        return;
      }
      if (await this.postStreamError(requestId, provider, modelId, error)) {
        return;
      }
    } finally {
      cleanup();
      if (this.activeStreamController === controller) {
        this.activeStreamController = null;
      }
      this.isChatActive = false;
    }
  }

  /**
   * LearnSmart managed send (Phase 8). Production gate first: while
   * MANAGED_CHAT_ENABLED is false this rejects with the standard disabled
   * message before touching tokens, history, or the network. When enabled
   * (Phase 9+), it streams via ManagedChatController with the currently
   * selected managed modelKey — never AIService, providers, or SecretStorage.
   */
  private async handleManagedSendMessage(requestId: number, text: string, attachmentIds: string[]): Promise<void> {
    if (!MANAGED_CHAT_ENABLED) {
      this.postMessage({
        type: 'chatStreamError',
        requestId,
        error: { type: 'managed', message: 'Managed chat will be enabled in the next SUBI phase.' },
      });
      return;
    }
    // Phase 8 is TEXT ONLY: attachments are rejected, never forwarded.
    if (attachmentIds.length > 0) {
      this.postMessage({
        type: 'chatStreamError',
        requestId,
        error: { type: 'validation', message: 'Attachments are not supported in managed chat yet.' },
      });
      return;
    }
    const trimmed = text?.trim() ?? '';
    if (trimmed.length === 0) {
      this.postMessage({ type: 'chatStreamError', requestId, error: { type: 'validation', message: 'Message cannot be empty.' } });
      return;
    }
    if (trimmed.length > 20000) {
      this.postMessage({ type: 'chatStreamError', requestId, error: { type: 'validation', message: 'Message exceeds maximum length of 20,000 characters.' } });
      return;
    }
    const user = this.learnSmartAuthService.getCurrentUser();
    const session = this.managedController.getState();
    const modelKey = session.selectedModelKey;
    if (!user || session.status !== 'allowed' || !modelKey || !session.models.some((m) => m.modelKey === modelKey)) {
      this.postMessage({
        type: 'chatStreamError',
        requestId,
        error: { type: 'managed', message: 'Managed chat is not available for your account right now.' },
      });
      return;
    }
    let idToken: string;
    try {
      // Transient: header-only, never stored/logged/sent to the webview.
      idToken = await this.learnSmartAuthService.getIdToken(false);
    } catch {
      this.postMessage({
        type: 'chatStreamError',
        requestId,
        error: { type: 'managed', message: 'LearnSmart session has expired. Please sign in again.' },
      });
      return;
    }

    this.latestChatRequestId = requestId;
    this.isChatActive = true;
    const controller = new AbortController();
    this.activeStreamController = controller;
    this.postMessage({ type: 'chatStreamStarted', requestId });

    // Batching + timeout ownership mirrors the BYOK path; the absolute
    // ceiling is reconciled with the 540s chat-function maximum.
    let pending = '';
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (t: ReturnType<typeof setTimeout> | undefined): void => {
      if (t !== undefined) {
        clearTimeout(t);
      }
    };
    const cleanup = (): void => {
      clearTimer(batchTimer);
      batchTimer = undefined;
      clearTimer(inactivityTimer);
      inactivityTimer = undefined;
      clearTimer(absoluteTimer);
      absoluteTimer = undefined;
    };
    const isCurrent = (): boolean => requestId === this.latestChatRequestId;
    const flush = (): void => {
      if (pending.length === 0) {
        return;
      }
      if (isCurrent()) {
        this.postMessage({ type: 'chatStreamDelta', requestId, delta: pending });
      }
      pending = '';
    };
    const scheduleFlush = (): void => {
      if (batchTimer === undefined) {
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          flush();
        }, SidebarProvider.STREAM_BATCH_MS);
      }
    };
    const resetInactivity = (): void => {
      clearTimer(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abort('timeout');
      }, SidebarProvider.STREAM_INACTIVITY_MS);
    };
    resetInactivity();
    absoluteTimer = setTimeout(() => {
      controller.abort('timeout');
    }, MANAGED_STREAM_ABSOLUTE_MAX_MS);

    try {
      await this.managedChatController.send({
        requestId,
        idToken,
        modelKey,
        text: trimmed,
        signal: controller.signal,
        onEvent: (event) => {
          if (!isCurrent()) {
            return;
          }
          resetInactivity();
          switch (event.type) {
            case 'started':
              break;
            case 'delta':
              pending += event.text;
              if (pending.length >= SidebarProvider.STREAM_BATCH_CHARS) {
                clearTimer(batchTimer);
                batchTimer = undefined;
                flush();
              } else {
                scheduleFlush();
              }
              break;
            case 'completed':
              flush();
              // Managed completion carries modelKey only — never provider,
              // modelId, actualModelId, or upstream identifiers.
              this.postMessage({ type: 'chatStreamCompleted', requestId, modelKey: event.modelKey });
              break;
            case 'error':
              flush();
              this.outputChannel.appendLine(`[Subi][ManagedChatError] ${event.code}`);
              this.postMessage({ type: 'chatStreamError', requestId, error: { type: event.code, message: event.message } });
              break;
            case 'cancelled':
              flush();
              this.postMessage({ type: 'chatStreamCancelled', requestId });
              break;
          }
        },
      });
    } finally {
      cleanup();
      if (this.activeStreamController === controller) {
        this.activeStreamController = null;
      }
      this.isChatActive = false;
    }
  }

  // ===========================================================================
  // Phase 10A: agent shell — slash commands, tools, agentMode
  // ===========================================================================

  private async handleSetAgentMode(mode: AgentMode): Promise<void> {
    const safe = isAgentMode(mode) ? mode : DEFAULT_AGENT_MODE;
    // BUILD is locked in Phase 10A. Persist ASK/PLAN only; ignore BUILD
    // so the webview mirror cannot bypass the lock.
    if (safe === 'build') {
      this.postMessage({ type: 'agentModeChanged', mode: 'ask' });
      this.postMessage({
        type: 'slashResult',
        name: '/build',
        available: false,
        message: 'Build mode will be enabled after safe write/patch support is installed.',
      });
      return;
    }
    await this.agentModeService.setAgentMode(safe);
    await this.agentModeService.setActiveMirror(safe);
    this.postMessage({ type: 'agentModeChanged', mode: safe });
  }

  private handleRequestSlashCommands(): void {
    const all = this.slashCommandRegistry.list();
    this.postMessage({
      type: 'slashCommands',
      commands: all.map((c) => ({
        name: c.name,
        aliases: c.aliases,
        description: c.description,
        category: c.category,
        argumentHint: c.argumentHint,
        available: c.available,
        unavailableReason: c.unavailableReason,
      })),
    });
  }

  private handleRequestToolCatalog(): void {
    const tools = listFullToolCatalog({
      workspaceService: this.workspaceService,
      projectFileService: this.projectFileService,
      projectSearchService: this.projectSearchService,
    });
    this.postMessage({
      type: 'toolCatalog',
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        permission: t.permission,
        availableInModes: [...t.availableInModes],
        inputSchema: t.inputSchema.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          description: f.description,
          maxLength: f.maxLength,
        })),
        displayLabel: t.displayLabel,
        locked: t.locked,
        lockedReason: t.lockedReason,
      })),
    });
  }

  private async handleExecuteSlashCommand(name: string, argument: string): Promise<void> {
    const parsed = parseSlashInput(`/${name.replace(/^\/+/, '')}${argument ? ' ' + argument : ''}`);
    const cmdName = parsed.isCommand ? parsed.name : name;
    const arg = parsed.isCommand ? parsed.argument : argument;
    const cmd = this.slashCommandRegistry.get(cmdName);
    if (!cmd) {
      this.postMessage({
        type: 'slashResult',
        name: cmdName,
        available: false,
        message: `Unknown command: ${cmdName}`,
      });
      return;
    }
    if (!cmd.available) {
      this.postMessage({
        type: 'slashResult',
        name: cmd.name,
        available: false,
        message: cmd.unavailableReason ?? `${cmd.name} is not available yet.`,
      });
      return;
    }
    const mode = this.getCurrentAgentMode();
    switch (cmd.name) {
      case '/ask':
        await this.handleSetAgentMode('ask');
        this.postMessage({ type: 'slashResult', name: cmd.name, available: true, message: 'Switched to ASK mode.' });
        return;
      case '/plan':
        await this.handleSetAgentMode('plan');
        this.postMessage({ type: 'slashResult', name: cmd.name, available: true, message: 'Switched to PLAN mode (read-only).' });
        return;
      case '/build':
        await this.handleSetAgentMode('build');
        return;
      case '/tools':
        this.handleRequestToolCatalog();
        this.postMessage({ type: 'slashResult', name: cmd.name, available: true, message: 'Tool catalogue posted.' });
        return;
      case '/files':
        await this.runSlashAsTool('find_files', { filter: arg }, mode, cmd.name);
        return;
      case '/read':
        await this.runSlashAsTool('read_file', { path: arg }, mode, cmd.name);
        return;
      case '/search': {
        // /search <query> [files|content]
        const tokens = arg.split(/\s+/).filter(Boolean);
        const query = tokens[0] ?? '';
        const modeArg = (tokens[1] ?? 'content').toLowerCase() === 'files' ? 'files' : 'content';
        await this.runSlashAsTool('search_text', { query, mode: modeArg }, mode, cmd.name);
        return;
      }
      case '/context':
        await this.handleRequestContext();
        return;
      case '/clear':
        this.handleClearChat();
        this.postMessage({ type: 'slashResult', name: cmd.name, available: true, message: 'Chat history cleared.' });
        return;
      case '/help': {
        const all = this.slashCommandRegistry.list();
        const available = all.filter((c) => c.available).map((c) => c.name);
        this.postMessage({
          type: 'slashResult',
          name: cmd.name,
          available: true,
          message: `Available: ${available.join(', ')}`,
        });
        return;
      }
      default:
        this.postMessage({
          type: 'slashResult',
          name: cmd.name,
          available: false,
          message: `${cmd.name} is not implemented in this phase.`,
        });
    }
  }

  private async runSlashAsTool(
    toolName: string,
    args: Record<string, unknown>,
    mode: AgentMode,
    slashName: string
  ): Promise<void> {
    const callId = `slash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.toolExecutor.execute({ callId, toolName, args }, mode);
    this.postMessage({
      type: 'slashResult',
      name: slashName,
      available: true,
      toolCard: {
        callId: result.callId,
        toolName: result.toolName,
        category: result.category,
        label: result.label,
        summary: result.ok ? result.summary : result.message,
        ok: result.ok,
        payload: result.ok ? result.payload : undefined,
        code: result.ok ? undefined : result.code,
        message: result.ok ? undefined : result.message,
        durationMs: result.durationMs,
      },
    });
  }

  private async handleInvokeTool(
    callId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    if (typeof callId !== 'string' || callId.length === 0) {
      return;
    }
    const mode = this.getCurrentAgentMode();
    await this.toolExecutor.execute({ callId, toolName, args: args ?? {} }, mode);
  }

  private handleCancelTool(callId: string): void {
    if (this.toolExecutor.isActive()) {
      this.toolExecutor.cancel();
    }
    void callId;
  }

  private async handleRequestContext(): Promise<void> {
    const mode = this.getCurrentAgentMode();
    const accessMode = this.accessModeService.getAccessMode();
    const info = await this.workspaceService.getCurrentWorkspaceInfo().catch(() => null);
    const selection = this.aiService.getSelection();
    this.postMessage({
      type: 'contextSummary',
      payload: {
        agentMode: mode,
        accessMode,
        workspaceName: info?.name ?? null,
        projectType: info?.projectType ?? null,
        selectedModel: { provider: selection.provider, modelId: selection.modelId },
        recentActivity: this.recentToolActivity.list(),
      },
    });
  }

  /**
   * Normalize a send/stream failure into webview messages. Returns true when
   * the error was fully handled (cancelled). Attachment/preflight errors
   * surface as compact composer errors, never provider/network errors.
   */
  private async postStreamError(
    requestId: number,
    provider: AIProviderId,
    modelId: string,
    error: unknown
  ): Promise<boolean> {
    let errType = 'unknown';
    let errMessage = 'An error occurred.';
    if (error instanceof AIErrorClass) {
      errType = error.type;
      errMessage = error.message;
    } else if (error instanceof Error) {
      const msg = error.message;
      if (msg.startsWith('validation:')) {
        errType = 'validation';
        errMessage = msg.substring('validation:'.length);
      } else {
        errMessage = msg || errMessage;
      }
    }
    this.outputChannel.appendLine(`[Subi][ChatError] ${errType}: ${errMessage} (provider: ${String(provider)})`);
    if (errType === 'cancelled') {
      this.postMessage({ type: 'chatStreamCancelled', requestId });
      return true;
    }
    if (errType === 'confirmationRequired') {
      const item = await this.aiService.resolveTrustedModel(provider, modelId);
      this.postMessage({
        type: 'confirmationRequired',
        provider,
        modelId,
        costClass: item?.costClass ?? 'unknown',
        message: 'This model may use API credits or incur charges from your provider.',
      });
    }
    this.postMessage({ type: 'chatStreamError', requestId, error: { type: errType, message: errMessage } });
    return false;
  }

  private async handleAttachProjectFiles(): Promise<void> {
    try {
      const { added, errors } = await this.attachmentService.pickProjectFiles();
      if (added.length > 0) {
        this.postMessage({ type: 'attachmentsAdded', attachments: added });
      }
      for (const message of errors) {
        this.postMessage({ type: 'attachmentError', error: { type: 'attachment', message } });
      }
    } catch (error) {
      const message = error instanceof AIErrorClass ? error.message : 'Could not attach project files.';
      this.postMessage({ type: 'attachmentError', error: { type: 'attachment', message } });
    }
  }

  private async handleAttachImages(): Promise<void> {
    try {
      const { added, previews, errors } = await this.attachmentService.pickImages();
      if (added.length > 0) {
        this.postMessage({ type: 'attachmentsAdded', attachments: added });
      }
      for (const preview of previews) {
        this.postMessage({ type: 'attachmentThumbnail', attachmentId: preview.attachmentId, dataUrl: preview.dataUrl });
      }
      for (const message of errors) {
        this.postMessage({ type: 'attachmentError', error: { type: 'attachment', message } });
      }
    } catch (error) {
      const message = error instanceof AIErrorClass ? error.message : 'Could not attach images.';
      this.postMessage({ type: 'attachmentError', error: { type: 'attachment', message } });
    }
  }

  private handleRemoveAttachment(attachmentId: string): void {
    if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
      return;
    }
    if (this.attachmentService.removeAttachment(attachmentId)) {
      this.postMessage({ type: 'attachmentRemoved', attachmentId });
    }
  }

  private handleCancelChat(requestId: number): void {
    if (this.isChatActive && requestId === this.latestChatRequestId && this.activeStreamController) {
      this.activeStreamController.abort();
    }
  }

  private async handleResetOnboarding(): Promise<void> {
    if (this.activeStreamController) {
      this.activeStreamController.abort();
    }
    this.isChatActive = false;
    this.latestChatRequestId = 0;
    this.aiService.clearHistory();
    this.managedChatController.clearHistory();
    this.attachmentService.clearAllPending();
    this.postMessage({ type: 'attachmentsSync', attachments: [] });
    // Managed bootstrap must not outlive the reset; stale responses can
    // never restore a session (generation guard + clear notification).
    this.managedController.clear();
    this.managedChatController.clearHistory();
    await this.learnSmartAuthService.signOut().catch(() => undefined);
    this.postIdentity();
    await this.accessModeService.clearAccessMode();
    this.postAccessMode();
    this.onboardingStateMachine.setState('welcome');
    this.postMessage({ type: 'onboardingState', state: 'welcome' });
    this.postMessage({ type: 'chatHistoryCleared' });
    await this.pushProviderStatus();
  }

  private postIdentity(): void {
    const identity: SubiIdentity = this.learnSmartAuthService.getIdentity();
    this.postMessage({ type: 'identityChanged', identity });
  }

  private async handleLearnSmartSignIn(email: string, password: string): Promise<void> {
    this.postMessage({ type: 'learnsmartAuthBusy', busy: true });
    try {
      await this.learnSmartAuthService.signIn(email, password);
      await this.accessModeService.setAccessMode('learnsmart');
      this.postAccessMode();
      this.onboardingStateMachine.complete();
      this.postIdentity();
      this.postMessage({ type: 'onboardingState', state: 'complete' });
      // Fresh managed bootstrap on every successful login; never reuse a
      // previous models/limit snapshot.
      void this.managedController.bootstrap();
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0
        ? error.message
        : 'Unable to sign in to LearnSmart.';
      this.outputChannel.appendLine('[Subi][LearnSmart] sign-in failed.');
      this.postMessage({ type: 'learnsmartAuthError', message });
    } finally {
      this.postMessage({ type: 'learnsmartAuthBusy', busy: false });
    }
  }

  private async handleLearnSmartSignOut(): Promise<void> {
    // Abort + clear managed state first so no late bootstrap response can
    // repopulate models/limit after identity clears.
    this.managedController.clear();
    this.managedChatController.clearHistory();
    await this.learnSmartAuthService.signOut().catch(() => undefined);
    this.postIdentity();
    // Access-mode repair: never leave learnsmart mode with a guest identity.
    // BYOK keys, chat, selection, and project state are untouched.
    const configured = await this.registry.getConfiguredProviders().catch(() => []);
    if (configured.length > 0) {
      await this.accessModeService.setAccessMode('byok');
      this.postAccessMode();
      this.onboardingStateMachine.complete();
      this.postMessage({ type: 'onboardingState', state: 'complete' });
    } else {
      await this.accessModeService.clearAccessMode();
      this.postAccessMode();
      this.onboardingStateMachine.setState('welcome');
      this.postMessage({ type: 'onboardingState', state: 'welcome' });
    }
    await this.pushProviderStatus();
  }

  /**
   * Posts the safe managed-session projection. The payload is built by
   * toManagedWebviewState() only: status, identity display fields, safe
   * models, selected modelKey, monthly limit, safe error code. The Firebase
   * ID token never enters this path.
   */
  private postManagedSession(): void {
    this.postMessage({
      type: 'managedSessionChanged',
      state: toManagedWebviewState(this.managedController.getState()),
    });
  }

  private async handleSetManagedModel(
    message: Extract<WebviewToExtensionMessage, { type: 'setManagedModel' }>
  ): Promise<void> {
    const modelKey = message?.modelKey;
    if (typeof modelKey !== 'string' || modelKey.length === 0 || modelKey.length > 200) {
      return;
    }
    // Webview selection is advisory: LearnSmart mode + current eligibility
    // are enforced by the controller; arbitrary keys are rejected.
    // Managed actions additionally require an authenticated LearnSmart
    // identity (Change 1 strengthens BYOK blocking without weakening this).
    if (!this.isLearnSmartMode()) {
      return;
    }
    if (!this.learnSmartAuthService.getCurrentUser()) {
      return;
    }
    if (this.isChatActive) {
      return;
    }
    await this.managedController.setSelectedModelKey(modelKey);
    this.postManagedSession();
  }

  private async handleRetryManagedSession(): Promise<void> {
    // Retry requires LearnSmart mode plus a live LearnSmart identity;
    // otherwise there is nothing to bootstrap with (sign-in owns identity
    // establishment).
    if (!this.isLearnSmartMode()) {
      return;
    }
    if (!this.learnSmartAuthService.getCurrentUser()) {
      return;
    }
    await this.managedController.bootstrap();
  }

  private handleClearChat(): void {
    // Per-mode histories: Clear Chat while in LearnSmart mode clears only
    // managed history (BYOK history is preserved), and vice versa.
    if (this.isLearnSmartMode()) {
      this.managedChatController.clearHistory();
    } else {
      this.aiService.clearHistory();
    }
    this.latestChatRequestId = 0;
    this.isChatActive = false;
    this.postMessage({ type: 'chatHistoryCleared' });
  }

  private async handleSetModel(message: Extract<WebviewToExtensionMessage, { type: 'setModel' }>): Promise<void> {
    const { provider, modelId } = message;
    if (!isSupportedProviderId(provider)) {
      return;
    }
    // Same managed-mode isolation as handleSetProvider (access mode gates;
    // identity may still be restoring).
    if (this.isLearnSmartMode()) {
      return;
    }
    if (this.isChatActive) {
      return;
    }
    try {
      const sel = await this.aiService.setSelection(provider, modelId);
      this.postMessage({ type: 'modelChanged', provider: sel.provider, modelId: sel.modelId });
      await this.pushProviderStatus();
    } catch (e) {
      if (e instanceof AIErrorClass && e.type === 'confirmationRequired') {
        const item = await this.aiService.resolveTrustedModel(provider, modelId);
        this.postMessage({
          type: 'confirmationRequired',
          provider,
          modelId,
          costClass: item?.costClass ?? 'unknown',
          message: 'This model may use API credits or incur charges from your provider.',
        });
        return;
      }
      this.outputChannel.appendLine(`[Subi] Failed to set model: ${String(e)}`);
    }
  }

  private async handleRequestFileList(): Promise<void> {
    const files = await this.projectFileService.listFiles();
    this.postMessage({ type: 'fileList', payload: files });
  }

  private async handleRequestFileContent(message: Extract<WebviewToExtensionMessage, { type: 'requestFileContent' }>): Promise<void> {
    const result = await this.projectFileService.readFile(message.fileId);
    if ('fileId' in result) {
      this.postMessage({ type: 'fileContent', payload: result });
    } else {
      this.postMessage({ type: 'fileError', payload: result });
    }
  }

  private async handleRequestSearch(message: Extract<WebviewToExtensionMessage, { type: 'requestSearch' }>): Promise<void> {
    const { requestId, query, mode } = message;
    this.latestSearchRequestId = requestId;
    try {
      let results: ProjectSearchResult[];
      if (mode === 'files') {
        results = await this.projectSearchService.searchFiles(query);
      } else {
        results = await this.projectSearchService.searchContent(query);
      }
      if (requestId === this.latestSearchRequestId) {
        this.postMessage({ type: 'searchResults', requestId, payload: results });
      }
    } catch (error) {
      if (requestId === this.latestSearchRequestId) {
        const errorMessage = error instanceof Error ? error.message : 'Search failed.';
        this.postMessage({
          type: 'searchError',
          requestId,
          payload: { type: 'validation', message: errorMessage },
        });
      }
    }
  }

  private sendWorkspaceInfo(info: WorkspaceInfo | null): void {
    this.postMessage({ type: 'workspaceInfo', payload: info });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    if (this.webviewView) {
      this.webviewView.webview.postMessage(message);
    }
  }

  public dispose(): void {
    this.managedController.abort();
    this.outputChannel.dispose();
    this.workspaceChangeListener?.dispose();
  }
}
