import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderDraftStore } from '../src/order-drafts.js';
import { catalog as example } from '../src/catalog.js';
import { ValidationError } from '../src/pricing.js';
import { staff, other, input, fakeDb } from '../test-support/order-drafts-db.js';

test('server quote preserves original topping unit and price, scoped to owner', async () => {
  const db = fakeDb(); const store = new OrderDraftStore(db); const request = input();
  db.catalog.products[0].toppings[0].unit = '顆';
  request.items[0].price = '1'; request.items[0].toppings[0].price = '0'; request.items[0].toppings[0].unit = '偽造';
  const created = await store.create(request);
  assert.equal(created.status, 'development_draft');
  assert.equal(created.quote.currency, 'VND');
  assert.equal(created.quote.items[0].unitPrice, '27000');
  assert.equal(created.quote.total, '54000');
  assert.equal(created.quote.items[0].toppings[0].unit, '顆');
  db.catalog.products[0].variants[0].price = '1';
  db.catalog.products[0].toppings[0].unit = '球';
  assert.deepEqual(await store.get({ staffId: staff, id: created.id }), created);
  await assert.rejects(store.get({ staffId: other, id: created.id }), { status: 404, code: 'NOT_FOUND' });
  assert.ok(db.log.some(sql => sql.includes('FOR SHARE OF s')));
});

test('same complete input returns same result even after release changes; changed input conflicts', async () => {
  const db = fakeDb(); const store = new OrderDraftStore(db); const first = input();
  const created = await store.create(first);
  db.current = 'another-release';
  assert.deepEqual(await store.create(structuredClone(first)), created);
  const changed = input(); changed.items[0].price = '1';
  await assert.rejects(store.create(changed), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(db.rows.length, 1);
  assert.ok(db.log.includes('ROLLBACK'));
});

test('failed pricing and database insert roll back', async () => {
  const db = fakeDb(); const store = new OrderDraftStore(db);
  const bad = input(); bad.items[0].quantity = 0;
  await assert.rejects(store.create(bad), ValidationError);
  db.failInsert = true;
  await assert.rejects(store.create(input()), { status: 503, code: 'SERVICE_UNAVAILABLE' });
  assert.equal(db.rows.length, 0);
  assert.equal(db.log.filter(sql => sql === 'ROLLBACK').length, 2);
});

test('unknown, stale, and example releases cannot create drafts', async () => {
  for (const scenario of ['unknown', 'stale', 'example']) {
    const db = fakeDb(); const request = input();
    if (scenario === 'unknown') request.menuRelease = 'unknown';
    if (scenario === 'stale') db.current = 'new-release';
    if (scenario === 'example') { db.current = 'example-v1'; db.catalog = example; request.menuRelease = 'example-v1'; }
    await assert.rejects(new OrderDraftStore(db).create(request), { status: 409, code: 'MENU_RELEASE_CONFLICT' });
    assert.equal(db.rows.length, 0);
    assert.ok(db.log.includes('ROLLBACK'));
  }
});

test('unique conflict path returns winning row or rejects different concurrent input', async () => {
  for (const same of [true, false]) {
    const db = fakeDb();
    db.raceRow = params => ({ id: '55555555-5555-4555-8555-555555555555', staff_id: params[1], operation_id: params[2], request: same ? JSON.parse(params[4]) : { ...JSON.parse(params[4]), items: [] }, quote: JSON.parse(params[5]), created_at: '2026-01-01T00:00:00.000Z' });
    const promise = new OrderDraftStore(db).create(input());
    if (same) assert.equal((await promise).id, '55555555-5555-4555-8555-555555555555');
    else await assert.rejects(promise, { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    assert.ok(db.log.some(sql => sql.includes('ON CONFLICT (staff_id, operation_id) DO NOTHING')));
    assert.equal(db.rows.length, 1);
  }
});

test('validates identifiers and rejects non-JSON input', async () => {
  const store = new OrderDraftStore(fakeDb());
  await assert.rejects(store.create({ ...input(), operationId: 'invalid' }), ValidationError);
  const bad = input(); bad.items[0].extra = undefined;
  await assert.rejects(store.create(bad), ValidationError);
  await assert.rejects(store.get({ staffId: staff, id: 'invalid' }), ValidationError);
});

test('rejects deeply nested input before opening a transaction, while normal metadata remains comparable', async () => {
  const db = fakeDb(); const store = new OrderDraftStore(db);
  const bad = input(); let nested = null;
  for (let i = 0; i < 10000; i++) nested = [nested];
  bad.items[0].extra = nested;
  await assert.rejects(store.create(bad), error => error instanceof ValidationError && /巢狀/.test(error.message));
  await assert.rejects(store.create({ ...input(), items: [nested] }), ValidationError);
  assert.deepEqual(db.log, []);
  const valid = input(); valid.items[0].extra = { note: ['test'] };
  const created = await store.create(valid);
  assert.deepEqual(await store.create(valid), created);
});
