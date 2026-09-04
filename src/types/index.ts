// Safe managed-session wire state (Phase 6). Produced ONLY by
// toManagedWebviewState(): status, identity display fields, backend-safe
// models, selected modelKey, and the configured monthly limit. Never tokens,
// keys, upstream identifiers, or admin metadata.
import type { ManagedWebviewState } from '../services/managed/managedTypes';

export type ProjectType =
  | 'vscode-extension'
  | 'node'
  | 'react'
  | 'nextjs'
  | 'python'
  | 'flutter'
  | 'rust'
  | 'go'
  | 'java'
  | 'generic';

export interface WorkspaceInfo {
  name: string;
  path: string;
  projectType: ProjectType;
  workspaceFolderCount: number;
  isMultiRoot: boolean;
}

export interface ProjectFileItem {
  id: string;
  workspaceFolderName: string;
  displayPath: string;
}

export interface FileReadResult {
  fileId: string;
  displayPath: string;
  content: string;
  size: number;
}

export type FileReadError =
  | { type: 'validation'; message: string }
  | { type: 'notFound'; message: string }
  | { type: 'tooLarge'; message: string; size: number }
  | { type: 'binary'; message: string }
  | { type: 'encoding'; message: string }
  | { type: 'unknown'; message: string };

export type SearchMode = 'files' | 'content';

export interface ProjectSearchResult {
  fileId: string;
  displayPath: string;
  line?: number;
  preview?: string;
}

export type SearchError =
  | { type: 'validation'; message: string }
  | { type: 'notReady'; message: string }
  | { type: 'unknown'; message: string };

export type SubiAccessMode = 'learnsmart' | 'free' | 'byok';

export type LearnSmartRole = 'student' | 'teacher';

/** Safe LearnSmart identity only — never tokens, passwords, or raw profile fields. */
export interface SafeLearnSmartUser {
  uid: string;
  email: string;
  displayName?: string;
  role: LearnSmartRole;
  schoolId?: string;
  studentId?: string;
  teacherId?: string;
}

/** SUBI identity is independent from AI provider connection. */
export type SubiIdentity =
  | { type: 'guest' }
  | { type: 'learnsmart'; user: SafeLearnSmartUser };

export type OnboardingState =
  | 'welcome'
  | 'learnsmartLogin'
  | 'freeConfirmation'
  | 'byokConfiguring'
  | 'loading'
  | 'error'
  | 'complete';

export type AIProviderId =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek';

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional normalized multimodal parts (Stage 4A.2.3). `content` stays the text fallback. */
  parts?: AIContentPart[];
}

export type AIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Uint8Array };

export interface AIChatRequest {
  provider: AIProviderId;
  modelId: string;
  messages: AIChatMessage[];
}

export interface AIChatResponse {
  content: string;
  provider: AIProviderId;
  modelId: string;
  actualModelId?: string;
}

export type AIErrorType =
  | 'notConfigured'
  | 'authentication'
  | 'rateLimit'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'invalidResponse'
  | 'cancelled'
  | 'confirmationRequired'
  | 'attachment'
  | 'unknown';

export interface AIError {
  type: AIErrorType;
  message: string;
}

export type ModelCostClass = 'free' | 'paid' | 'unknown';
export type ModelSource = 'builtin' | 'remote';

export interface SafeModelCatalogItem {
  provider: AIProviderId;
  modelId: string;
  label: string;
  description?: string;
  contextLength?: number;
  capabilities?: {
    textInput?: boolean;
    textOutput?: boolean;
    vision?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    /**
     * Image-input capability state (Stage 4A.2.3). Positively established
     * from trusted provider metadata only; unknown defaults to BLOCKED
     * for image sending.
     */
    imageInput?: 'supported' | 'unsupported' | 'unknown';
  };
  costClass: ModelCostClass;
  source: ModelSource;
}

export interface ModelSelection {
  provider: AIProviderId;
  modelId: string;
}

export interface CostConsentRecord {
  confirmedAt: number;
  costClassAtConsent: 'paid' | 'unknown';
}

export interface ProviderStatusItem {
  id: AIProviderId;
  label: string;
  configured: boolean;
}

export interface ModelConfig {
  id: string;
  label: string;
  provider: 'openrouter';
}

export type ChatAttachmentKind = 'text' | 'image';

/** Safe attachment metadata only — the only attachment shape the Webview sees. */
export interface SafeChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  size: number;
  relativePath?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export type WebviewToExtensionMessage =  | { type: 'ready' }
  | { type: 'sendMessage'; requestId: number; provider: AIProviderId; modelId: string; text: string; attachmentIds?: string[] }
  | { type: 'requestFileList' }
  | { type: 'requestFileContent'; fileId: string }
  | { type: 'requestSearch'; requestId: number; query: string; mode: SearchMode }
  | { type: 'selectAccessMode'; mode: SubiAccessMode }
  | { type: 'configureProvider'; provider: AIProviderId }
  | { type: 'removeProviderKey'; provider: AIProviderId }
  | { type: 'setProvider'; provider: AIProviderId }
  | { type: 'setModel'; provider: AIProviderId; modelId: string }
  | { type: 'requestModelCatalog'; provider: AIProviderId }
  | { type: 'refreshModelCatalog'; provider: AIProviderId }
  | { type: 'confirmModelCost'; provider: AIProviderId; modelId: string; confirmed: boolean }
  | { type: 'cancelChat'; requestId: number }
  | { type: 'resetOnboarding' }
  | { type: 'learnsmartSignIn'; email: string; password: string }
  | { type: 'learnsmartSignOut' }
  | { type: 'requestAttachProjectFiles' }
  | { type: 'requestAttachImages' }
  | { type: 'removeChatAttachment'; attachmentId: string }
  | { type: 'clearChat' }
  | { type: 'setManagedModel'; modelKey: string }
  | { type: 'retryManagedSession' }
  // Phase 10A: agent shell
  | { type: 'setAgentMode'; mode: 'ask' | 'plan' | 'build' }
  | { type: 'requestSlashCommands' }
  | { type: 'requestToolCatalog' }
  | { type: 'executeSlashCommand'; name: string; argument: string }
  | { type: 'invokeTool'; callId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'requestContext' }
  | { type: 'cancelTool'; callId: string };

