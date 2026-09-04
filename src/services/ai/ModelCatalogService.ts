import { AIProviderId, SafeModelCatalogItem } from '../../types';
import { isSupportedProviderId } from '../../config/providers';
import { BUILTIN_MODELS } from '../../config/models';
import { AIProviderRegistry } from './AIProviderRegistry';
import { SecretStorageService } from '../SecretStorageService';
import { searchModelsLocal } from './modelFilters';

interface CacheEntry {
  items: SafeModelCatalogItem[];
  fetchedAt: number;
}

export class ModelCatalogService {
  private static readonly TTL_MS = 15 * 60 * 1000;
  private readonly cache = new Map<AIProviderId, CacheEntry>();
  private readonly registry: AIProviderRegistry;
  private readonly secrets: SecretStorageService;

  constructor(registry: AIProviderRegistry, secrets: SecretStorageService) {
    this.registry = registry;
    this.secrets = secrets;
  }

  private builtinsFor(provider: AIProviderId): SafeModelCatalogItem[] {
    return BUILTIN_MODELS.filter((m) => m.provider === provider);
  }

  async listModels(provider: AIProviderId): Promise<{ models: SafeModelCatalogItem[]; fromCache: boolean }> {
    if (!isSupportedProviderId(provider)) {
      throw new Error(`validation:Unknown provider: ${String(provider)}`);
    }
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < ModelCatalogService.TTL_MS) {
      return { models: cached.items, fromCache: true };
    }
    return { models: await this.refreshModels(provider), fromCache: false };
  }

  async refreshModels(provider: AIProviderId): Promise<SafeModelCatalogItem[]> {
    if (!isSupportedProviderId(provider)) {
      throw new Error(`validation:Unknown provider: ${String(provider)}`);
    }
    const configured = await this.secrets.hasApiKey(provider);
    if (!configured) {
      const builtins = this.builtinsFor(provider);
      this.cache.set(provider, { items: builtins, fetchedAt: Date.now() });
      return builtins;
    }
    const adapter = this.registry.getProvider(provider);
    if (!adapter.listModels) {
      const builtins = this.builtinsFor(provider);
      this.cache.set(provider, { items: builtins, fetchedAt: Date.now() });
      return builtins;
    }
    const remote = await adapter.listModels();
    const merged = this.mergeWithBuiltins(provider, remote);
    this.cache.set(provider, { items: merged, fetchedAt: Date.now() });
    return merged;
  }

  getCachedModels(provider: AIProviderId): SafeModelCatalogItem[] | undefined {
    return this.cache.get(provider)?.items;
  }

  searchModels(provider: AIProviderId, query: string): SafeModelCatalogItem[] {
    const cached = this.cache.get(provider)?.items ?? this.builtinsFor(provider);
    return searchModelsLocal(cached, query);
  }

  findModel(provider: AIProviderId, modelId: string): SafeModelCatalogItem | undefined {
    const cached = this.cache.get(provider)?.items ?? this.builtinsFor(provider);
    const direct = cached.find((m) => m.modelId === modelId);
    if (direct) {
      return direct;
    }
    // Builtins are always trusted even before first catalogue fetch.
    return this.builtinsFor(provider).find((m) => m.modelId === modelId);
  }

  private mergeWithBuiltins(provider: AIProviderId, remote: SafeModelCatalogItem[]): SafeModelCatalogItem[] {
    const builtins = this.builtinsFor(provider);
    const seen = new Set(remote.map((m) => m.modelId));
    const out = [...remote];
    for (const b of builtins) {
      if (!seen.has(b.modelId)) {
        out.unshift(b);
      }
    }
    return out;
  }

  clearCache(provider?: AIProviderId): void {
    if (provider) {
      this.cache.delete(provider);
    } else {
      this.cache.clear();
    }
  }
}
