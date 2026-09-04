import { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider } from '../AIProvider';
import { AIStreamEvent } from '../AIStreamEvent';
import { SecretStorageService } from '../../SecretStorageService';
import { SafeModelCatalogItem } from '../../../types';
import { AIErrorClass } from '../AIError';
import { isTextChatCompatible, resolveAnthropicImageInput } from '../modelFilters';
import { readSSEEvents } from '../streaming/SSEParser';

type ImagePart = { type: 'image'; mimeType: string; data: Uint8Array };
type TextPart = { type: 'text'; text: string };

/** Provider-native multimodal conversion (Anthropic content blocks). Base64 stays in-host. */
function toAnthropicMessages(
  messages: AIChatMessage[]
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const images = (m.parts ?? []).filter((p): p is ImagePart => p.type === 'image');
      if (images.length === 0) {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      const texts = (m.parts ?? []).filter((p): p is TextPart => p.type === 'text').map((p) => p.text);
      const text = texts.join('\n\n') || m.content;
      const blocks: Array<Record<string, unknown>> = [];
      if (text.length > 0) {
        blocks.push({ type: 'text', text });
      }
      for (const img of images) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: Buffer.from(img.data).toString('base64'),
          },
        });
      }
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  private readonly secrets: SecretStorageService;
  private static readonly BASE_URL = 'https://api.anthropic.com/v1';
  private static readonly ANTHROPIC_VERSION = '2023-06-01';
  private static readonly TIMEOUT_MS = 90_000;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const apiKey = await this.secrets.getApiKey('anthropic');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Anthropic API key not configured.');
    }
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = toAnthropicMessages(request.messages);
    if (messages.length === 0) {
      throw AIErrorClass.invalidResponse('No user message to send.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AnthropicProvider.TIMEOUT_MS);
    try {
      const response = await fetch(`${AnthropicProvider.BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': AnthropicProvider.ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.modelId,
          max_tokens: 2048,
          system: system.length > 0 ? system : undefined,
          messages,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AIErrorClass.authentication('Anthropic authentication failed. Please check your API key.');
        }
        if (response.status === 429) {
          throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
        }
        throw AIErrorClass.provider(`Anthropic error: ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw AIErrorClass.invalidResponse('Invalid JSON response from Anthropic.');
      }
      const text = extractAnthropicText(data);
      if (!text) {
        throw AIErrorClass.invalidResponse('Invalid response from Anthropic.');
      }
      return { content: text.trim(), provider: 'anthropic', modelId: request.modelId };
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
    const apiKey = await this.secrets.getApiKey('anthropic');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Anthropic API key not configured.');
    }
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = toAnthropicMessages(request.messages);
    if (messages.length === 0) {
      throw AIErrorClass.invalidResponse('No user message to send.');
    }
    let response: Response;
    try {
      response = await fetch(`${AnthropicProvider.BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': AnthropicProvider.ANTHROPIC_VERSION,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.modelId,
          max_tokens: 2048,
          system: system.length > 0 ? system : undefined,
          messages,
          stream: true,
        }),
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
        throw AIErrorClass.authentication('Anthropic authentication failed. Please check your API key.');
      }
      if (response.status === 429) {
        throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
      }
      throw AIErrorClass.provider(`Anthropic error: ${response.status}`);
    }
    if (!response.body) {
      throw AIErrorClass.invalidResponse('Invalid response from Anthropic.');
    }
    let metadataSent = false;
    try {
      for await (const sse of readSSEEvents(response.body)) {
        if (signal.aborted) {
          throw AIErrorClass.fromAbort(signal);
        }
        const data = sse.data.trim();
        if (data.length === 0) {
          continue;
        }
        let evt: { type?: string; message?: { model?: string }; delta?: { type?: string; text?: unknown }; error?: { message?: string } };
        try {
          evt = JSON.parse(data) as { type?: string; message?: { model?: string }; delta?: { type?: string; text?: unknown } };
        } catch {
          continue;
        }
        const kind = sse.event ?? evt.type;
        if (kind === 'message_start') {
          const model = evt.message?.model;
          if (!metadataSent && typeof model === 'string' && model.length > 0) {
            metadataSent = true;
            yield { type: 'metadata', actualModelId: model };
          }
          continue;
        }
        if (kind === 'content_block_delta') {
          // User-facing text only; thinking_delta / signature_delta / input_json_delta ignored.
          const delta = evt.delta;
          if (delta && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            yield { type: 'textDelta', text: delta.text };
          }
          continue;
        }
        if (kind === 'message_stop') {
          break;
        }
        if (kind === 'error') {
          const msg = typeof evt.error?.message === 'string' ? evt.error.message : 'Anthropic stream error.';
          throw AIErrorClass.provider(msg);
        }
        // ping and other non-text events are safely ignored.
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
    const apiKey = await this.secrets.getApiKey('anthropic');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Anthropic API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${AnthropicProvider.BASE_URL}/models?limit=1000`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': AnthropicProvider.ANTHROPIC_VERSION,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw AIErrorClass.authentication('Anthropic authentication failed. Please check your API key.');
        }
        throw AIErrorClass.provider(`Anthropic catalogue error: ${res.status}`);
      }
      const data = (await res.json()) as {
        data?: Array<{
          id?: string;
          display_name?: string;
          max_input_tokens?: number | null;
          capabilities?: { image_input?: { supported?: unknown } } | null;
        }>;
      };
      const items: SafeModelCatalogItem[] = [];
      for (const m of data.data ?? []) {
        if (!m.id || typeof m.id !== 'string') {
          continue;
        }
        const candidate: SafeModelCatalogItem = {
          provider: 'anthropic',
          modelId: m.id,
          label: typeof m.display_name === 'string' && m.display_name.length > 0 ? m.display_name : m.id,
          contextLength: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
          costClass: 'unknown',
          source: 'remote',
          // Trusted per-model metadata only; absent metadata fails closed to unknown.
          capabilities: { textInput: true, textOutput: true, imageInput: resolveAnthropicImageInput(m.capabilities) },
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

function extractAnthropicText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(root.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of root.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : undefined;
}
