import * as vscode from 'vscode';
import { AIProviderId } from '../types';
import { isSupportedProviderId } from '../config/providers';

export class SecretStorageService {
  private readonly secrets: vscode.SecretStorage;
  private static readonly PREFIX = 'subi.provider.';
  private static readonly SUFFIX = '.apiKey';
  // Legacy single-provider key (Stage 4A.2). Same value as generic openrouter key.
  private static readonly LEGACY_OPENROUTER_KEY = 'subi.provider.openrouter.apiKey';

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  private keyFor(provider: AIProviderId): string {
    return `${SecretStorageService.PREFIX}${provider}${SecretStorageService.SUFFIX}`;
  }

  private assertValid(provider: AIProviderId): void {
    if (!isSupportedProviderId(provider)) {
      throw new Error(`validation:Unknown provider: ${String(provider)}`);
    }
  }

  async getApiKey(provider: AIProviderId): Promise<string | undefined> {
    this.assertValid(provider);
    const raw = await this.secrets.get(this.keyFor(provider));
    if (raw !== undefined && raw.trim().length > 0) {
      return raw;
    }
    return undefined;
  }

  async setApiKey(provider: AIProviderId, key: string): Promise<void> {
    this.assertValid(provider);
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new Error('validation:API key cannot be empty.');
    }
    await this.secrets.store(this.keyFor(provider), trimmed);
  }

  async clearApiKey(provider: AIProviderId): Promise<void> {
    this.assertValid(provider);
    await this.secrets.delete(this.keyFor(provider));
  }

  async hasApiKey(provider: AIProviderId): Promise<boolean> {
    return (await this.getApiKey(provider)) !== undefined;
  }

  /** @deprecated Use getApiKey('openrouter'). Kept for safe migration. */
  async getOpenRouterApiKey(): Promise<string | undefined> {
    return this.secrets.get(SecretStorageService.LEGACY_OPENROUTER_KEY);
  }

  /** @deprecated Use setApiKey('openrouter', key). Kept for safe migration. */
  async setOpenRouterApiKey(key: string): Promise<void> {
    await this.setApiKey('openrouter', key);
  }

  /** @deprecated Use clearApiKey('openrouter'). Kept for safe migration. */
  async clearOpenRouterApiKey(): Promise<void> {
    await this.clearApiKey('openrouter');
  }
}
