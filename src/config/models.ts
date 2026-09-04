import { SafeModelCatalogItem } from '../types';

// Only permanently built-in inference model: OpenRouter Auto Free.
// All other models are discovered dynamically via ModelCatalogService.
export const OPENROUTER_FREE_BUILTIN: SafeModelCatalogItem = {
  provider: 'openrouter',
  modelId: 'openrouter/free',
  label: 'Auto Free',
  description: 'OpenRouter automatic free-model routing',
  costClass: 'free',
  source: 'builtin',
  capabilities: { textInput: true, textOutput: true },
};

export const BUILTIN_MODELS: SafeModelCatalogItem[] = [OPENROUTER_FREE_BUILTIN];

export const DEFAULT_SELECTION = { provider: 'openrouter' as const, modelId: 'openrouter/free' };

// Legacy compat for any residual callers (Stage 4A.2 shape).
export interface ModelConfig {
  id: string;
  label: string;
  provider: 'openrouter';
}

export const MODEL_CONFIGS: ModelConfig[] = [
  { id: 'openrouter/free', label: 'Auto Free', provider: 'openrouter' },
];

export const DEFAULT_MODEL_ID = 'openrouter/free';
export const AUTO_MODEL_ID = 'openrouter/free';

export function resolveModelId(modelId: string): string {
  return modelId === 'auto' ? AUTO_MODEL_ID : modelId;
}

export function isValidModelId(modelId: string): boolean {
  return resolveModelId(modelId) === 'openrouter/free';
}
