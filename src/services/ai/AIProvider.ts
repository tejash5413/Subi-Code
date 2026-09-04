import { AIChatMessage, AIChatRequest, AIChatResponse, AIProviderId, SafeModelCatalogItem } from '../../types';
import { AIStreamEvent } from './AIStreamEvent';

export type { AIChatMessage, AIChatRequest, AIChatResponse };
export type { AIStreamEvent };

export interface AIProvider {
  readonly id: AIProviderId;
  chat(request: AIChatRequest): Promise<AIChatResponse>;
  streamChat(request: AIChatRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent>;
  listModels?(): Promise<SafeModelCatalogItem[]>;
}
