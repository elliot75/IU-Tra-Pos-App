import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeNote, quoteBody } from '../public/validation.js';
import { quoteOrder } from '../src/pricing.js';
import * as catalogValidation from '../public/catalog-validation.js';

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
    normalizeNote, quoteBody, ...catalogValidation, AbortController, setTimeout, clearTimeout,
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

test('店員可複製並獨立修改明細，過期編輯不會覆蓋新訂單', async () => {
  const elements = new Map(), requests = [];
  const get = key => {
    if (!elements.has(key)) elements.set(key, { value: '', dataset: {}, listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; }, showModal() {}, close() {},
      querySelector: get, querySelectorAll: () => [] });
    return elements.get(key);
  };
  const context = vm.createContext({ document: { querySelector: get, querySelectorAll: () => [] },
    DISPLAY_CHANNEL: 'display', DISPLAY_TIMEOUT: 1000, DISPLAY_HEARTBEAT: 1000, displayId: () => 'session', isDisplayId: () => true,
    normalizeNote, quoteBody, ...catalogValidation, AbortController, setTimeout, clearTimeout, setInterval() {},
    fetch: async (_path, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return { ok: true, json: async () => ({ data: { items: body.items.map(item => ({
        nameZh: '茶', variant: item.variantId, quantity: item.quantity, options: [],
        toppings: item.toppings.map(t => ({ ...t, nameZh: '珍珠' })), customerNote: item.customerNote,
        internalNote: item.internalNote, unitPrice: '24000', lineTotal: String(24000 * item.quantity)
      })), subtotal: '48000', total: '48000' } }) };
    }
  });
  vm.runInContext(`${source}\nglobalThis.testing = { state, openProduct };`, context);
  const { state } = context.testing;
  state.catalog = { release: 'release', products: [{ id: 'p', nameZh: '茶', nameVi: 'Trà',
    variants: [{ id: 'v', label: '大', price: '24000' }], toppings: [{ id: 'pearl', nameZh: '珍珠', unit: '份', price: '5000', maxPortions: 3 }],
    optionGroups: [{ id: 'ice', nameZh: '冰量', minSelect: 0, maxSelect: 1, values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít' }, { id: 'normal', nameZh: '正常', nameVi: 'Thường' }] }]
  }] };
  state.items = [{ productId: 'p', variantId: 'v', quantity: 2, toppings: [{ id: 'pearl', portions: 2 }], options: [{ groupId: 'ice', valueIds: ['less'] }], customerNote: '顧客', internalNote: '內部' }];
  const click = (selector, index) => get('#order-items').listeners.click({ target: { closest: query => query === selector ? { dataset: { [selector.slice(6, -1)]: String(index) } } : null } });
  click('[data-copy]', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.items.length, 2);
  assert.notEqual(state.items[0], state.items[1]);
  assert.notEqual(state.items[0].toppings[0], state.items[1].toppings[0]);
  assert.notEqual(state.items[0].options[0].valueIds, state.items[1].options[0].valueIds);
  assert.equal(requests.at(-1).items.length, 2);
  assert.match(get('#order-items').innerHTML, /data-edit="1"/);
  assert.match(get('#order-items').innerHTML, /data-copy="1"/);

  click('[data-edit]', 1);
  assert.equal(get('#quantity').textContent, '2');
  assert.equal(get('#customer-note').value, '顧客');
  assert.equal(get('#internal-note').value, '內部');
  assert.match(get('#option-groups').innerHTML, /value="less" checked/);
  assert.match(get('#toppings').innerHTML, /data-portions="0">2/);
  const dialog = get('#product-dialog');
  dialog.querySelector = selector => selector.startsWith('input[name=') ? { value: 'v' } : get(selector);
  dialog.querySelectorAll = () => [{ value: 'normal' }];
  state.quantity = 1; state.portions[0] = 1; get('#customer-note').value = '新備註';
  get('#product-form').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.items[0].quantity, 2);
  assert.equal(state.items[0].toppings[0].portions, 2);
  assert.equal(state.items[0].options[0].valueIds[0], 'less');
  assert.equal(state.items[1].quantity, 1);
  assert.equal(state.items[1].toppings[0].portions, 1);
  assert.equal(state.items[1].options[0].valueIds[0], 'normal');
  assert.equal(requests.at(-1).items[1].customerNote, '新備註');

  click('[data-edit]', 0);
  state.revision++; // A concurrent customer operation changed the order.
  get('#product-form').listeners.submit({ preventDefault() {} });
  assert.match(get('#product-error').textContent, /訂單已變更/);
  assert.equal(state.items[0].quantity, 2);
  assert.equal(requests.length, 2);
});

