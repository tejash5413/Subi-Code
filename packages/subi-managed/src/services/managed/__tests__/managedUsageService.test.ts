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

function fullUsage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed: true,
    usage: {
      configured: true,
      period: '2026-09',
      monthlyTokenLimit: 1500000,
      usedTokens: 26823,
      remainingTokens: 1473177,
    },
    chatAvailable: true,
    ...over,
  };
}

void test('usage allowed response parsed with capability, Bearer auth, usage endpoint', async () => {
  const { service, seen } = serviceWith(() => Promise.resolve(jsonResponse(200, fullUsage())));
  const result = await service.getUsage(TOKEN);
  assert.deepEqual(result, {
    allowed: true,
    usage: {
      configured: true,
      period: '2026-09',
      monthlyTokenLimit: 1500000,
      usedTokens: 26823,
      remainingTokens: 1473177,
    },
    chatAvailable: true,
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]);
  assert.ok(seen[0].url.endsWith('/managed/usage'));
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${TOKEN}`);
  assert.ok(!seen[0].url.includes('uid='));
});

void test('usage chatAvailable false passes through', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(200, fullUsage({ chatAvailable: false }))));
  const result = await service.getUsage(TOKEN);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.equal(result.chatAvailable, false);
    assert.equal(result.usage.usedTokens, 26823);
  } else {
    assert.fail('expected allowed');
  }
});

void test('usage missing chatAvailable fails closed to false', async () => {
  const body = fullUsage();
  delete body['chatAvailable'];
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(200, body)));
  const result = await service.getUsage(TOKEN);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.equal(result.chatAvailable, false);
  } else {
    assert.fail('expected allowed');
  }
});

void test('usage denied response returns safely without quota details', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(jsonResponse(200, { allowed: false, code: 'SUBI_ACCESS_DISABLED', chatAvailable: false }))
  );
  const result = await service.getUsage(TOKEN);
  assert.deepEqual(result, { allowed: false, code: 'SUBI_ACCESS_DISABLED', chatAvailable: false });
});

void test('usage 401 maps to auth error without leaking token', async () => {
  const { service } = serviceWith(() => Promise.resolve(jsonResponse(401, { error: 'Missing auth token' })));
  await assert.rejects(service.getUsage(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'managed_auth');
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

void test('usage 503/500 map safely', async () => {
  const unavailable = serviceWith(() => Promise.resolve(jsonResponse(503, { allowed: false, code: 'X' })));
  await assert.rejects(unavailable.service.getUsage(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError && error.code === 'SUBI_ACCESS_UNAVAILABLE');
    return true;
  });
  const broken = serviceWith(() => Promise.resolve(jsonResponse(500, {})));
  await assert.rejects(broken.service.getUsage(TOKEN), (error: unknown) => {
    assert.ok(error instanceof ManagedError);
    return true;
  });
});

void test('usage malformed fields rejected fail-closed', async () => {
  const cases: Record<string, unknown>[] = [
    fullUsage({ usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100, usedTokens: -1, remainingTokens: 5 } }),
    fullUsage({ usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100, usedTokens: 1.5, remainingTokens: 5 } }),
    fullUsage({ usage: { configured: true, period: 'Sep 2026', monthlyTokenLimit: 100, usedTokens: 1, remainingTokens: 5 } }),
    fullUsage({ usage: { configured: true, period: '2026-09', monthlyTokenLimit: -1, usedTokens: 1, remainingTokens: 5 } }),
    fullUsage({ usage: { configured: false, period: '2026-09', monthlyTokenLimit: 100, usedTokens: 1, remainingTokens: null } }),
    { allowed: 'yes', usage: {}, chatAvailable: true },
    { allowed: true, usage: null, chatAvailable: true },
  ];
  for (const body of cases) {
    const { service } = serviceWith(() => Promise.resolve(jsonResponse(200, body)));
    await assert.rejects(service.getUsage(TOKEN), (error: unknown) => {
      assert.ok(error instanceof ManagedError && error.code === 'managed_invalid_response');
      return true;
    });
  }
});

void test('usage zero and unconfigured accepted', async () => {
  const zero = serviceWith(() =>
    Promise.resolve(
      jsonResponse(200, {
        allowed: true,
        usage: { configured: true, period: '2026-09', monthlyTokenLimit: 0, usedTokens: 0, remainingTokens: 0 },
        chatAvailable: true,
      })
    )
  );
  assert.deepEqual(await zero.service.getUsage(TOKEN), {
    allowed: true,
    usage: { configured: true, period: '2026-09', monthlyTokenLimit: 0, usedTokens: 0, remainingTokens: 0 },
    chatAvailable: true,
  });
  const unconfigured = serviceWith(() =>
    Promise.resolve(
      jsonResponse(200, {
        allowed: true,
        usage: { configured: false, period: '2026-09', monthlyTokenLimit: null, usedTokens: 900, remainingTokens: null },
        chatAvailable: false,
      })
    )
  );
  assert.deepEqual(await unconfigured.service.getUsage(TOKEN), {
    allowed: true,
    usage: { configured: false, period: '2026-09', monthlyTokenLimit: null, usedTokens: 900, remainingTokens: null },
    chatAvailable: false,
  });
});

void test('usage unknown fields are dropped, never projected', async () => {
  const { service } = serviceWith(() =>
    Promise.resolve(
      jsonResponse(
        200,
        fullUsage({
          uid: 'u1',
          mode: 'test',
          testUids: ['u1'],
          usage: {
            configured: true,
            period: '2026-09',
            monthlyTokenLimit: 100,
            usedTokens: 10,
            remainingTokens: 90,
            upstreamModelId: 'x',
            reservations: { r1: {} },
          },
        })
      )
    )
  );
  const result = await service.getUsage(TOKEN);
  assert.deepEqual(result, {
    allowed: true,
    usage: { configured: true, period: '2026-09', monthlyTokenLimit: 100, usedTokens: 10, remainingTokens: 90 },
    chatAvailable: true,
  });
  assert.ok(!JSON.stringify(result).includes('upstreamModelId'));
  assert.ok(!JSON.stringify(result).includes('testUids'));
});
