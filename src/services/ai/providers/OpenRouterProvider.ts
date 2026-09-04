import { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider } from '../AIProvider';
import { AIStreamEvent } from '../AIStreamEvent';
import { SecretStorageService } from '../../SecretStorageService';
import { SafeModelCatalogItem } from '../../../types';
import { AIErrorClass } from '../AIError';
import { classifyOpenRouterCost, isTextChatCompatible } from '../modelFilters';
import { OPENROUTER_FREE_BUILTIN } from '../../../config/models';
import { readSSEEvents } from '../streaming/SSEParser';

type ImagePart = { type: 'image'; mimeType: string; data: Uint8Array };
type TextPart = { type: 'text'; text: string };

/** Provider-native multimodal conversion (OpenAI-compatible content parts). Base64 stays in-host. */
function toMultimodalMessages(messages: AIChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    const images = (m.parts ?? []).filter((p): p is ImagePart => p.type === 'image');
    if (images.length === 0) {
      return { role: m.role, content: m.content };
    }
    const texts = (m.parts ?? []).filter((p): p is TextPart => p.type === 'text').map((p) => p.text);
    const text = texts.join('\n\n') || m.content;
    const content: Array<Record<string, unknown>> = [];
    if (text.length > 0) {
      content.push({ type: 'text', text });
    }
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${Buffer.from(img.data).toString('base64')}` },
      });
    }
    return { role: m.role, content };
  });
}

/**
 * Image-input state from official OpenRouter catalogue metadata.
 * `architecture.modality` looks like "text->text" or "text+image->text".
 */
function imageInputFromModality(modality: string | undefined): 'supported' | 'unsupported' | 'unknown' {
  if (!modality) {
    return 'unknown';
  }
  if (modality.includes('image')) {
    return 'supported';
  }
  return 'unsupported';
}

export class OpenRouterProvider implements AIProvider {
  readonly id = 'openrouter' as const;
  private readonly secrets: SecretStorageService;
  private static readonly BASE_URL = 'https://openrouter.ai/api/v1';
  private static readonly TIMEOUT_MS = 90_000;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const apiKey = await this.secrets.getApiKey('openrouter');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('OpenRouter API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OpenRouterProvider.TIMEOUT_MS);
    try {
      const response = await fetch(`${OpenRouterProvider.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Title': 'Subi',
        },
        body: JSON.stringify({ model: request.modelId, messages: toMultimodalMessages(request.messages), stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AIErrorClass.authentication('OpenRouter authentication failed. Please check your API key.');
        }
        if (response.status === 429) {
          throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
        }
        throw AIErrorClass.provider(`OpenRouter error: ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw AIErrorClass.invalidResponse('Invalid JSON response from OpenRouter.');
      }
      const typed = data as { choices?: unknown; model?: string };
      if (!typed.choices || !Array.isArray(typed.choices) || typed.choices.length === 0) {
        throw AIErrorClass.invalidResponse('Invalid response from OpenRouter.');
      }
      const choice = typed.choices[0] as { message?: unknown };
      if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
        throw AIErrorClass.invalidResponse('Invalid response from OpenRouter.');
      }
      const message = choice.message as { content?: unknown };
      if (typeof message.content !== 'string' || message.content.trim().length === 0) {
        throw AIErrorClass.invalidResponse('Invalid response from OpenRouter.');
      }
      return {
        content: message.content.trim(),
        provider: 'openrouter',
        modelId: request.modelId,
        actualModelId: typeof typed.model === 'string' ? typed.model : undefined,
      };
    } catch (error) {
      if (error instanceof AIErrorClass) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw AIErrorClass.timeout('Request timed out after 90 seconds.');
      }
      if (error instanceof TypeError) {
        throw AIErrorClass.network('Network connection failed.');
      }
      throw AIErrorClass.network('Network connection failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  async *streamChat(request: AIChatRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent> {
    const apiKey = await this.secrets.getApiKey('openrouter');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('OpenRouter API key not configured.');
    }
    let response: Response;
    try {
      response = await fetch(`${OpenRouterProvider.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Title': 'Subi',
        },
        body: JSON.stringify({ model: request.modelId, messages: toMultimodalMessages(request.messages), stream: true }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw AIErrorClass.fromAbort(signal);
      }
      if (error instanceof TypeError) {
        throw AIErrorClass.network('Network connection failed.');
      }
      throw AIErrorClass.network('Network connection failed.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw AIErrorClass.authentication('OpenRouter authentication failed. Please check your API key.');
      }
      if (response.status === 429) {
        throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
      }
      throw AIErrorClass.provider(`OpenRouter error: ${response.status}`);
    }
    if (!response.body) {
      throw AIErrorClass.invalidResponse('Invalid response from OpenRouter.');
    }
    let metadataSent = false;
    try {
      for await (const sse of readSSEEvents(response.body)) {
        if (signal.aborted) {
          throw AIErrorClass.fromAbort(signal);
        }
        const data = sse.data.trim();
        if (data === '[DONE]') {
          break;
        }
        if (data.length === 0) {
          continue;
        }
        let chunk: { choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown } }>; model?: string };
        try {
          chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; model?: string };
        } catch {
          continue; // unparsed framing noise must not keep/break the stream
        }
        if (!metadataSent && typeof chunk.model === 'string' && chunk.model.length > 0) {
          metadataSent = true;
          yield { type: 'metadata', actualModelId: chunk.model };
        }
        const delta = chunk.choices?.[0]?.delta;
        // Stage 4A.2.2 displays user-facing content only; reasoning fields ignored.
        if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'textDelta', text: delta.content };
        }
      }
    } catch (error) {
      if (error instanceof AIErrorClass) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw AIErrorClass.fromAbort(signal);
      }
      throw AIErrorClass.network('Network connection failed.');
    }
    if (signal.aborted) {
      throw AIErrorClass.fromAbort(signal);
    }
    yield { type: 'completed' };
  }

  async listModels(): Promise<SafeModelCatalogItem[]> {
    const apiKey = await this.secrets.getApiKey('openrouter');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${OpenRouterProvider.BASE_URL}/models`, { headers, signal: controller.signal });
      if (!res.ok) {
        throw AIErrorClass.provider(`OpenRouter catalogue error: ${res.status}`);
      }
      const data = (await res.json()) as {
        data?: Array<{
          id?: string;
          name?: string;
          description?: string;
          context_length?: number;
          architecture?: { modality?: string };
          pricing?: { prompt?: string; completion?: string };
        }>;
      };
      const items: SafeModelCatalogItem[] = [OPENROUTER_FREE_BUILTIN];
      for (const m of data.data ?? []) {
        if (!m.id || typeof m.id !== 'string') {
          continue;
        }
        if (m.id === 'openrouter/free') {
          continue; // builtin already present
        }
        const label = typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : m.id;
        const candidate: SafeModelCatalogItem = {
          provider: 'openrouter',
          modelId: m.id,
          label,
          description: typeof m.description === 'string' ? m.description.slice(0, 300) : undefined,
          contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
          capabilities: {
            textInput: true,
            textOutput: true,
            imageInput: imageInputFromModality(m.architecture?.modality),
          },
          costClass: classifyOpenRouterCost(m.pricing),
          source: 'remote',
        };
        if (!isTextChatCompatible(candidate)) {
          continue;
        }
        items.push(candidate);
      }
      return items;
    } finally {
      clearTimeout(timer);
    }
  }
}