function editingHarness() {
  const elements = new Map(), requests = [], deadlines = new Map();
  let timerId = 0;
  const get = key => {
    if (!elements.has(key)) elements.set(key, {
      value: '', disabled: false, open: false, listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelector: get, querySelectorAll: () => []
    });
    return elements.get(key);
  };
  let channel;
  class Channel {
    constructor(name) { if (name === 'display') channel = this; this.sent = []; }
    postMessage(message) { this.sent.push(structuredClone(message)); }
  }
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => [] }, BroadcastChannel: Channel,
    DISPLAY_CHANNEL: 'display', DISPLAY_TIMEOUT: 10000, DISPLAY_HEARTBEAT: 1000,
    displayId: () => 'session', isDisplayId: () => true,
    normalizeNote, quoteBody, ...catalogValidation, AbortController, setInterval() {},
    setTimeout(fn) { const id = ++timerId; deadlines.set(id, fn); return id; },
    clearTimeout(id) { deadlines.delete(id); },
    fetch: (_path, options) => new Promise((resolve, reject) => {
      requests.push({ body: JSON.parse(options.body), signal: options.signal, resolve, reject });
    })
  });
  vm.runInContext(`${source}\nglobalThis.testing = { state, openProduct, showProducts, publicCatalog, showQuote, addCustomerItem, displayRevision: () => displayRevision };`, context);
  const { state, openProduct, showQuote } = context.testing;
  state.catalog = { release: 'release', categories: [], products: [{
    id: 'p', categoryId: 'tea', nameZh: '茶', nameVi: 'Trà',
    variants: [{ id: 'small', label: '500 ml', price: '22000' }, { id: 'large', label: '700 ml', price: '24000' }],
    toppings: [{ id: 'pearl', nameZh: '珍珠', nameVi: 'Trân châu', unit: '份', price: '5000', maxPortions: 3 }], optionGroups: []
  }] };
  const original = { productId: 'p', variantId: 'small', quantity: 1, toppings: [], options: [], customerNote: '原備註', internalNote: '原內部備註' };
  state.items = [original];
  showQuote(quoteOrder({ menuRelease: state.catalog.release, items: state.items }, state.catalog));
  openProduct('p', 0);
  const dialog = get('#product-dialog');
  const controls = [get('input[name="variant"]:checked'), get('#customer-note'), get('#internal-note'), get('.add-button'), get('.close'), get('#disabled-option')];
  get('#disabled-option').disabled = true;
  dialog.querySelectorAll = selector => selector === 'input, button' ? controls : [];
  get('input[name="variant"]:checked').value = 'large';
  state.quantity = 2; state.portions[0] = 1;
  get('#customer-note').value = '新備註'; get('#internal-note').value = '新內部備註';
  return {
    ...context.testing, get, requests, controls, channel, original, dialog,
    submit: () => get('#product-form').listeners.submit({ preventDefault() {} }),
    succeed(index) {
      const request = requests[index];
      const data = quoteOrder(request.body, state.catalog);
      request.resolve({ ok: true, json: async () => ({ data }) });
    },
    expire() {
      assert.equal(deadlines.size, 1);
      for (const fn of [...deadlines.values()]) fn();
    }
  };
}

