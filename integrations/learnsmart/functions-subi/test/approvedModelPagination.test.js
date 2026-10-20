const test = require('node:test');
const assert = require('node:assert/strict');
const approved = require('../src/services/approvedModelService');

function registry(size) {
  const docs = Array.from({ length: size }, (_, i) => ({
    id: `mdl_${String(i).padStart(4, '0')}`,
    data: () => ({ displayName: `Model ${i}`, enabled: i % 3 !== 0,
      roles: { student: { enabled: true }, teacher: { enabled: false } },
      capabilities: { toolCalling: i % 5 !== 0, inputModalities: ['text'], outputModalities: ['text'] },
      upstreamModelId: `private/${i}`, pricing: { input: '1', output: '2' },
    }),
  }));
  const query = (limit, after = '') => ({
    get: async () => ({ docs: docs.filter(doc => doc.id > after).slice(0, limit) }),
    startAfter: doc => query(limit, doc.id),
  });
  return { docs, store: { collection: () => ({ limit: n => query(n) }) } };
}

test('individual registry includes every eligible model beyond the first 200 documents', async () => {
  const { docs, store } = registry(651);
  const expected = docs.filter(doc => doc.data().enabled && doc.data().capabilities.toolCalling).map(doc => doc.id);
  const result = await approved.listIndividualCreditModels({ store });
  assert.deepEqual(result.map(model => model.modelKey), expected);
  assert.ok(result.every(model => !('upstreamModelId' in model) && !('pricing' in model)));
});

test('admin registry does not hide models after the first page', async () => {
  const { docs, store } = registry(400);
  assert.deepEqual((await approved.listApprovedModelsAdmin({ store })).map(model => model.modelKey), docs.map(doc => doc.id));
});

test('role-filtered fallback traverses the registry without weakening role filters', async () => {
  const { docs, store } = registry(450);
  assert.deepEqual((await approved.listEligibleManagedModels('student', { store })).map(model => model.modelKey), docs.filter(doc => doc.data().enabled).map(doc => doc.id));
  assert.deepEqual(await approved.listEligibleManagedModels('teacher', { store }), []);
});
