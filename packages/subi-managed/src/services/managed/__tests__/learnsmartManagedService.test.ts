import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LearnSmartManagedService,
  ManagedError,
} from '../learnsmartManagedService';

const TOKEN = 'test-id-token-abc123';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function serviceWith(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs = 1000
): { service: LearnSmartManagedService; seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  const service = new LearnSmartManagedService(
    'https://example.invalid/subiManagedApi',
    timeoutMs,
    (url, init) => {
      seen.push({ url, init });
      return handler(url, init);
    }
  );
  return { service, seen };
}

void test('access allowed', async () => {
  const { service, seen } = serviceWith(() => Promise.resolve(jsonResponse(200, { allowed: true })));
  assert.deepEqual(await service.getAccessStatus(TOKEN), { allowed: true });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]);
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(headers['Accept'], 'application/json');
  assert.ok(seen[0].url.endsWith('/managed/access-status'));
});

void test('access disabled code passes through', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { allowed: false, code: 'SUBI_ACCESS_DISABLED' }))
  );
  assert.deepEqual(await service.getAccessStatus(TOKEN), { allowed: false, code: 'SUBI_ACCESS_DISABLED' });
});

void test('401 maps to auth error without leaking token', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(401, { error: 'Missing auth token' })));
  await assert.rejects(service.getAccessStatus(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError);
    assert.equal(error.code, 'managed_auth');
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

void test('403 maps to forbidden', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(403, { error: 'x' })));
  await assert.rejects(service.getModels(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_forbidden');
    return true;
  });
});

void test('503 unavailable code maps through', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(503, { allowed: false, code: 'SUBI_ACCESS_UNAVAILABLE' }))
  );
  await assert.rejects(service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_ACCESS_UNAVAILABLE');
    return true;
  });
});

void test('timeout maps to managed_timeout', async () => {
  const { service } = serviceWith(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('AbortError: aborted')));
      }),
    30
  );
  await assert.rejects(service.getAccessStatus(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_timeout');
    return true;
  });
});

void test('network failure maps safely', async () => {
  const { service } = serviceWith(() => Promise.reject(new TypeError('fetch failed')));
  await assert.rejects(service.getAccessStatus(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_network');
    assert.ok(!(error as Error).message.includes(TOKEN));
    return true;
  });
});

void test('malformed JSON maps to invalid response', async () => {
  const { service } = serviceWith(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad')) } as unknown as Response)
  );
  await assert.rejects(service.getAccessStatus(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_invalid_response');
    return true;
  });
});

void test('malformed access shape rejected', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(200, { allowed: 'yes' })));
  await assert.rejects(service.getAccessStatus(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_invalid_response');
    return true;
  });
});

void test('models safe response validated', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(
      jsonResponse(200, {
        allowed: true,
        source: 'individual',
        models: [
          {
            modelKey: 'mdl_1',
            displayName: 'Subi One',
            capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
            contextLength: 128000,
          },
        ],
      })
    )
  );
  const result = await service.getModels(TOKEN);
  assert.equal(result.models.length, 1);
  assert.ok(result.models[0]);
  assert.equal(result.source, 'individual');
  assert.equal(result.models[0].modelKey, 'mdl_1');
  assert.ok(!('upstreamModelId' in result.models[0]));
});

void test('model carrying upstreamModelId fails the whole response', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(
      jsonResponse(200, {
        allowed: true,
        models: [
          {
            modelKey: 'mdl_1',
            displayName: 'Subi One',
            capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: false },
            upstreamModelId: 'x-ai/grok',
          },
        ],
      })
    )
  );
  await assert.rejects(service.getModels(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_invalid_response');
    return true;
  });
});

void test('models blocked body surfaces disabled error', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { allowed: false, code: 'SUBI_ACCESS_DISABLED' }))
  );
  await assert.rejects(service.getModels(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_ACCESS_DISABLED');
    return true;
  });
});

void test('models empty list is valid', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(200, { allowed: true, models: [] })));
  assert.deepEqual(await service.getModels(TOKEN), { models: [] });
});

void test('monthly limit configured and zero accepted', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(200, {
      configured: true,
      monthlyTokenLimit: 100000,
      period: 'calendar_month',
      source: 'school',
    }))
  );
  assert.deepEqual(await service.getMonthlyLimit(TOKEN), {
    configured: true,
    monthlyTokenLimit: 100000,
    period: 'calendar_month',
    source: 'school',
  });
  const zero = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { configured: true, monthlyTokenLimit: 0, period: 'calendar_month' }))
  );
  assert.deepEqual(await zero.service.getMonthlyLimit(TOKEN), {
    configured: true,
    monthlyTokenLimit: 0,
    period: 'calendar_month',
  });
});

void test('monthly limit not-configured and malformed handled', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { configured: false, monthlyTokenLimit: null, period: 'calendar_month' }))
  );
  assert.deepEqual(await service.getMonthlyLimit(TOKEN), {
    configured: false,
    monthlyTokenLimit: null,
    period: 'calendar_month',
  });
  const bad = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { configured: true, monthlyTokenLimit: -5, period: 'calendar_month' }))
  );
  await assert.rejects(bad.service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_invalid_response');
    return true;
  });
});

void test('503 FX_UNAVAILABLE preserved with credit-setup copy', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(503, { quotaMode: 'individual_credits', code: 'FX_UNAVAILABLE' }))
  );
  await assert.rejects(service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'FX_UNAVAILABLE');
    assert.ok(error.message.includes('FX rate'));
    return true;
  });
});

void test('503 SUBI_NO_PAID_PERIOD preserved with preparing copy', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(503, { quotaMode: 'individual_credits', code: 'SUBI_NO_PAID_PERIOD' }))
  );
  await assert.rejects(service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_NO_PAID_PERIOD');
    assert.ok(error.message.includes('being prepared'));
    return true;
  });
});

void test('503 unknown code stays generic unavailable', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(503, { code: 'SOME_NEW_CODE' })));
  await assert.rejects(service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_ACCESS_UNAVAILABLE');
    return true;
  });
});

void test('403 ACCOUNT_TYPE_UNSUPPORTED preserved', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(403, { allowed: false, code: 'ACCOUNT_TYPE_UNSUPPORTED' }))
  );
  await assert.rejects(service.getMonthlyLimit(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'ACCOUNT_TYPE_UNSUPPORTED');
    return true;
  });
});

void test('403 SUBI_PLAN_EXPIRED preserved', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(403, { allowed: false, code: 'SUBI_PLAN_EXPIRED' }))
  );
  await assert.rejects(service.getUsage(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_PLAN_EXPIRED');
    return true;
  });
});

void test('empty token rejected before any fetch', async () => {
  let calls = 0;
  const { service } = serviceWith(() => {
    calls += 1;
    return Promise.resolve(jsonResponse(200, { allowed: true }));
  });
  await assert.rejects(service.getAccessStatus(''), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_auth');
    return true;
  });
  assert.equal(calls, 0);
});
