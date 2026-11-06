import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MAX_REQUEST_BYTES, quoteBody, normalizeNote, ValidationError } from '../public/validation.js';
import { createServer } from '../src/server.js';
import { catalog } from '../src/catalog.js';

const item = () => ({ productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], customerNote: '', internalNote: '' });

test('前端 UTF-8 大小檢查與 HTTP 上限一致，邊界內試算成功，超界回傳 400', async () => {
  const line = item();
  const base = quoteBody(catalog.release, [line]);
  // Padding is valid JSON metadata, ignored by pricing; it isolates the byte limit.
  const padding = MAX_REQUEST_BYTES - Buffer.byteLength(base) - ',"padding":""'.length;
  const input = { menuRelease: catalog.release, items: [line], padding: 'a'.repeat(padding) };
  const exact = JSON.stringify(input);
  assert.equal(Buffer.byteLength(exact), MAX_REQUEST_BYTES);
  const server = createServer({ pool: null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/quotes`;
    assert.equal((await fetch(url, { method: 'POST', body: exact })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, padding: input.padding + 'a' }) })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  line.customerNote = '茶'.repeat(200); line.internalNote = '茶'.repeat(200);
  const large = Array.from({ length: 60 }, () => line);
  assert.throws(() => quoteBody(catalog.release, large), ValidationError);
  assert.doesNotThrow(() => quoteBody(catalog.release, large.slice(0, 40)));
});

test('單行備註在所有呼叫端共用長度與控制字元規則', () => {
  assert.equal(normalizeNote(), '');
  assert.equal(normalizeNote(' 少冰 '), '少冰');
  for (const value of [null, 1, 'a'.repeat(201), 'bad\u007f', 'bad\nline', 'bad\u0000']) assert.throws(() => normalizeNote(value), ValidationError);
});