for (const failure of ['server', 'network', 'timeout']) {
  test(`修改試算失敗保留原訂單與輸入，可直接重試：${failure}`, async () => {
    const env = editingHarness();
    const { state, get, original, requests, dialog, controls } = env;
    const before = get('#order-items').innerHTML, revision = state.revision;
    const pending = env.submit();
    assert.equal(state.items[0], original);
    assert.equal(state.revision, revision);
    assert.equal(dialog.open, true);
    assert.ok(controls.every(control => control.disabled));
    await env.submit();
    assert.equal(requests.length, 1, 'duplicate submission must not issue another quote');
    let cancelled = false;
    dialog.listeners.cancel({ preventDefault() { cancelled = true; } });
    assert.equal(cancelled, true, 'Escape must not dismiss an in-flight save');
    if (failure === 'server') requests[0].resolve({ ok: false, json: async () => ({ error: { message: '試算拒絕' } }) });
    else if (failure === 'network') requests[0].reject(new Error('網路中斷'));
    else env.expire();
    await pending;
    assert.equal(state.items[0], original);
    assert.equal(state.revision, revision);
    assert.equal(get('#order-items').innerHTML, before);
    assert.equal(get('#total').textContent, '22.000 ₫');
    assert.equal(get('#customer-note').value, '新備註');
    assert.equal(get('#internal-note').value, '新內部備註');
    assert.equal(state.quantity, 2); assert.equal(state.portions[0], 1);
    assert.equal(dialog.open, true); assert.equal(state.editing.saving, false);
    assert.ok(controls.slice(0, -1).every(control => !control.disabled));
    assert.equal(get('#disabled-option').disabled, true);
    assert.match(get('#product-error').textContent, /試算拒絕|網路中斷|逾時/);
    const retry = env.submit();
    env.succeed(1); await retry;
    assert.equal(state.items[0].variantId, 'large');
    assert.equal(state.items[0].quantity, 2);
    assert.equal(state.items[0].toppings[0].portions, 1);
    assert.equal(state.items[0].customerNote, '新備註');
    assert.equal(state.items[0].internalNote, '新內部備註');
    assert.equal(get('#total').textContent, '58.000 ₫');
    assert.equal(state.revision, revision + 1);
    assert.equal(dialog.open, false); assert.equal(state.editing, null);
    assert.equal(requests.length, 2, 'successful editing must reuse the quote');
    if (failure === 'timeout') {
      assert.equal(requests[0].signal.aborted, true);
      env.succeed(0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(state.revision, revision + 1);
      assert.equal(get('#total').textContent, '58.000 ₫');
    }
  });
}

test('修改試算期間顧客成功加單，晚到修改不得覆蓋訂單與客顯', async () => {
  const env = editingHarness();
  const { state, get, channel } = env;
  get('#display-mode').listeners.change({ target: { value: 'touch' } });
  channel.onmessage({ data: { type: 'request', pair: 'session', nonce: 'customer' } });
  const pending = env.submit();
  const customer = env.addCustomerItem({
    session: 'session', nonce: 'customer', operationId: 'customer-add', revision: env.displayRevision(),
    item: { ...env.original, internalNote: undefined }
  });
  env.succeed(1); await customer;
  assert.equal(state.items.length, 2);
  assert.equal(get('#total').textContent, '44.000 ₫');
  const revision = state.revision;
  const snapshots = channel.sent.length;
  env.succeed(0); await pending;
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0], env.original);
  assert.equal(state.revision, revision);
  assert.equal(channel.sent.length, snapshots, 'stale edit must not broadcast its quote');
  assert.equal(get('#total').textContent, '44.000 ₫');
  assert.match(get('#product-error').textContent, /訂單已變更/);
  assert.equal(env.dialog.open, true);
  await env.submit();
  assert.equal(env.requests.length, 2, 'stale editor must require reopening');
});

