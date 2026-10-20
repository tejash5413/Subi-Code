const test = require('node:test');
const assert = require('node:assert/strict');
const { listCommerceOrders } = require('../src/services/subiCommerceHistoryService');
test('admin history is scoped, sorted, bounded and excludes payment sessions and buyer contacts', async () => {
  const queries = [];
  const rows = [{ id: 'old', uid: 'buyer', createdAtMs: 1, productType: 'subi_subscription', paymentSessionId: 'sensitive', buyer: { phone: 'private' } }, { id: 'new', uid: 'buyer', createdAtMs: 3, productType: 'subi_subscription', status: 'success', cycleGranted: true, education: {}, educationDelivered: false }, { id: 'foreign', uid: 'other', createdAtMs: 4 }];
  const store = { collection: name => { let q; const query = { where: (...args) => { q = args; queries.push([name, ...args]); return query; }, orderBy: () => query, limit: () => query, get: async () => ({ docs: (name === 'subiBillingOrders' ? rows : []).map(x => ({ id: x.id, data: () => x })) }) }; return query; } };
  const result = await listCommerceOrders({ uid: 'buyer', limit: 1 }, { store });
  assert.equal(result.length, 1);
  assert.equal(result[0].orderId, 'new');
  assert.equal(result[0].deliveryPending, true);
  assert.equal(result[0].paymentSessionId, undefined);
  assert.equal(result[0].buyer, undefined);
  assert.deepEqual(queries.map(q => q.slice(1)), [['uid', '==', 'buyer'], ['uid', '==', 'buyer']]);
});
