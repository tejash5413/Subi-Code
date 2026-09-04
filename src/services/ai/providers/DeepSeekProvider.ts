import { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider } from '../AIProvider';
import { AIStreamEvent } from '../AIStreamEvent';
import { SecretStorageService } from '../../SecretStorageService';
import { SafeModelCatalogItem } from '../../../types';
import { AIErrorClass } from '../AIError';
import { isTextChatCompatible, resolveDeepSeekImageInput } from '../modelFilters';
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

// DeepSeek is OpenAI-compatible on the wire but kept as an independent
// provider so credential identity stays distinct from OpenAI/OpenRouter.
export class DeepSeekProvider implements AIProvider {
  readonly id = 'deepseek' as const;
  private readonly secrets: SecretStorageService;
  private static readonly BASE_URL = 'https://api.deepseek.com';
  private static readonly TIMEOUT_MS = 90_000;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const apiKey = await this.secrets.getApiKey('deepseek');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('DeepSeek API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DeepSeekProvider.TIMEOUT_MS);
    try {
      const response = await fetch(`${DeepSeekProvider.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: request.modelId, messages: toMultimodalMessages(request.messages), stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AIErrorClass.authentication('DeepSeek authentication failed. Please check your API key.');
        }
        if (response.status === 429) {
          throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
        }
        throw AIErrorClass.provider(`DeepSeek error: ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw AIErrorClass.invalidResponse('Invalid JSON response from DeepSeek.');
      }
      const typed = data as { choices?: Array<{ message?: { content?: unknown } }>; model?: string };
      const content = typed.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw AIErrorClass.invalidResponse('Invalid response from DeepSeek.');
      }
      return {
        content: content.trim(),
        provider: 'deepseek',
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
    const apiKey = await this.secrets.getApiKey('deepseek');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('DeepSeek API key not configured.');
    }
    let response: Response;
    try {
      response = await fetch(`${DeepSeekProvider.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
        throw AIErrorClass.authentication('DeepSeek authentication failed. Please check your API key.');
      }
      if (response.status === 429) {
        throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
      }
      throw AIErrorClass.provider(`DeepSeek error: ${response.status}`);
    }
    if (!response.body) {
      throw AIErrorClass.invalidResponse('Invalid response from DeepSeek.');
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
        let chunk: { choices?: Array<{ delta?: { content?: unknown } }>; model?: string };
        try {
          chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; model?: string };
        } catch {
          continue;
        }
        if (!metadataSent && typeof chunk.model === 'string' && chunk.model.length > 0) {
          metadataSent = true;
          yield { type: 'metadata', actualModelId: chunk.model };
        }
        const content = chunk.choices?.[0]?.delta?.content;
        // Stage 4A.2.2 displays user-facing content only; reasoning_content ignored.
        if (typeof content === 'string' && content.length > 0) {
          yield { type: 'textDelta', text: content };
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
    const apiKey = await this.secrets.getApiKey('deepseek');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('DeepSeek API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${DeepSeekProvider.BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw AIErrorClass.authentication('DeepSeek authentication failed. Please check your API key.');
        }
        throw AIErrorClass.provider(`DeepSeek catalogue error: ${res.status}`);
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const items: SafeModelCatalogItem[] = [];
      for (const m of data.data ?? []) {
        if (!m.id || typeof m.id !== 'string') {
          continue;
        }
        const candidate: SafeModelCatalogItem = {
          provider: 'deepseek',
          modelId: m.id,
          label: m.id,
          costClass: 'unknown',
          source: 'remote',
          // Exact-ID rule per official DeepSeek vision guide (verified 2026-09-03):
          // only deepseek-v4-flash-vision-exp accepts images; all other direct
          // models return 400. Never inherited from OpenRouter-hosted entries.
          capabilities: { textInput: true, textOutput: true, imageInput: resolveDeepSeekImageInput(m.id) },
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