test('店員搜尋中越文商品，與分類及輸入法組合', () => {
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, { value: '', dataset: {}, listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; }, showModal() {}, close() {},
      querySelector: get, querySelectorAll: () => [] });
    return elements.get(key);
  };
  const context = vm.createContext({ document: { querySelector: get, querySelectorAll: () => [] },
    DISPLAY_CHANNEL: 'display', DISPLAY_TIMEOUT: 1000, DISPLAY_HEARTBEAT: 1000, displayId: () => 'session', isDisplayId: () => true,
    normalizeNote, quoteBody, ...catalogValidation, AbortController, setTimeout, clearTimeout, setInterval() {} });
  vm.runInContext(`${source}\nglobalThis.testing = { state, showCatalog };`, context);
  const { state, showCatalog } = context.testing;
  const product = (id, categoryId, nameZh, nameVi) => ({ id, categoryId, nameZh, nameVi,
    variants: [{ id: `${id}-v`, label: '杯', price: '22000' }], toppings: [] });
  const catalog = { release: 'r', categories: [{ id: 'tea', nameZh: '茶', nameVi: 'Trà' }, { id: 'milk', nameZh: '奶', nameVi: 'Sữa' }],
    products: [product('oolong', 'tea', '烏龍茶', 'Trà Ô Long'), product('peach', 'tea', '蜜桃茶', 'Trà Đào'), product('milk', 'milk', '奶茶', 'Trà Sữa')] };
  const search = get('#product-search');
  const input = (value, isComposing = false) => { search.value = value; search.listeners.input({ isComposing }); };
  const category = id => get('#categories').listeners.click({ target: { closest: () => ({ dataset: { category: id } }) } });
  const markup = () => get('#products').innerHTML;
  input('茶'); // Before the menu loads, typing must not replace the load/error message.
  showCatalog(catalog);
  assert.equal(search.disabled, false); assert.equal(search.value, '');
  assert.match(markup(), /烏龍茶/); assert.match(markup(), /蜜桃茶/); assert.match(markup(), /奶茶/);
  input('烏龍');
  assert.match(markup(), /烏龍茶/); assert.doesNotMatch(markup(), /蜜桃茶|奶茶/);
  input('  TRA DAO  ');
  assert.match(markup(), /蜜桃茶/); assert.doesNotMatch(markup(), /烏龍茶|奶茶/);
  input('trà');
  assert.match(markup(), /烏龍茶/); assert.match(markup(), /蜜桃茶/); assert.match(markup(), /奶茶/);
  category('milk');
  assert.match(markup(), /奶茶/); assert.doesNotMatch(markup(), /烏龍茶|蜜桃茶/);
  input('烏龍');
  assert.match(markup(), /找不到符合條件/);
  category('tea');
  assert.match(markup(), /烏龍茶/); assert.doesNotMatch(markup(), /蜜桃茶|奶茶/);
  input('');
  assert.match(markup(), /烏龍茶/); assert.match(markup(), /蜜桃茶/); assert.doesNotMatch(markup(), /奶茶/);
  input('奶', true);
  assert.match(markup(), /烏龍茶/, 'do not replace results during IME composition');
  search.listeners.compositionend();
  assert.match(markup(), /找不到符合條件/);
  category(undefined);
  assert.match(markup(), /奶茶/); assert.doesNotMatch(markup(), /烏龍茶|蜜桃茶/);
  showCatalog({ ...catalog, release: 'new' });
  assert.equal(search.value, '');
  assert.match(markup(), /烏龍茶/); assert.match(markup(), /奶茶/);
  assert.equal(state.items.length, 0);
});


test('店員隱藏停用項目、顯示不可選售罄商品與選項，最低價忽略停售規格', () => {
  const env = editingHarness(), product = env.state.catalog.products[0];
  product.variants.unshift({ id: 'inactive', label: '停用規格', price: '1', active: false });
  product.variants[1].soldOut = true;
  product.toppings.push({ ...product.toppings[0], id: 'hidden', nameZh: '隱藏配料', active: false });
  product.toppings[0].soldOut = true;
  env.state.catalog.products.push({ ...product, id: 'hidden-product', nameZh: '隱藏商品', active: false });
  env.state.catalog.products.push({ ...product, id: 'sold-product', nameZh: '售罄商品', soldOut: true });
  env.state.catalog.products.push({ ...product, id: 'no-variant', nameZh: '無規格商品', variants: [{ ...product.variants[0] }] });
  env.showProducts();
  const markup = env.get('#products').innerHTML;
  assert.doesNotMatch(markup, /隱藏商品/);
  assert.match(markup, /data-product="sold-product" disabled/);
  assert.match(markup, /data-product="no-variant" disabled/);
  assert.match(markup, /24\.000 ₫ 起/); assert.doesNotMatch(markup, /22\.000/);
  env.dialog.close(); env.openProduct('sold-product'); assert.equal(env.dialog.open, false);
  env.openProduct('p');
  assert.doesNotMatch(env.get('#variants').innerHTML, /停用規格/);
  assert.match(env.get('#variants').innerHTML, /value="small"[^>]*disabled/);
  assert.match(env.get('#variants').innerHTML, /value="large" checked/);
  assert.doesNotMatch(env.get('#toppings').innerHTML, /隱藏配料/);
  assert.match(env.get('#toppings').innerHTML, /售罄/);
  assert.match(env.get('#toppings').innerHTML, /disabled data-topping-index="0"/);
  env.get('#product-dialog').listeners.click({ target: { closest: () => ({ dataset: { toppingIndex: '0', change: '1' } }) } });
  assert.equal(env.state.portions[0], 0);
  const projected = env.publicCatalog();
  assert.equal(projected.products[0].variants[0].active, false);
  assert.equal(projected.products[0].toppings[0].soldOut, true);
  assert.equal(projected.products[1].active, false);
  assert.equal(projected.products[2].soldOut, true);
  assert.equal('excludedOptionGroupIds' in projected.products[0], false);
});
