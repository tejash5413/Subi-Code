const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { orderingStore } = require('./orderingTx');
const models = require('../src/services/approvedModelService');
const catalog = require('../src/services/modelCatalogService');
const { managedCatalogRouter } = require('../src/routes/managedCatalog');

test('auto-register handles more than 100 eligible models and preserves disabled/certified existing records', async () => {
  const db = orderingStore({ 'approvedModels/mdl_existing': { upstreamModelId: 'vendor/existing', enabled: false,
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true, agentTerminal: 'verified', agentVerify: 'verified' } } });
  const base = db.collection;
  db.collection = name => ({ ...base(name), limit(n) { return { async get() { return { docs: Object.entries(db.state)
    .filter(([key]) => key.startsWith(name + '/') && !key.slice(name.length + 1).includes('/')).slice(0, n)
    .map(([key, value]) => ({ id: key.slice(name.length + 1), data: () => value })) }; } }; } });
  const live = Array.from({ length: 151 }, (_, i) => ({ upstreamModelId: `vendor/model-${i}`, name: `Model ${i}`, pricing: { input: '0', output: '0' },
    capabilities: { inputModalities: ['text'], outputModalities: ['text'], toolCalling: true }, contextLength: 32000 }));
  live.push({ ...live[0], upstreamModelId: 'vendor/existing' });
  const saved = { fetch: catalog.fetchCatalog, resolve: models.resolveExistingUpstreamKeys, ensure: models.ensureCatalogueModels };
  const batchSizes = []; let sequence = 0;
  catalog.fetchCatalog = async () => ({ models: live });
  models.resolveExistingUpstreamKeys = ids => saved.resolve(ids, { store: db });
  models.ensureCatalogueModels = (selections, options) => {
    batchSizes.push(selections.length);
    return saved.ensure(selections, { ...options, store: db, ids: () => `mdl_${++sequence}`, audits: { logAudit: async () => {} } });
  };
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.subi = { uid: 'test-admin' }; next(); }); app.use(managedCatalogRouter());
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const invoke = () => fetch(`http://127.0.0.1:${server.address().port}/admin/models/auto-register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const first = await invoke(); const body = await first.json();
    assert.equal(first.status, 200, JSON.stringify(body));
    assert.equal(body.created.length, 151);
    assert.ok(batchSizes.length >= 2 && batchSizes.every(size => size <= 100));
    assert.equal(db.state['approvedModels/mdl_existing'].enabled, false);
    assert.equal(db.state['approvedModels/mdl_existing'].capabilities.agentTerminal, 'verified');
    for (const key of body.created) {
      assert.notEqual(db.state[`approvedModels/${key}`].capabilities.agentTerminal, 'verified');
      assert.notEqual(db.state[`approvedModels/${key}`].capabilities.agentVerify, 'verified');
    }
    const second = await invoke(); const retried = await second.json();
    assert.equal(second.status, 200);
    assert.equal(retried.created.length, 0, 'retry must not duplicate records');
    assert.equal(Object.keys(db.state).filter(key => /^approvedModels\/[^/]+$/.test(key)).length, 152);
  } finally {
    server.closeAllConnections(); server.close(); catalog.fetchCatalog = saved.fetch; models.resolveExistingUpstreamKeys = saved.resolve; models.ensureCatalogueModels = saved.ensure;
  }
});
