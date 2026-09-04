import { AIProviderId } from '../types';

export interface ProviderDefinition {
  id: AIProviderId;
  label: string;
  credentialLabel: string;
  supportsModelDiscovery: boolean;
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  { id: 'openrouter', label: 'OpenRouter', credentialLabel: 'OpenRouter API key', supportsModelDiscovery: true },
  { id: 'openai', label: 'OpenAI', credentialLabel: 'OpenAI API key', supportsModelDiscovery: true },
  { id: 'anthropic', label: 'Anthropic / Claude', credentialLabel: 'Anthropic API key', supportsModelDiscovery: true },
  { id: 'google', label: 'Google Gemini', credentialLabel: 'Google Gemini API key', supportsModelDiscovery: true },
  { id: 'deepseek', label: 'DeepSeek', credentialLabel: 'DeepSeek API key', supportsModelDiscovery: true },
];

export function isSupportedProviderId(value: unknown): value is AIProviderId {
  return (
    value === 'openrouter' ||
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'google' ||
    value === 'deepseek'
  );
}

export function getProviderLabel(provider: AIProviderId): string {
  const found = PROVIDER_DEFINITIONS.find((p) => p.id === provider);
  return found ? found.label : provider;
}

export function getProviderCredentialLabel(provider: AIProviderId): string {
  const found = PROVIDER_DEFINITIONS.find((p) => p.id === provider);
  return found ? found.credentialLabel : `${provider} API key`;
}
