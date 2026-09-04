import { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider } from '../AIProvider';
import { AIStreamEvent } from '../AIStreamEvent';
import { SecretStorageService } from '../../SecretStorageService';
import { SafeModelCatalogItem } from '../../../types';
import { AIErrorClass } from '../AIError';
import { isTextChatCompatible } from '../modelFilters';
import { readSSEEvents } from '../streaming/SSEParser';

type ImagePart = { type: 'image'; mimeType: string; data: Uint8Array };
type TextPart = { type: 'text'; text: string };

/** Provider-native multimodal conversion (Responses API input blocks). Base64 stays in-host. */
function toOpenAIInput(
  messages: AIChatMessage[]
): Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const images = (m.parts ?? []).filter((p): p is ImagePart => p.type === 'image');
      if (images.length === 0) {
        return {
          role: m.role as 'user' | 'assistant',
          content: [{ type: 'input_text' as const, text: m.content }],
        };
      }
      const texts = (m.parts ?? []).filter((p): p is TextPart => p.type === 'text').map((p) => p.text);
      const text = texts.join('\n\n') || m.content;
      const blocks: Array<Record<string, unknown>> = [];
      if (text.length > 0) {
        blocks.push({ type: 'input_text', text });
      }
      for (const img of images) {
        blocks.push({
          type: 'input_image',
          image_url: `data:${img.mimeType};base64,${Buffer.from(img.data).toString('base64')}`,
          detail: 'auto',
        });
      }
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
}

// Direct OpenAI provider using the current Responses API architecture.
// Discovery via GET /v1/models. No hardcoded GPT IDs.
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  private readonly secrets: SecretStorageService;
  private static readonly BASE_URL = 'https://api.openai.com/v1';
  private static readonly TIMEOUT_MS = 90_000;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const apiKey = await this.secrets.getApiKey('openai');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('OpenAI API key not configured.');
    }
    const systemParts = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    const input = toOpenAIInput(request.messages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OpenAIProvider.TIMEOUT_MS);
    try {
      const response = await fetch(`${OpenAIProvider.BASE_URL}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: request.modelId,
          instructions,
          input,
          max_output_tokens: 2048,
          store: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AIErrorClass.authentication('OpenAI authentication failed. Please check your API key.');
        }
        if (response.status === 429) {
          throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
        }
        throw AIErrorClass.provider(`OpenAI error: ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw AIErrorClass.invalidResponse('Invalid JSON response from OpenAI.');
      }
      const text = extractResponsesText(data);
      if (!text) {
        throw AIErrorClass.invalidResponse('Invalid response from OpenAI.');
      }
      return { content: text.trim(), provider: 'openai', modelId: request.modelId };
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
    const apiKey = await this.secrets.getApiKey('openai');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('OpenAI API key not configured.');
    }
    const systemParts = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    const input = toOpenAIInput(request.messages);
    let response: Response;
    try {
      response = await fetch(`${OpenAIProvider.BASE_URL}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: request.modelId,
          instructions,
          input,
          max_output_tokens: 2048,
          store: false,
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
        throw AIErrorClass.authentication('OpenAI authentication failed. Please check your API key.');
      }
      if (response.status === 429) {
        throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
      }
      throw AIErrorClass.provider(`OpenAI error: ${response.status}`);
    }
    if (!response.body) {
      throw AIErrorClass.invalidResponse('Invalid response from OpenAI.');
    }
    let metadataSent = false;
    try {
      for await (const sse of readSSEEvents(response.body)) {
        if (signal.aborted) {
          throw AIErrorClass.fromAbort(signal);
        }
        const data = sse.data.trim();
        if (data === '[DONE]' || data.length === 0) {
          if (data === '[DONE]') {
            break;
          }
          continue;
        }
        let evt: { type?: string; delta?: unknown; response?: { model?: string }; message?: string };
        try {
          evt = JSON.parse(data) as { type?: string; delta?: unknown; response?: { model?: string } };
        } catch {
          continue;
        }
        const kind = sse.event ?? evt.type;
        // User-facing output text only; internal reasoning events never surface.
        if (kind === 'response.output_text.delta') {
          if (typeof evt.delta === 'string' && evt.delta.length > 0) {
            yield { type: 'textDelta', text: evt.delta };
          }
          continue;
        }
        if (kind === 'response.created') {
          const model = evt.response?.model;
          if (!metadataSent && typeof model === 'string' && model.length > 0) {
            metadataSent = true;
            yield { type: 'metadata', actualModelId: model };
          }
          continue;
        }
        if (kind === 'response.completed') {
          const model = evt.response?.model;
          if (!metadataSent && typeof model === 'string' && model.length > 0) {
            metadataSent = true;
            yield { type: 'metadata', actualModelId: model };
          }
          break;
        }
        if (kind === 'error') {
          const msg = typeof evt.message === 'string' && evt.message.length > 0 ? evt.message : 'OpenAI stream error.';
          throw AIErrorClass.provider(msg);
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
    const apiKey = await this.secrets.getApiKey('openai');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('OpenAI API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${OpenAIProvider.BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw AIErrorClass.authentication('OpenAI authentication failed. Please check your API key.');
        }
        throw AIErrorClass.provider(`OpenAI catalogue error: ${res.status}`);
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const items: SafeModelCatalogItem[] = [];
      for (const m of data.data ?? []) {
        if (!m.id || typeof m.id !== 'string') {
          continue;
        }
        const candidate: SafeModelCatalogItem = {
          provider: 'openai',
          modelId: m.id,
          label: m.id,
          costClass: 'unknown',
          source: 'remote',
          // NOTE (4A.2.3.1, verified 2026-09-03): OpenAI GET /v1/models returns
          // only id/created/object/owned_by(+shutdown_date) — no per-model
          // modality fields — so imageInput stays unknown (blocked). No
          // name-pattern guessing and no GPT allowlist by design.
          capabilities: { textInput: true, textOutput: true },
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

function extractResponsesText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as { output_text?: unknown; output?: unknown };
  if (typeof root.output_text === 'string' && root.output_text.trim().length > 0) {
    return root.output_text;
  }
  if (Array.isArray(root.output)) {
    const parts: string[] = [];
    for (const item of root.output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const node = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
      if (node.type === 'message' && Array.isArray(node.content)) {
        for (const c of node.content) {
          if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }
    const joined = parts.join('').trim();
    if (joined.length > 0) {
      return joined;
    }
  }
  return undefined;
}
