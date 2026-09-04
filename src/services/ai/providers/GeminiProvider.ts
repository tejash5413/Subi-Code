import { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider } from '../AIProvider';
import { AIStreamEvent } from '../AIStreamEvent';
import { SecretStorageService } from '../../SecretStorageService';
import { SafeModelCatalogItem } from '../../../types';
import { AIErrorClass } from '../AIError';
import { isTextChatCompatible, supportsTextGenerationMethod } from '../modelFilters';
import { readSSEEvents } from '../streaming/SSEParser';

type ImagePart = { type: 'image'; mimeType: string; data: Uint8Array };
type TextPart = { type: 'text'; text: string };

/** Provider-native multimodal conversion (Gemini content parts). Base64 stays in-host. */
function toGeminiContents(
  messages: AIChatMessage[]
): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const images = (m.parts ?? []).filter((p): p is ImagePart => p.type === 'image');
      const texts = (m.parts ?? []).filter((p): p is TextPart => p.type === 'text').map((p) => p.text);
      const text = images.length > 0 ? texts.join('\n\n') || m.content : m.content;
      const parts: Array<Record<string, unknown>> = [{ text }];
      for (const img of images) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: Buffer.from(img.data).toString('base64'),
          },
        });
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
}

export class GeminiProvider implements AIProvider {
  readonly id = 'google' as const;
  private readonly secrets: SecretStorageService;
  private static readonly BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
  private static readonly TIMEOUT_MS = 90_000;

  constructor(secrets: SecretStorageService) {
    this.secrets = secrets;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const apiKey = await this.secrets.getApiKey('google');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Google Gemini API key not configured.');
    }
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = toGeminiContents(request.messages);
    if (contents.length === 0) {
      throw AIErrorClass.invalidResponse('No user message to send.');
    }
    const body: Record<string, unknown> = { contents };
    if (systemText.length > 0) {
      body.system_instruction = { parts: [{ text: systemText }] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GeminiProvider.TIMEOUT_MS);
    try {
      const url = `${GeminiProvider.BASE_URL}/models/${encodeURIComponent(request.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw AIErrorClass.authentication('Google authentication failed. Please check your API key.');
        }
        if (response.status === 429) {
          throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
        }
        throw AIErrorClass.provider(`Google error: ${response.status}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw AIErrorClass.invalidResponse('Invalid JSON response from Google.');
      }
      const text = extractGeminiText(data);
      if (!text) {
        throw AIErrorClass.invalidResponse('Invalid response from Google.');
      }
      return { content: text.trim(), provider: 'google', modelId: request.modelId };
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
    const apiKey = await this.secrets.getApiKey('google');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Google Gemini API key not configured.');
    }
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = toGeminiContents(request.messages);
    if (contents.length === 0) {
      throw AIErrorClass.invalidResponse('No user message to send.');
    }
    const body: Record<string, unknown> = { contents };
    if (systemText.length > 0) {
      body.system_instruction = { parts: [{ text: systemText }] };
    }
    let response: Response;
    try {
      const url = `${GeminiProvider.BASE_URL}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        throw AIErrorClass.authentication('Google authentication failed. Please check your API key.');
      }
      if (response.status === 429) {
        throw AIErrorClass.rateLimit('Rate limit reached. Try again later.');
      }
      throw AIErrorClass.provider(`Google error: ${response.status}`);
    }
    if (!response.body) {
      throw AIErrorClass.invalidResponse('Invalid response from Google.');
    }
    try {
      for await (const sse of readSSEEvents(response.body)) {
        if (signal.aborted) {
          throw AIErrorClass.fromAbort(signal);
        }
        const data = sse.data.trim();
        if (data.length === 0) {
          continue;
        }
        let chunk: { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
        try {
          chunk = JSON.parse(data) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
        } catch {
          continue;
        }
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) {
          continue;
        }
        for (const part of parts) {
          // Only user-facing generated text; non-text metadata ignored.
          if (part && typeof part.text === 'string' && part.text.length > 0) {
            yield { type: 'textDelta', text: part.text };
          }
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
    const apiKey = await this.secrets.getApiKey('google');
    if (!apiKey) {
      throw AIErrorClass.notConfigured('Google Gemini API key not configured.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(
        `${GeminiProvider.BASE_URL}/models?pageSize=100&key=${encodeURIComponent(apiKey)}`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw AIErrorClass.authentication('Google authentication failed. Please check your API key.');
        }
        throw AIErrorClass.provider(`Google catalogue error: ${res.status}`);
      }
      const data = (await res.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          description?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      const items: SafeModelCatalogItem[] = [];
      for (const m of data.models ?? []) {
        if (!m.name || typeof m.name !== 'string') {
          continue;
        }
        const modelId = m.name.replace(/^models\//, '');
        if (!supportsTextGenerationMethod(m.supportedGenerationMethods)) {
          continue;
        }
        const candidate: SafeModelCatalogItem = {
          provider: 'google',
          modelId,
          label: typeof m.displayName === 'string' && m.displayName.length > 0 ? m.displayName : modelId,
          description: typeof m.description === 'string' ? m.description.slice(0, 300) : undefined,
          contextLength: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
          costClass: 'unknown',
          source: 'remote',
          // NOTE (4A.2.3.1, verified 2026-09-03): the Gemini Model resource
          // exposes no input-modality field (only supportedGenerationMethods
          // etc.), so imageInput stays unknown (blocked). No name inference.
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

function extractGeminiText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!Array.isArray(root.candidates) || root.candidates.length === 0) {
    return undefined;
  }
  const parts = root.candidates[0]?.content?.parts ?? [];
  const texts: string[] = [];
  for (const p of parts) {
    if (p && typeof p.text === 'string') {
      texts.push(p.text);
    }
  }
  const joined = texts.join('').trim();
  return joined.length > 0 ? joined : undefined;
}
