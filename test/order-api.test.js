import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.js';
import { createAuthTransport } from '../src/auth-transport.js';
import { StaffAuthError } from '../src/staff-auth.js';
import { staff, other, input, fakeDb } from '../test-support/order-drafts-db.js';

const staffAuth = { async authenticate(token) {
  if (token === 'alice') return { id: staff };
  if (token === 'bob') return { id: other };
  throw new StaffAuthError(401, 'UNAUTHENTICATED', '請先登入');
} };
async function withServer(options, work) {
  const pool = fakeDb();
  // Use the real OrderDraftStore constructed by createServer; only pg and auth are doubles.
  const server = createServer({ pool, staffAuth, authTransport: createAuthTransport({ mode: 'local-development', trustedProxyIps: '' }), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await work(`http://127.0.0.1:${server.address().port}`, pool); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function request(base, path, { method = 'GET', token, body, rawBody } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body || rawBody ? { 'content-type': 'application/json' } : {}) }, ...(rawBody ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
function payload() { const { staffId, ...body } = input(); return body; }
const create = (base, body = payload()) => request(base, '/api/v1/order-drafts', { method: 'POST', token: 'alice', body });

test('實驗性訂單草稿停用時拒絕，啟用後驗證登入、身份及讀取範圍', async () => {
  await withServer({ enableOrderDrafts: false }, async base => {
    assert.equal((await create(base)).status, 404);
  });
  await withServer({ enableOrderDrafts: true }, async (base, db) => {
    assert.equal((await request(base, '/api/v1/order-drafts', { method: 'POST', body: payload() })).status, 401);
    assert.equal((await create(base, { ...payload(), staffId: other })).status, 400);
    const created = await create(base);
    assert.equal(created.status, 200); assert.equal(created.body.data.staffId, staff);
    assert.equal(created.body.data.quote.total, '54000');
    assert.equal(db.rows.length, 1);
    const path = `/api/v1/order-drafts/${created.body.data.id}`;
    assert.equal((await request(base, path, { token: 'bob' })).status, 404);
    assert.deepEqual((await request(base, path, { token: 'alice' })).body.data, created.body.data);
    assert.equal((await request(base, path)).status, 401);
    assert.equal((await request(base, '/api/v1/order-drafts/invalid-id', { token: 'alice' })).status, 400);
  });
});

test('HTTP 建立、重試、版本衝突及資料庫回滾經過實際儲存層', async () => {
  await withServer({ enableOrderDrafts: true }, async (base, db) => {
    db.catalog.products[0].toppings[0].unit = '顆';
    const body = payload(); body.items[0].price = '1'; body.items[0].toppings[0].unit = '偽造';
    const created = await create(base, body);
    assert.equal(created.status, 200);
    assert.equal(created.body.data.quote.total, '54000');
    assert.equal(created.body.data.quote.items[0].toppings[0].unit, '顆');
    db.catalog.products[0].toppings[0].unit = '球'; db.current = 'new-release';
    assert.deepEqual((await create(base, body)).body.data, created.body.data);
    const read = await request(base, `/api/v1/order-drafts/${created.body.data.id}`, { token: 'alice' });
    assert.deepEqual(read.body.data, created.body.data);
    const changed = structuredClone(body); changed.items[0].quantity = 1;
    assert.equal((await create(base, changed)).body.error.code, 'IDEMPOTENCY_CONFLICT');
    const fresh = payload(); fresh.operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    assert.equal((await create(base, fresh)).body.error.code, 'MENU_RELEASE_CONFLICT');
    db.current = fresh.menuRelease; db.failInsert = true;
    assert.equal((await create(base, fresh)).status, 503);
    assert.equal(db.rows.length, 1); assert.ok(db.log.includes('ROLLBACK'));
  });
});

test('HTTP 拒絕深層 JSON 與不完整明細，回傳 400 而非 500', async () => {
  await withServer({ enableOrderDrafts: true }, async (base, db) => {
    const body = payload();
    const rawBody = JSON.stringify(body).replace('"quantity":2', `"quantity":2,"extra":${'['.repeat(10000)}null${']'.repeat(10000)}`);
    assert.ok(Buffer.byteLength(rawBody) < 65536);
    const deep = await request(base, '/api/v1/order-drafts', { method: 'POST', token: 'alice', rawBody });
    assert.equal(deep.status, 400); assert.equal(deep.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(db.log, []);
    const incomplete = payload(); delete incomplete.items[0].toppings;
    assert.equal((await create(base, incomplete)).status, 400);
    assert.equal(db.rows.length, 0);
  });
});

test('訂單草稿端點與其他管理 API 一樣要求受保護傳輸', async () => {
  await withServer({ enableOrderDrafts: true, authTransport: createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '' }) }, async base => {
    assert.equal((await create(base)).status, 403);
    assert.equal((await request(base, `/api/v1/order-drafts/${input().operationId}`, { token: 'alice' })).status, 403);
  });
});
