import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { catalog } from '../src/catalog.js';
import { validateCatalog } from '../src/catalog-validation.js';
import { CatalogStore } from '../src/catalog-store.js';
import { createServer } from '../src/server.js';
import { createAuthTransport } from '../src/auth-transport.js';

const example = () => structuredClone({ categories: catalog.categories, products: catalog.products });
const clone = obj => structuredClone(obj);

test('驗證分類、商品、規格、配料及金額', () => {
  assert.doesNotThrow(() => validateCatalog(example(), { publishing: true }));
  const cases = [
    x => x.products[0].categoryId = 'missing',
    x => x.categories.push(clone(x.categories[0])),
    x => x.products.push(clone(x.products[0])),
    x => x.products[0].variants.push(clone(x.products[0].variants[0])),
    x => x.products[0].toppings.push(clone(x.products[0].toppings[0])),
    x => x.products[0].nameZh = ' ',
    x => x.products[0].variants[0].price = 22000,
    x => x.products[0].variants[0].price = '01',
    x => x.products[0].variants[0].price = '1000000000001',
    x => x.products[0].variants[0].price = '-1',
    x => x.products[0].toppings[0].maxPortions = 101,
    x => x.products[0].variants = [],
    x => x.products[0].unexpected = true,
    x => x.categories[0].id = 'a b',
    x => x.products[0].nameVi = 'a'.repeat(101)
  ];
  for (const change of cases) { const data = example(); change(data); assert.throws(() => validateCatalog(data)); }
  assert.doesNotThrow(() => validateCatalog({ categories: [], products: [] }));
  assert.throws(() => validateCatalog({ categories: [], products: [] }, { publishing: true }));
});

