import { AIProviderId, ProviderStatusItem } from '../../types';
import { isSupportedProviderId, PROVIDER_DEFINITIONS } from '../../config/providers';
import { AIProvider } from './AIProvider';
import { SecretStorageService } from '../SecretStorageService';

export class AIProviderRegistry {
  private readonly providers = new Map<AIProviderId, AIProvider>();
  private readonly secrets: SecretStorageService;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  isSupportedProvider(value: unknown): value is AIProviderId {
    return isSupportedProviderId(value);
  }

  getProvider(providerId: AIProviderId): AIProvider {
    if (!isSupportedProviderId(providerId)) {
      throw new Error(`validation:Unknown provider: ${String(providerId)}`);
    }
    const p = this.providers.get(providerId);
    if (!p) {
      throw new Error(`validation:Unsupported provider: ${providerId}`);
    }
    return p;
  }

  async getConfiguredProviders(): Promise<AIProviderId[]> {
    const out: AIProviderId[] = [];
    for (const def of PROVIDER_DEFINITIONS) {
      if (await this.secrets.hasApiKey(def.id)) {
        out.push(def.id);
      }
    }
    return out;
  }

  async getProviderStatuses(): Promise<ProviderStatusItem[]> {
    const out: ProviderStatusItem[] = [];
    for (const def of PROVIDER_DEFINITIONS) {
      out.push({ id: def.id, label: def.label, configured: await this.secrets.hasApiKey(def.id) });
    }
    return out;
  }
}