export type ExtensionToWebviewMessage =
  | { type: 'init'; selection: ModelSelection; providers: ProviderStatusItem[]; accessMode: SubiAccessMode | null; managedChatAvailable: boolean; agentMode: 'ask' | 'plan' | 'build' }
  | { type: 'workspaceInfo'; payload: WorkspaceInfo | null }
  | { type: 'fileList'; payload: ProjectFileItem[] }
  | { type: 'fileContent'; payload: FileReadResult }
  | { type: 'fileError'; payload: FileReadError }
  | { type: 'searchResults'; requestId: number; payload: ProjectSearchResult[] }
  | { type: 'searchError'; requestId: number; payload: SearchError }
  | { type: 'onboardingState'; state: OnboardingState; message?: string }
  | { type: 'accessModeChanged'; mode: SubiAccessMode | null }
  | { type: 'chatStarted'; requestId: number }
  | { type: 'chatResponse'; requestId: number; content: string; provider: AIProviderId; modelId: string }
  | { type: 'chatError'; requestId: number; error: { type: string; message: string } }
  | { type: 'chatStreamStarted'; requestId: number }
  | { type: 'chatStreamDelta'; requestId: number; delta: string }
  | { type: 'chatStreamCompleted'; requestId: number; provider?: AIProviderId; modelId?: string; actualModelId?: string; modelKey?: string }
  | { type: 'chatStreamError'; requestId: number; error: { type: string; message: string } }
  | { type: 'chatStreamCancelled'; requestId: number }
  | { type: 'chatHistoryCleared' }
  | { type: 'modelChanged'; provider: AIProviderId; modelId: string }
  | { type: 'providerStatus'; payload: { providers: ProviderStatusItem[]; selectedProvider: AIProviderId | null; selectedModelId?: string } }
  | { type: 'modelCatalogLoading'; provider: AIProviderId }
  | { type: 'modelCatalog'; provider: AIProviderId; models: SafeModelCatalogItem[]; fromCache: boolean }
  | { type: 'modelCatalogError'; provider: AIProviderId; message: string }
  | { type: 'confirmationRequired'; provider: AIProviderId; modelId: string; costClass: ModelCostClass; message: string }
  | { type: 'attachmentsAdded'; attachments: SafeChatAttachment[] }
  | { type: 'attachmentRemoved'; attachmentId: string }
  | { type: 'attachmentsSync'; attachments: SafeChatAttachment[] }
  | { type: 'attachmentError'; error: { type: string; message: string } }
  | { type: 'attachmentThumbnail'; attachmentId: string; dataUrl: string }
  | { type: 'learnsmartAuthBusy'; busy: boolean }
  | { type: 'learnsmartAuthError'; message: string }
  | { type: 'identityChanged'; identity: SubiIdentity }
  | { type: 'managedSessionChanged'; state: ManagedWebviewState }
  // Phase 10A: agent shell
  | { type: 'agentModeChanged'; mode: 'ask' | 'plan' | 'build' }
  | { type: 'slashCommands'; commands: Array<{ name: string; aliases?: string[]; description: string; category: string; argumentHint?: string; available: boolean; unavailableReason?: string }> }
  | { type: 'toolCatalog'; tools: Array<{ name: string; description: string; category: string; permission: string; availableInModes: string[]; inputSchema: Array<{ name: string; type: string; required: boolean; description: string; maxLength?: number }>; displayLabel?: string; locked: boolean; lockedReason?: string }> }
  | { type: 'toolStarted'; callId: string; toolName: string; category: string; label: string }
  | { type: 'toolCompleted'; callId: string; toolName: string; category: string; label: string; durationMs: number; ok: boolean; code?: string; message?: string; summary: string; result: { ok: true; callId: string; toolName: string; category: string; permission: string; label: string; summary: string; payload?: unknown; durationMs: number } | { ok: false; callId: string; toolName: string; category: string; permission: string; label: string; code: string; message: string; durationMs: number } }
  | { type: 'toolFailed'; callId: string; toolName: string; category: string; label: string; code: string; message: string; durationMs: number }
  | { type: 'slashResult'; name: string; available: boolean; message?: string; payload?: { kind: 'context' | 'toolCards'; data: unknown }; toolCard?: { callId: string; toolName: string; category: string; label: string; summary: string; ok: boolean; payload?: unknown; code?: string; message?: string; durationMs: number } }
  | { type: 'contextSummary'; payload: { agentMode: string; accessMode: string | null; workspaceName: string | null; projectType: string | null; selectedModel: { provider: string; modelId: string } | null; recentActivity: Array<{ toolName: string; label: string; summary: string; ok: boolean; durationMs: number; timestamp: number }> } };