test('商品選項群組驗證名稱、識別碼及選擇數限制', () => {
  const group = { id: 'ice', nameZh: '冰量', nameVi: 'Đá', minSelect: 1, maxSelect: 1, values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít đá' }] };
  const data = example(); data.products[0].optionGroups = [group];
  assert.doesNotThrow(() => validateCatalog(data, { publishing: true }));
  const cases = [
    x => x.products[0].optionGroups = null,
    x => x.products[0].optionGroups = Array(51).fill(group),
    x => x.products[0].optionGroups.push(clone(group)),
    x => x.products[0].optionGroups[0].id = 'bad id',
    x => x.products[0].optionGroups[0].nameVi = ' ',
    x => x.products[0].optionGroups[0].values = [],
    x => x.products[0].optionGroups[0].values.push(clone(group.values[0])),
    x => x.products[0].optionGroups[0].values[0].id = 'bad id',
    x => x.products[0].optionGroups[0].values[0].nameZh = '',
    x => x.products[0].optionGroups[0].values = Array(51).fill(group.values[0]),
    x => x.products[0].optionGroups[0].minSelect = -1,
    x => x.products[0].optionGroups[0].minSelect = 0.5,
    x => x.products[0].optionGroups[0].minSelect = 2,
    x => x.products[0].optionGroups[0].maxSelect = 2,
    x => x.products[0].optionGroups[0].maxSelect = 0,
    x => x.products[0].optionGroups[0].values[0].price = '1'
  ];
  for (const change of cases) { const invalid = clone(data); change(invalid); assert.throws(() => validateCatalog(invalid)); }
});

// 模擬 pg 回傳值，檢查 API 與交易協定；此測試不連線任何資料庫。
function fakePool() {
  let revision = 0, current = null, draft = { categories: [], products: [] };
  const releases = new Map(), calls = [];
  async function query(sql, params = []) {
    calls.push([sql, params]);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.startsWith('SELECT revision, catalog')) return { rows: [{ revision: String(revision), catalog: clone(draft) }] };
    if (sql.startsWith('SELECT r.catalog')) return { rows: [{ catalog: current ? clone(releases.get(current)) : null }] };
    if (sql.startsWith('UPDATE iutra_pos.catalog_state SET catalog')) {
      if (Number(params[2]) !== revision) return { rows: [] };
      draft = JSON.parse(params[0]); revision++; return { rows: [{ revision: String(revision), catalog: clone(draft) }] };
    }
    if (sql.startsWith('SELECT 1 FROM')) return { rows: [{ '?column?': 1 }] };
    if (sql.startsWith('INSERT INTO iutra_pos.catalog_releases')) { releases.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    if (sql.startsWith('UPDATE iutra_pos.catalog_state SET current_release')) { current = params[0]; return { rows: [] }; }
    throw Error('unexpected query');
  }
  return { calls, releases, query, async connect() { return { query, release() {} }; } };
}
async function withServer(options, fn) {
  const server = createServer({ ...options, authTransport: createAuthTransport({ mode: 'local-development', trustedProxyIps: '' }) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function request(base, path, method = 'GET', payload, token) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, body: await response.json(), requestId: response.headers.get('x-request-id') };
}

test('未登入或資料庫不可用時安全失敗，示範試算仍可使用', async () => {
  await withServer({}, async url => {
    assert.equal((await request(url, '/api/v1/admin/catalog')).status, 401);
    assert.equal((await request(url, '/api/v1/catalog/published')).status, 503);
    const result = await request(url, '/api/v1/quotes', 'POST', { menuRelease: 'example-v1', items: [{ productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], price: '1' }] });
    assert.equal(result.body.data.total, '22000'); assert.equal(result.body.request_id, result.requestId);
  });
  await withServer({}, async url => {
    assert.equal((await request(url, '/api/v1/admin/catalog')).status, 401);
    assert.equal((await request(url, '/api/v1/admin/catalog', 'GET', undefined, 'bad')).status, 401);
    assert.equal((await request(url, '/api/v1/admin/catalog', 'GET', undefined, 'a'.repeat(43))).status, 503);
  });
});

test('草稿樂觀鎖、發布快照及當前版本試算', async () => {
  const pool = fakePool();
  const staffAuth = { async authenticate(token) { assert.equal(token, 'secret'); return { id: 'manager', canManageCatalog: true }; } };
  await withServer({ pool, staffAuth }, async url => {
    const admin = '/api/v1/admin/catalog';
    assert.equal((await request(url, '/api/v1/catalog/published')).status, 404);
    assert.deepEqual((await request(url, admin, 'GET', undefined, 'secret')).body.data, { revision: 0, catalog: { categories: [], products: [] } });
    assert.equal((await request(url, admin + '/publish', 'POST', { expectedRevision: 0 }, 'secret')).status, 400);
    const saved = await request(url, admin, 'PUT', { expectedRevision: 0, catalog: example() }, 'secret');
    assert.equal(saved.status, 200); assert.equal(saved.body.data.revision, 1);
    assert.equal((await request(url, admin, 'PUT', { expectedRevision: 0, catalog: example() }, 'secret')).status, 409);
    assert.equal((await request(url, admin + '/publish', 'POST', { expectedRevision: 0 }, 'secret')).status, 409);
    const first = (await request(url, admin + '/publish', 'POST', { expectedRevision: 1 }, 'secret')).body.data;
    assert.match(first.release, /^release-/); assert.equal(first.isExample, false);
    const changed = example(); changed.products[0].variants[0].price = '33000';
    await request(url, admin, 'PUT', { expectedRevision: 1, catalog: changed }, 'secret');
    assert.equal((await request(url, '/api/v1/catalog/published')).body.data.products[0].variants[0].price, '22000');
    const second = (await request(url, admin + '/publish', 'POST', { expectedRevision: 2 }, 'secret')).body.data;
    assert.notEqual(first.release, second.release);
    const item = { productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], price: '1' };
    assert.equal((await request(url, '/api/v1/quotes', 'POST', { menuRelease: first.release, items: [item] })).status, 400);
    assert.equal((await request(url, '/api/v1/quotes', 'POST', { menuRelease: second.release, items: [item] })).body.data.total, '33000');
    assert.equal(pool.releases.get(first.release).products[0].variants[0].price, '22000');
    assert.ok(pool.calls.some(([sql]) => sql.includes('FOR UPDATE')));
    assert.ok(pool.calls.some(([sql]) => sql === 'ROLLBACK'));
  });
});

test('資料庫錯誤與缺少初始化列不洩漏連線資訊', async () => {
  const broken = { async query() { throw new Error('secret connection string'); }, async connect() { throw new Error('secret connection string'); } };
  const store = new CatalogStore(broken);
  await assert.rejects(store.getDraft(), error => error.status === 503 && !error.message.includes('secret'));
  await assert.rejects(store.update(0, example()), error => error.status === 503 && !error.message.includes('secret'));
  const empty = new CatalogStore({ async query() { return { rows: [] }; } });
  await assert.rejects(empty.getPublished(), error => error.status === 503);
});
