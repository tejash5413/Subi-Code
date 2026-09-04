import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MANAGED_ABSOLUTE_MAX_MS,
  MANAGED_CHAT_ENABLED,
  MANAGED_CHAT_ORIGIN,
  ManagedChatError,
  ManagedChatEvent,
  streamManagedChat,
} from '../managedChatService';

const MESSAGES = [{ role: 'user' as const, content: 'Hello' }];

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(f));
      }
      controller.close();
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function sseResponse(frames: string[]): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: sseBody(frames),
  } as unknown as Response;
}

void test('production gate is FALSE in Phase 8', () => {
  assert.equal(MANAGED_CHAT_ENABLED, false);
  assert.equal(MANAGED_ABSOLUTE_MAX_MS, 540_000);
  assert.ok(MANAGED_CHAT_ORIGIN.includes('subiManagedChatApi'));
  assert.ok(!MANAGED_CHAT_ORIGIN.includes('openrouter'));
});

void test('request uses modelKey only with Bearer token', async () => {
  const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
    seen.url = url;
    seen.headers = init.headers as Record<string, string>;
    seen.body = init.body as string;
    return Promise.resolve(
      sseResponse([
        'event: start\ndata: {"requestId":"7","modelKey":"mdl_a"}\n\n',
        'event: done\ndata: {"requestId":"7","modelKey":"mdl_a"}\n\n',
      ])
    );
  };
  const events: ManagedChatEvent[] = [];
  const out = await streamManagedChat({
    idToken: 'tok-123',
    requestId: '7',
    modelKey: 'mdl_a',
    messages: MESSAGES,
    fetchFn,
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(out, { requestId: '7', modelKey: 'mdl_a' });
  assert.equal(seen.url, `${MANAGED_CHAT_ORIGIN}/chat`);
  assert.equal(seen.headers?.['Authorization'], 'Bearer tok-123');
  assert.equal(seen.headers?.['Content-Type'], 'application/json');
  const parsed = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['messages', 'modelKey', 'requestId']);
  assert.ok(!JSON.stringify(parsed).includes('tok-123'), 'token must not be in body');
  assert.ok(!JSON.stringify(parsed).toLowerCase().includes('provider'));
  assert.ok(!JSON.stringify(parsed).toLowerCase().includes('upstream'));
  assert.deepEqual(events, [
    { type: 'start', requestId: '7', modelKey: 'mdl_a' },
    { type: 'done', requestId: '7', modelKey: 'mdl_a' },
  ]);
});

void test('delta frames stream text', async () => {
  const texts: string[] = [];
  await streamManagedChat({
    idToken: 't',
    requestId: 'r',
    modelKey: 'mdl_a',
    messages: MESSAGES,
    fetchFn: () =>
      Promise.resolve(
        sseResponse([
          'event: start\ndata: {"requestId":"r","modelKey":"mdl_a"}\n\n',
          ': keep-alive\n\n',
          'event: delta\ndata: {"text":"Hel"}\n\n',
          'event: delta\ndata: {"text":"lo"}\n\n',
          'event: done\ndata: {"requestId":"r","modelKey":"mdl_a"}\n\n',
        ])
      ),
    onEvent: (e) => {
      if (e.type === 'delta') {
        texts.push(e.text);
      }
    },
  });
  assert.deepEqual(texts, ['Hel', 'lo']);
});

void test('error frame throws safe code', async () => {
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      fetchFn: () =>
        Promise.resolve(
          sseResponse(['event: error\ndata: {"code":"MODEL_NOT_ALLOWED","message":"No."}\n\n'])
        ),
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError && e.code === 'MODEL_NOT_ALLOWED'
  );
});

void test('HTTP errors map to backend codes', async () => {
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      fetchFn: () => Promise.resolve(jsonResponse(403, { error: { code: 'MODEL_NOT_ALLOWED' } })),
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError && e.code === 'MODEL_NOT_ALLOWED'
  );
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      fetchFn: () => Promise.resolve(jsonResponse(401, {})),
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError && (e as ManagedChatError).code === 'managed_auth'
  );
});

void test('abort maps to CANCELLED', async () => {
  const controller = new AbortController();
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      signal: controller.signal,
      fetchFn: () => {
        controller.abort();
        return Promise.resolve(sseResponse([]));
      },
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError && (e as ManagedChatError).code === 'CANCELLED'
  );
});

void test('malformed stream fails closed', async () => {
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      fetchFn: () => Promise.resolve(sseResponse(['event: delta\ndata: not-json\n\n'])),
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError
  );
  await assert.rejects(
    streamManagedChat({
      idToken: 't',
      requestId: 'r',
      modelKey: 'mdl_a',
      messages: MESSAGES,
      fetchFn: () => Promise.resolve(sseResponse(['event: start\ndata: {"requestId":"r","modelKey":"mdl_a"}\n\n'])),
      onEvent: () => undefined,
    }),
    (e: unknown) => e instanceof ManagedChatError && (e as ManagedChatError).code === 'INTERNAL'
  );
});

void test('invalid options rejected before network', async () => {
  let called = false;
  const fetchFn = (): Promise<Response> => {
    called = true;
    return Promise.resolve(sseResponse([]));
  };
  for (const options of [
    { idToken: '', requestId: 'r', modelKey: 'mdl_a', messages: MESSAGES },
    { idToken: 't', requestId: 'r', modelKey: 'openrouter/free', messages: MESSAGES },
    { idToken: 't', requestId: 'r', modelKey: 'mdl_a', messages: [] },
  ]) {
    await assert.rejects(streamManagedChat({ ...options, fetchFn, onEvent: () => undefined }));
  }
  assert.equal(called, false);
});

void test('host wires managed branch behind FALSE gate', () => {
  const dir = path.join(__dirname, '..', '..', '..', 'sidebar');
  const code = fs.readFileSync(path.join(dir, 'SidebarProvider.js'), 'utf8');
  assert.ok(code.includes('handleManagedSendMessage'), 'host must implement managed send branch');
  assert.ok(code.includes('MANAGED_CHAT_ENABLED'), 'host must consult the production gate');
  assert.ok(code.includes('managedChatAvailable'), 'init must report managed capability');
  assert.ok(code.includes('managedChatController'), 'host must own a managed chat controller');
  // Managed completion carries modelKey only.
  assert.ok(code.includes('modelKey: event.modelKey'), 'managed completion must carry modelKey');
});

void test('managed extension files contain no provider/secret/upstream references', () => {
  const dir = path.join(__dirname, '..');
  const banned = [
    'openrouter.ai',
    'SUBI_OPENROUTER_API_KEY',
    'upstreamModelId',
    'SecretStorage',
    'AIProviderRegistry',
    'getApiKey',
    'selectedAI',
  ];
  for (const file of ['managedChatService.js', 'managedChatHistory.js', 'managedChatController.js']) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const token of banned) {
      assert.ok(!code.includes(token), `${file} must not reference ${token}`);
    }
  }
});
