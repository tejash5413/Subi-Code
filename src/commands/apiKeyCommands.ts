import * as vscode from 'vscode';
import { SecretStorageService } from '../services/SecretStorageService';
import { AccessModeService } from '../services/AccessModeService';
import { SidebarProvider } from '../sidebar/SidebarProvider';
import { PROVIDER_DEFINITIONS } from '../config/providers';
import { AIProviderId } from '../types';
import { isSupportedProviderId, getProviderCredentialLabel, getProviderLabel } from '../config/providers';

async function askProviderPlace(): Promise<AIProviderId | undefined> {
  const pick = await vscode.window.showQuickPick(
    PROVIDER_DEFINITIONS.map((p) => ({ label: p.label, description: p.id, id: p.id as AIProviderId })),
    { placeHolder: 'Select AI provider' }
  );
  return pick?.id;
}

async function configureProviderFlow(
  provider: AIProviderId,
  secretStorageService: SecretStorageService,
  accessModeService: AccessModeService,
  sidebar: SidebarProvider
): Promise<void> {
  if (!isSupportedProviderId(provider)) {
    return;
  }
  // Phase 7 Change 1: provider configuration is BYOK-only. LearnSmart mode
  // blocks it even though the commands stay registered for BYOK users.
  if (accessModeService.getAccessMode() === 'learnsmart') {
    vscode.window.showInformationMessage('Provider configuration is not available in LearnSmart mode.');
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
  await secretStorageService.setApiKey(provider, trimmed);
  await accessModeService.setAccessMode('byok');
  sidebar.notifyProviderStatusChange();
  sidebar.notifyOnboardingComplete();
  vscode.window.showInformationMessage(`${getProviderLabel(provider)} API key configured successfully.`);
}

export function registerApiKeyCommands(
  context: vscode.ExtensionContext,
  secretStorageService: SecretStorageService,
  accessModeService: AccessModeService,
  provider: SidebarProvider
): void {
  // Generic multi-provider commands.
  const configureCmd = vscode.commands.registerCommand('subi.configureAIProvider', async () => {
    const id = await askProviderPlace();
    if (!id) {
      return;
    }
    await configureProviderFlow(id, secretStorageService, accessModeService, provider);
  });

  const removeCmd = vscode.commands.registerCommand('subi.removeAIProviderKey', async () => {
    const id = await askProviderPlace();
    if (!id) {
      return;
    }
    if (accessModeService.getAccessMode() === 'learnsmart') {
      vscode.window.showInformationMessage('Provider configuration is not available in LearnSmart mode.');
      return;
    }
    await secretStorageService.clearApiKey(id);
    const currentMode = accessModeService.getAccessMode();
    if (currentMode === 'byok') {
      provider.notifyProviderStatusChange();
    } else {
      provider.notifyProviderStatusChange();
    }
    vscode.window.showInformationMessage(`${getProviderLabel(id)} API key removed.`);
  });

  // Backward-compat OpenRouter commands (deprecated shims reusing the same secure helper).
  const setKeyCommand = vscode.commands.registerCommand('subi.setOpenRouterApiKey', async () => {
    await configureProviderFlow('openrouter', secretStorageService, accessModeService, provider);
  });

  const clearKeyCommand = vscode.commands.registerCommand('subi.clearOpenRouterApiKey', async () => {
    if (accessModeService.getAccessMode() === 'learnsmart') {
      vscode.window.showInformationMessage('Provider configuration is not available in LearnSmart mode.');
      return;
    }
    await secretStorageService.clearApiKey('openrouter');
    const currentMode = accessModeService.getAccessMode();
    if (currentMode === 'byok') {
      await accessModeService.clearAccessMode();
      provider.notifyProviderStatusCleared();
    } else {
      provider.notifyProviderStatusChange();
    }
    vscode.window.showInformationMessage('OpenRouter API key cleared.');
  });

  context.subscriptions.push(configureCmd, removeCmd, setKeyCommand, clearKeyCommand);
}
