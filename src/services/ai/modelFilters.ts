import { ModelCostClass, SafeModelCatalogItem } from '../../types';

// High-confidence exclusion patterns only. Do NOT exclude vision/audio/
// multimodal — those usually still support text chat. Exclude only
// modalities that cannot serve Stage 4A text chat.
const EXCLUDE_PATTERNS = [
  /embed/i,
  /rerank/i,
  /text-to-speech|^tts\b|\btts\b/i,
  /speech-to-text|\bstt\b|transcri/i,
  /text-to-image|image-generation|image_gen/i,
  /text-to-video|video-generation|video_gen/i,
  /^whisper/i,
  /dall-e/i,
];

const EXCLUDE_GENERATION_METHODS = new Set(['embedContent', 'embedText', 'predict']);

export function isTextChatCompatible(item: Pick<SafeModelCatalogItem, 'modelId' | 'label' | 'description'>): boolean {
  const hay = `${item.modelId} ${item.label} ${item.description ?? ''}`;
  // Embedding-only / reranker-only / TTS-only / STT-only / image-only / video-only
  if (/(embedding|embed).*(only)?/i.test(hay) && !/chat|instruct|turbo|gpt|claude|gemini|deepseek|llama|mistral|qwen|grok/i.test(hay)) {
    // fall through to pattern checks below for precision
  }
  for (const re of EXCLUDE_PATTERNS) {
    if (re.test(hay)) {
      // Guard: "whisper" etc. excluded; but "vision"/"audio" intentionally NOT excluded.
      return false;
    }
  }
  return true;
}

export function supportsTextGenerationMethod(methods: string[] | undefined): boolean {
  if (!methods || methods.length === 0) {
    return true; // unknown capability -> conservative keep (do not hide valid models)
  }
  if (methods.includes('generateContent') || methods.includes('generateAnswer') || methods.includes('chatCompletions')) {
    return true;
  }
  // If only embedding/predict methods are offered, exclude.
  if (methods.every((m) => EXCLUDE_GENERATION_METHODS.has(m))) {
    return false;
  }
  return true;
}

export function filterTextChatModels<T extends Pick<SafeModelCatalogItem, 'modelId' | 'label' | 'description'>>(items: T[]): T[] {
  return items.filter((i) => isTextChatCompatible(i));
}

export function classifyOpenRouterCost(pricing: { prompt?: string | number; completion?: string | number } | undefined): ModelCostClass {
  if (!pricing) {
    return 'unknown';
  }
  const p = pricing.prompt !== undefined ? Number(pricing.prompt) : NaN;
  const c = pricing.completion !== undefined ? Number(pricing.completion) : NaN;
  if (!Number.isNaN(p) && !Number.isNaN(c) && p === 0 && c === 0) {
    return 'free';
  }
  if (!Number.isNaN(p) && !Number.isNaN(c) && (p > 0 || c > 0)) {
    return 'paid';
  }
  return 'unknown';
}

export function searchModelsLocal<T extends { label: string; modelId: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return items;
  }
  return items.filter(
    (i) => i.label.toLowerCase().includes(q) || i.modelId.toLowerCase().includes(q)
  );
}

export type ImageInputState = 'supported' | 'unsupported' | 'unknown';

/**
 * Conservative Anthropic image-input resolver (Stage 4A.2.3.1).
 *
 * Anthropic's GET /v1/models response carries no modality field, but it does
 * carry a per-model `capabilities.image_input.supported` boolean (verified
 * against the current official Models API reference on 2026-09-03).
 * Normalize that trusted metadata only: explicit true -> supported, explicit
 * false -> unsupported, anything else (absent/null/malformed) -> unknown.
 * Never infer from model IDs or display names; unknown future models fail
 * closed (blocked by the send gate) until the catalogue reports support.
 */
export function resolveAnthropicImageInput(capabilities: unknown): ImageInputState {
  if (!capabilities || typeof capabilities !== 'object') {
    return 'unknown';
  }
  const imageInput = (capabilities as { image_input?: unknown }).image_input;
  if (!imageInput || typeof imageInput !== 'object') {
    return 'unknown';
  }
  const supported = (imageInput as { supported?: unknown }).supported;
  if (supported === true) {
    return 'supported';
  }
  if (supported === false) {
    return 'unsupported';
  }
  return 'unknown';
}

/**
 * DeepSeek image-input resolver (Stage 4A.2.3.1).
 *
 * Per the current official DeepSeek vision guide
 * (api-docs.deepseek.com/guides/vision, verified 2026-09-03): ONLY
 * `deepseek-v4-flash-vision-exp` accepts images; all other direct models
 * return 400 "does not support image". Exact-ID match only — no
 * prefix/name inference, and never inherited from OpenRouter-hosted
 * DeepSeek entries. Revisit if official direct metadata adds a model.
 */
export function resolveDeepSeekImageInput(modelId: string): ImageInputState {
  if (modelId === 'deepseek-v4-flash-vision-exp') {
    return 'supported';
  }
  return 'unsupported';
}
