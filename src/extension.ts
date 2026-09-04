import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { WorkspaceService } from './services/WorkspaceService';
import { ProjectFileService } from './services/ProjectFileService';
import { ProjectSearchService } from './services/ProjectSearchService';
import { AccessModeService } from './services/AccessModeService';
import { SecretStorageService } from './services/SecretStorageService';
import { AIService } from './services/ai/AIService';
import { AIProviderRegistry } from './services/ai/AIProviderRegistry';
import { ModelCatalogService } from './services/ai/ModelCatalogService';
import { OpenRouterProvider } from './services/ai/providers/OpenRouterProvider';
import { OpenAIProvider } from './services/ai/providers/OpenAIProvider';
import { AnthropicProvider } from './services/ai/providers/AnthropicProvider';
import { GeminiProvider } from './services/ai/providers/GeminiProvider';
import { DeepSeekProvider } from './services/ai/providers/DeepSeekProvider';
import { registerApiKeyCommands } from './commands/apiKeyCommands';
import { AttachmentService } from './services/attachments/AttachmentService';
import { LearnSmartFirebase } from './services/auth/LearnSmartFirebase';
import { LearnSmartAuthService } from './services/auth/LearnSmartAuthService';
import { LearnSmartManagedService } from './services/managed/learnsmartManagedService';
import { MANAGED_SELECTION_KEY, ManagedSessionController } from './services/managed/managedSessionController';
import { AgentModeService } from './agent/AgentModeService';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceService = new WorkspaceService();
  const projectFileService = new ProjectFileService();
  const projectSearchService = new ProjectSearchService(projectFileService);
  const accessModeService = new AccessModeService(context);
  const secretStorageService = new SecretStorageService(context.secrets);
  const agentModeService = new AgentModeService(context);

  const registry = new AIProviderRegistry(secretStorageService);
  registry.register(new OpenRouterProvider(secretStorageService));
  registry.register(new OpenAIProvider(secretStorageService));
  registry.register(new AnthropicProvider(secretStorageService));
  registry.register(new GeminiProvider(secretStorageService));
  registry.register(new DeepSeekProvider(secretStorageService));

  const catalogs = new ModelCatalogService(registry, secretStorageService);
  const attachmentService = new AttachmentService();
  // LearnSmart identity is additive: activation never touches Firebase
  // unless the user signs in, so BYOK/chat/tools always load regardless.
  const learnSmartAuthService = new LearnSmartAuthService(new LearnSmartFirebase());
  const aiService = new AIService(registry, catalogs, secretStorageService, context.globalState, attachmentService);
  // Managed SUBI policy backend (Phase 6): configuration reads only, no
  // inference. Only the safe selected modelKey persists (GlobalState); the
  // session itself, models, limits, and tokens stay in memory.
  const managedService = new LearnSmartManagedService();
  const managedController = new ManagedSessionController(learnSmartAuthService, managedService, {
    loadSelectedModelKey: () =>
      context.globalState.get<string>(MANAGED_SELECTION_KEY) ?? undefined,
    saveSelectedModelKey: (modelKey) => {
      void context.globalState.update(MANAGED_SELECTION_KEY, modelKey);
    },
  });

  const provider = new SidebarProvider(
    context.extensionUri,
    workspaceService,
    projectFileService,
    projectSearchService,
    accessModeService,
    aiService,
    secretStorageService,
    registry,
    catalogs,
    attachmentService,
    learnSmartAuthService,
    managedService,
    managedController,
    agentModeService
  );

  registerApiKeyCommands(context, secretStorageService, accessModeService, provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider),
    workspaceService,
    projectFileService,
    projectSearchService,
    attachmentService,
    learnSmartAuthService
  );

  console.log('Subi extension activated');
}

export function deactivate(): void {
  console.log('Subi extension deactivated');
}
