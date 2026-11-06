import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeNote, quoteBody } from '../public/validation.js';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*\n/gm, '')
  .split("try { showCatalog(await request('/api/v1/catalog/published')); }")[0];

test('點餐預選預設選項、支援舊菜單並送出實際選擇供伺服器試算', async () => {
  const elements = new Map(), calls = [];
  const get = key => {
    if (!elements.has(key)) elements.set(key, { value: '', dataset: {}, listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; }, showModal() {}, close() {},
      querySelector: get, querySelectorAll: () => [] });
    return elements.get(key);
  };
  const context = vm.createContext({ document: { querySelector: get, querySelectorAll: () => [] },
    DISPLAY_CHANNEL: 'display', DISPLAY_TIMEOUT: 1000, DISPLAY_HEARTBEAT: 1000, displayId: () => 'session', isDisplayId: () => true,
    normalizeNote, quoteBody, AbortController, setTimeout, clearTimeout,
    setInterval() {}, fetch: async (path, options) => { calls.push({ path, options }); return { ok: true, json: async () => ({ data: { items: [], subtotal: '24000', total: '24000' } }) }; }
  });
  vm.runInContext(`${source}\nglobalThis.testing = { state, openProduct, showProducts, renderOrder };`, context);
  const group = { id: 'ice', nameZh: '冰量', minSelect: 1, maxSelect: 1, values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít' }, { id: 'normal', nameZh: '正常', nameVi: 'Thường' }], defaultValueIds: ['less'] };
  const product = { id: 'p', nameZh: '茶', nameVi: 'Tra', variants: [{ id: 'v', label: '700', price: '24000' }], toppings: [], optionGroups: [group] };
  context.testing.state.catalog = { products: [product], release: 'release' };
  context.testing.showProducts();
  assert.doesNotMatch(get('#products').innerHTML, /<img/);
  product.imageUrl = 'https://example.com/a.jpg?x=1&y=2';
  context.testing.showProducts();
  assert.match(get('#products').innerHTML, /src="https:\/\/example.com\/a.jpg\?x=1&amp;y=2"/);
  const failedImage = { tagName: 'IMG', hidden: false };
  get('#products').listeners.error({ target: failedImage });
  assert.equal(failedImage.hidden, true);
  context.testing.openProduct('p');
  assert.match(get('#option-groups').innerHTML, /type="radio" name="option-group-0" data-option-group="0" value="less" checked/);
  assert.doesNotMatch(get('#option-groups').innerHTML, /value="normal" checked/);
  const dialog = get('#product-dialog');
  dialog.querySelector = selector => selector.startsWith('input[name=') ? { value: 'v' } : get(selector);
  dialog.querySelectorAll = () => [{ value: 'normal' }];
  for (const field of ['#customer-note', '#internal-note']) {
    for (const invalid of ['bad\u007f', 'bad\nline', 'a'.repeat(201)]) {
      get('#customer-note').value = ''; get('#internal-note').value = '';
      get(field).value = invalid;
      get('#product-form').listeners.submit({ preventDefault() {} });
      assert.equal(context.testing.state.items.length, 0);
      assert.equal(calls.length, 0);
      assert.match(get('#product-error').textContent, /備註/);
    }
  }
  get('#customer-note').value = '少冰'; get('#internal-note').value = '製作提醒';
  get('#product-form').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.items[0].customerNote, '少冰'); assert.equal(sent.items[0].internalNote, '製作提醒');
  assert.deepEqual(sent.items[0].options, [{ groupId: 'ice', valueIds: ['normal'] }]);
  assert.equal(sent.items[0].price, undefined);
  delete group.defaultValueIds;
  context.testing.openProduct('p');
  assert.doesNotMatch(get('#option-groups').innerHTML, /checked/);

  // Each single-choice group has its own radio name. Optional singles can be cleared;
  // multi-choice groups continue to use checkboxes.
  product.optionGroups = [
    { ...group, id: 'sugar', nameZh: '甜度' },
    { ...group, id: 'ice', nameZh: '冰量', minSelect: 0, defaultValueIds: ['less'] },
    { ...group, id: 'extras', nameZh: '其他', minSelect: 0, maxSelect: 2 },
    { ...group, id: 'disabled', nameZh: '不提供', minSelect: 0, maxSelect: 0 }
  ];
  context.testing.openProduct('p');
  const markup = get('#option-groups').innerHTML;
  assert.equal((markup.match(/type="radio" name="option-group-0"/g) || []).length, 2);
  assert.equal((markup.match(/type="radio" name="option-group-1"/g) || []).length, 3);
  assert.match(markup, /name="option-group-1" value=""[^>]*> 不選/);
  assert.equal((markup.match(/type="checkbox"\s+data-option-group="2"/g) || []).length, 2);
  assert.equal((markup.match(/data-option-group="3"[^>]* disabled/g) || []).length, 2);

  // UTF-8 size is checked before changing the order or issuing a quote.
  product.optionGroups = []; dialog.querySelectorAll = () => [];
  const largeItem = { productId: 'p', variantId: 'v', quantity: 1, toppings: [], options: [], customerNote: '茶'.repeat(200), internalNote: '茶'.repeat(200) };
  const items = [];
  while (true) {
    try { quoteBody('release', [...items, largeItem]); items.push(structuredClone(largeItem)); }
    catch { break; }
  }
  context.testing.state.items = items;
  get('#customer-note').value = largeItem.customerNote; get('#internal-note').value = largeItem.internalNote;
  const before = calls.length, itemCount = items.length;
  get('#product-form').listeners.submit({ preventDefault() {} });
  assert.equal(context.testing.state.items.length, itemCount);
  assert.equal(calls.length, before);
  assert.match(get('#product-error').textContent, /大小上限/);

  // A server-side rejection still leaves individual removal controls available.
  context.fetch = async () => ({ ok: false, json: async () => ({ error: { message: '驗證失敗' } }) });
  context.testing.state.items = [structuredClone(largeItem), structuredClone(largeItem)];
  await context.testing.renderOrder();
  assert.match(get('#order-items').innerHTML, /data-remove="0"/);
  assert.match(get('#order-items').innerHTML, /data-remove="1"/);
  context.fetch = async () => ({ ok: true, json: async () => ({ data: { items: [], subtotal: '24000', total: '24000' } }) });
  get('#order-items').listeners.click({ target: { closest: selector => selector === '[data-remove]' ? { dataset: { remove: '1' } } : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.testing.state.items.length, 1);
  assert.equal(get('#order-error').textContent, '');
});
