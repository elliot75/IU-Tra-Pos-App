import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as protocol from '../public/display-protocol.js';
import { catalog } from '../src/catalog.js';
import * as validation from '../public/validation.js';
import * as catalogValidation from '../public/catalog-validation.js';
import { quoteOrder } from '../src/pricing.js';

const root = new URL('../public/', import.meta.url);
const { DISPLAY_CHANNEL, DISPLAY_TIMEOUT, DISPLAY_HEARTBEAT, displayPairFromHash, isDisplayId } = protocol;

// Bridge browser ESM imports to the real shared modules, keeping DOM isolation.
async function load(env, file, expose = '') {
  const source = await readFile(new URL(file, root), 'utf8');
  const modules = { 'display-protocol': protocol, validation, 'catalog-validation': catalogValidation };
  env.context.modules = modules;
  const imported = [];
  const script = source.replace(/^import \{ ([\w, ]+) \} from '\.\/([\w-]+)\.js';$/gm, (_, names, module) => {
    imported.push(module);
    for (const name of names.split(',').map(name => name.trim())) assert.ok(name in modules[module]);
    return `const { ${names} } = globalThis.modules['${module}'];`;
  });
  assert.ok(imported.includes('display-protocol'), 'each page imports the shared protocol');
  await vm.runInContext(`(async () => { ${script}\n${expose} })()`, env.context);
}

function bus() {
  const channels = []; const queue = [];
  return {
    channels,
    connect(channel) { channels.push(channel); },
    send(sender, message) {
      for (const receiver of channels) {
        if (receiver !== sender && receiver.active && receiver.name === sender.name) queue.push([receiver, structuredClone(message)]);
      }
    },
    flush() {
      let count = 0;
      while (queue.length) {
        assert.ok(++count < 1000, 'message loop must settle');
        const [receiver, data] = queue.shift();
        if (receiver.active) receiver.onmessage?.({ data });
      }
    }
  };
}

function setup({ hash = '', transport } = {}) {
  const elements = new Map();
  let mutations = 0;
  function node() {
    let text = ''; let hidden = false;
    return {
      get textContent() { return text; }, set textContent(value) { text = value; mutations++; },
      get hidden() { return hidden; }, set hidden(value) { hidden = value; mutations++; },
      innerHTML: '', value: '', open: false, dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren(...children) { this.children = children; mutations++; },
      append(...children) { this.children.push(...children); mutations++; },
      querySelector: get, querySelectorAll() { return []; }
    };
  }
  function get(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }
  let now = 10000; const timers = []; const channels = []; const listeners = {};
  const deadlines = new Map(); let timerId = 0;
  class Channel {
    constructor(name) { this.name = name; this.sent = []; this.active = true; channels.push(this); transport?.connect(this); }
    postMessage(message) { this.sent.push(structuredClone(message)); transport?.send(this, message); }
    close() { this.active = false; }
  }
  const document = { querySelector: get, getElementById: get, createElement: node, addEventListener(type, fn) { listeners[type] = fn; }, hidden: false };
  const context = vm.createContext({
    document, location: { hash }, BroadcastChannel: Channel, displayProtocol: protocol,
    Date: { now: () => now }, setInterval: (fn, delay) => { assert.equal(delay, DISPLAY_HEARTBEAT); timers.push(fn); },
    setTimeout(fn, delay) { const id = ++timerId; deadlines.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { deadlines.delete(id); }, AbortController, URL,
    Intl, BigInt, console,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: {} }) })
  });
  return { context, get, timers, channels, listeners, mutations: () => mutations, advance(ms) {
    now += ms;
    for (const [id, deadline] of deadlines) if (deadline.at <= now) { deadlines.delete(id); deadline.fn(); }
  } };
}

async function main(transport) {
  const env = setup({ transport });
  await load(env, 'app.js', 'globalThis.testing = { state, renderOrder, operationCount: () => customerOperations.size };');
  env.pair = displayPairFromHash(new URL(env.get('#open-display').href, 'http://localhost').hash);
  assert.ok(isDisplayId(env.pair));
  return env;
}
async function display(pair, transport) {
  const env = setup({ hash: `#pair=${pair}`, transport });
  await load(env, 'display.js');
  return env;
}
function orderFor(env, extra = {}) {
  const request = env.channels[0].sent.findLast(message => message.type === 'request');
  return { type: 'snapshot', pair: request.pair, nonce: request.nonce, session: request.pair, revision: 2, phase: 'order', items: [{ name: '<茶>', variant: '500 ml', quantity: 1, options: [], toppings: [] }], total: '22000', ...extra };
}

const quote = total => ({ items: [{ nameZh: '茶', variant: '500 ml', quantity: 1,
  options: [{ nameZh: '甜度', values: [{ nameZh: '半糖', secret: 'TOKEN-SECRET' }], secret: 'TOKEN-SECRET' }],
  toppings: [{ nameZh: '珍珠', portions: 1, secret: 'TOKEN-SECRET' }],
  lineTotal: total, unitPrice: total, customerNote: '少冰', internalNote: 'TOKEN-SECRET', secret: 'TOKEN-SECRET' }], subtotal: total, total, secret: 'TOKEN-SECRET' });

async function setOrder(env, total) {
  const { state, renderOrder } = env.context.testing;
  state.catalog = { release: 'example' }; state.items = [{ quantity: 1 }];
  env.context.fetch = async () => ({ ok: true, json: async () => ({ data: quote(total) }) });
  await renderOrder();
}

test('共用協定嚴格驗證 ID 與 fragment，兩頁載入 module', async () => {
  const id = protocol.displayId();
  assert.ok(isDisplayId(id));
  assert.equal(displayPairFromHash(`#pair=${id}`), id);
  for (const value of [null, 42, '', '-'.repeat(36), 'a'.repeat(36), `${id}x`, ` ${id}`]) assert.equal(isDisplayId(value), false);
  for (const hash of ['', '#', '#pair=', '#pair=bad', `#pair=${id}&pair=${id}`, `#other=${id}`]) assert.equal(displayPairFromHash(hash), null);
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /id="open-display"/);
  for (const file of ['index.html', 'display.html']) assert.match(await readFile(new URL(file, root), 'utf8'), /<script type="module"/);
});

test('無配對或無效配對客顯維持待機，不探索主畫面', async () => {
  for (const hash of ['', '#pair=bad', `#pair=${randomUUID()}&pair=${randomUUID()}`]) {
    const env = setup({ hash }); await load(env, 'display.js');
    assert.equal(env.channels.length, 0);
    assert.equal(env.get('message').textContent, '請由主畫面開啟客顯');
    env.timers[0](); env.listeners.visibilitychange();
    assert.equal(env.get('amount').hidden, true);
    assert.equal(env.channels.length, 0);
  }
});

test('客顯拒絕錯 pair、錯來源、錯 nonce、舊 revision 與無效訂單', async () => {
  const env = await display(randomUUID()); const channel = env.channels[0]; const order = orderFor(env);
  assert.equal(channel.name, DISPLAY_CHANNEL);
  for (const extra of [{ pair: randomUUID() }, { pair: undefined }, { session: randomUUID() }, { nonce: randomUUID() }, { session: '-'.repeat(36) }, { total: '-1' }, { revision: -1 }, { revision: 1.5 }, { phase: 'payment' }, { items: [] }]) {
    channel.onmessage({ data: { ...order, ...extra } });
    assert.equal(env.get('amount').hidden, true);
    assert.equal(channel.sent.length, 1, 'invalid snapshots must not be acknowledged');
  }
  channel.onmessage({ data: order });
  assert.equal(env.get('heading').textContent, '您的點餐');
  assert.equal(env.get('items').children[0].children[0].children[0].textContent, '<茶>');
  assert.equal(channel.sent.at(-1).type, 'ack');
  const mutations = env.mutations(); const sent = channel.sent.length;
  channel.onmessage({ data: { ...order, revision: 1, phase: 'standby' } });
  assert.equal(env.mutations(), mutations); assert.equal(channel.sent.length, sent);
});

test('客顯拒絕不完整或不一致的明細金額，並相容舊主畫面', async () => {
  const env = await display(randomUUID()); const channel = env.channels[0];
  const order = orderFor(env); const item = order.items[0];
  for (const prices of [
    { unitPrice: '22000' }, { lineTotal: '22000' }, { unitPrice: '-1', lineTotal: '0' },
    { unitPrice: 22000, lineTotal: '22000' }, { unitPrice: '1'.repeat(31), lineTotal: '1' },
    { unitPrice: '22000', lineTotal: '44000' }, { unitPrice: '22000', lineTotal: '22.000' }
  ]) {
    channel.onmessage({ data: { ...order, items: [{ ...item, ...prices }] } });
    assert.equal(env.get('amount').hidden, true);
    assert.equal(channel.sent.length, 1, 'invalid amounts must not be acknowledged');
  }
  channel.onmessage({ data: order });
  assert.equal(env.get('amount').hidden, false);
  assert.equal(env.get('items').children[0].children.length, 2, 'older host can omit both prices');
  channel.onmessage({ data: { ...order, revision: 3, total: '0', items: [{ ...item, unitPrice: '0', lineTotal: '0' }] } });
  assert.equal(env.get('items').children[0].children[2].children[0].textContent, '每杯 0 ₫');
  assert.equal(env.get('items').children[0].children[2].children[1].textContent, '小計 0 ₫');
});

test('兩種客顯模式顯示伺服器試算的單價與小計，並隨訂單更新', async () => {
  const transport = bus(); const host = await main(transport);
  host.context.testing.state.catalog = structuredClone(catalog);
  host.context.fetch = async (_, options) => ({ ok: true, json: async () => ({ data: quoteOrder(JSON.parse(options.body), catalog) }) });
  const customer = await display(host.pair, transport); transport.flush();
  const { state, renderOrder } = host.context.testing;
  state.items = [{ productId: 'oolong', variantId: 'oolong-500', quantity: 2,
    toppings: [{ id: 'example-topping', portions: 1 }], options: [], customerNote: '少冰', internalNote: '不得顯示' }];
  await renderOrder(); transport.flush();
  const checkPrices = (unit, line, total) => {
    const row = customer.get('items').children[0];
    assert.equal(row.children[2].children[0].textContent, `每杯 ${unit}`);
    assert.equal(row.children[2].children[1].textContent, `小計 ${line}`);
    assert.equal(customer.get('total').textContent, total);
  };
  checkPrices('27.000 ₫', '54.000 ₫', '54.000 ₫');
  assert.equal(JSON.stringify(host.channels[0].sent).includes('不得顯示'), false);
  host.get('#display-mode').listeners.change({ target: { value: 'touch' } }); transport.flush();
  assert.equal(customer.get('touch-menu').hidden, false);
  checkPrices('27.000 ₫', '54.000 ₫', '54.000 ₫');
  state.items[0].variantId = 'oolong-700'; state.items[0].quantity = 1;
  await renderOrder(); transport.flush();
  checkPrices('29.000 ₫', '29.000 ₫', '29.000 ₫');
  state.items = []; await renderOrder(); transport.flush();
  assert.equal(customer.get('items').children.length, 0);
  assert.equal(customer.get('amount').hidden, true);
});

test('相同 session/revision 心跳只更新時間及 ACK，完全不重繪 DOM', async () => {
  const env = await display(randomUUID()); const channel = env.channels[0]; const order = orderFor(env);
  channel.onmessage({ data: order });
  const row = env.get('items').children[0]; const mutations = env.mutations();
  for (let i = 0; i < 6; i++) {
    env.advance(1000); channel.onmessage({ data: order }); env.timers[0]();
    assert.equal(env.mutations(), mutations);
    assert.equal(env.get('items').children[0], row);
    const ack = channel.sent.at(-2);
    assert.deepEqual(ack, { type: 'ack', pair: order.pair, nonce: order.nonce, session: order.session, revision: 2 });
    assert.equal(channel.sent.at(-1).nonce, order.nonce, 'heartbeats refresh timeout');
  }
  channel.onmessage({ data: { ...order, revision: 3, total: '24000' } });
  assert.notEqual(env.get('items').children[0], row);
  const afterChange = env.mutations();
  channel.onmessage({ data: { ...order, revision: 3, total: '99999' } });
  assert.equal(env.mutations(), afterChange, 'content changes require a new revision');
  for (const [i, phase] of ['standby', 'calculating', 'unavailable'].entries()) {
    const message = { ...order, phase, revision: i + 4 };
    channel.onmessage({ data: message }); const before = env.mutations();
    channel.onmessage({ data: message }); assert.equal(env.mutations(), before);
  }
  env.advance(DISPLAY_TIMEOUT); env.timers[0]();
  assert.equal(env.get('amount').hidden, true);
  assert.notEqual(channel.sent.at(-1).nonce, order.nonce);
});

test('逾時與可見性重連保留指定 pair，拒絕舊 nonce 並重建已清除訂單', async () => {
  const env = await display(randomUUID()); const channel = env.channels[0]; const order = orderFor(env);
  channel.onmessage({ data: order });
  env.advance(DISPLAY_TIMEOUT); channel.onmessage({ data: order });
  assert.equal(env.get('amount').hidden, true);
  const request = channel.sent.at(-1);
  assert.equal(request.pair, order.pair); assert.notEqual(request.nonce, order.nonce);
  channel.onmessage({ data: order }); assert.equal(env.get('amount').hidden, true);
  channel.onmessage({ data: { ...order, nonce: request.nonce, session: randomUUID() } });
  assert.equal(env.get('amount').hidden, true);
  channel.onmessage({ data: { ...order, nonce: request.nonce } });
  assert.equal(env.get('amount').hidden, false);
  env.listeners.visibilitychange();
  assert.equal(env.get('amount').hidden, false);
  assert.equal(channel.sent.at(-1).nonce, request.nonce);
  env.advance(DISPLAY_TIMEOUT);
  env.listeners.visibilitychange();
  assert.equal(env.get('amount').hidden, true);
  const visibleRequest = channel.sent.at(-1);
  assert.equal(visibleRequest.pair, order.pair); assert.notEqual(visibleRequest.nonce, request.nonce);
  channel.onmessage({ data: { ...order, nonce: visibleRequest.nonce } });
  assert.equal(env.get('amount').hidden, false);
});

test('同源多主畫面與多客顯各自配對，不採 first responder，重連不串單', async () => {
  const transport = bus();
  const a = await main(transport); const b = await main(transport);
  assert.notEqual(a.pair, b.pair);
  await setOrder(a, '11000'); await setOrder(b, '22000');
  // A was created first, but B's display must receive only B's order.
  const db = await display(b.pair, transport); const da = await display(a.pair, transport);
  transport.flush();
  assert.equal(da.get('total').textContent, '11.000 ₫');
  assert.equal(db.get('total').textContent, '22.000 ₫');
  for (const env of [a, b]) {
    assert.equal(env.get('#display-status').textContent, '客顯已連線');
    assert.ok(env.channels[0].sent.every(message => message.pair === env.pair && message.session === env.pair));
  }
  db.advance(DISPLAY_TIMEOUT); db.timers[0](); transport.flush();
  assert.equal(db.get('total').textContent, '22.000 ₫');
  db.listeners.visibilitychange(); transport.flush();
  assert.equal(db.get('total').textContent, '22.000 ₫');
  await setOrder(a, '33000'); transport.flush();
  assert.equal(da.get('total').textContent, '33.000 ₫');
  assert.equal(db.get('total').textContent, '22.000 ₫');
});

test('主畫面 refresh 產生新 pair，舊客顯不可自動綁至新主畫面', async () => {
  const transport = bus(); const old = await main(transport);
  await setOrder(old, '11000');
  const customer = await display(old.pair, transport); transport.flush();
  assert.equal(customer.get('amount').hidden, false);
  old.channels[0].close();
  const refreshed = await main(transport); await setOrder(refreshed, '22000');
  assert.notEqual(refreshed.pair, old.pair);
  customer.advance(DISPLAY_TIMEOUT); customer.timers[0](); transport.flush();
  assert.equal(customer.get('amount').hidden, true);
  assert.equal(customer.channels[0].sent.at(-1).pair, old.pair);
  assert.equal(refreshed.channels[0].sent.length, 0);
  customer.listeners.visibilitychange(); transport.flush();
  assert.equal(customer.get('amount').hidden, true);
  const reopened = await display(refreshed.pair, transport); transport.flush();
  assert.equal(reopened.get('total').textContent, '22.000 ₫');
  assert.equal(customer.get('amount').hidden, true);
});

test('客顯模式、同鍵重試及過期畫面不會重複加入商品', async () => {
  const env = await main(), channel = env.channels[0], nonce = randomUUID(), pair = env.pair;
  env.context.testing.state.catalog = structuredClone(catalog);
  channel.onmessage({ data: { type: 'request', pair, nonce } });
  const item = { productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], options: [], customerNote: '少冰', internalNote: '不應採用', price: '1' };
  const action = { type: 'add-item', pair, nonce, session: pair, revision: channel.sent.at(-1).revision, operationId: randomUUID(), item };
  channel.onmessage({ data: action });
  assert.equal(channel.sent.at(-1).ok, false);
  assert.equal(env.context.testing.state.items.length, 0);
  env.get('#display-mode').listeners.change({ target: { value: 'touch' } });
  const snapshot = channel.sent.at(-1);
  assert.equal(snapshot.mode, 'touch'); assert.equal(snapshot.catalog.release, catalog.release);
  assert.equal(JSON.stringify(snapshot.catalog).includes('不應採用'), false);
  const calls = [];
  env.context.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ data: quote('22000') }) }; };
  const accepted = { ...action, operationId: randomUUID(), revision: snapshot.revision };
  channel.onmessage({ data: accepted });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.context.testing.state.items.length, 1);
  assert.equal(env.context.testing.state.items[0].internalNote, '');
  assert.equal(env.context.testing.state.items[0].price, undefined);
  assert.equal(calls[0].items[0].customerNote, '少冰');
  assert.equal(calls.length, 1, 'reuse the verified quote instead of requesting it twice');
  assert.equal(env.get('#total').textContent, '22.000 ₫');
  assert.ok(channel.sent.some(m => m.type === 'add-result' && m.operationId === accepted.operationId && m.ok));
  channel.onmessage({ data: accepted });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.context.testing.state.items.length, 1);
  channel.onmessage({ data: { ...accepted, operationId: randomUUID() } });
  assert.equal(channel.sent.at(-1).ok, false);
  assert.equal(env.context.testing.state.items.length, 1);
});

test('顧客送出後店員切換模式，延遲試算不可加入訂單', async () => {
  const env = await main(), channel = env.channels[0], pair = env.pair, nonce = randomUUID();
  env.context.testing.state.catalog = structuredClone(catalog);
  channel.onmessage({ data: { type: 'request', pair, nonce } });
  env.get('#display-mode').listeners.change({ target: { value: 'touch' } });
  const revision = channel.sent.at(-1).revision;
  let finishFetch; let calls = 0;
  env.context.fetch = () => { calls++; return new Promise(resolve => { finishFetch = resolve; }); };
  const message = { type: 'add-item', pair, nonce, session: pair, revision, operationId: randomUUID(), item: { productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], options: [], customerNote: '' } };
  channel.onmessage({ data: message }); channel.onmessage({ data: message });
  assert.equal(calls, 1);
  env.get('#display-mode').listeners.change({ target: { value: 'view' } });
  finishFetch({ ok: true, json: async () => ({ data: quote('22000') }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.context.testing.state.items.length, 0);
  assert.equal(channel.sent.at(-1).ok, false);
});

test('主畫面只接受對應 pair 請求與有效 ACK，廣播嚴格報價白名單', async () => {
  const env = await main(); const pending = []; const { pair } = env;
  const { state, renderOrder } = env.context.testing; const channel = env.channels[0];
  const nonce = randomUUID();
  for (const extra of [{ pair: randomUUID() }, { pair: undefined }, { nonce: '-'.repeat(36) }]) {
    channel.onmessage({ data: { type: 'request', pair, nonce, ...extra } });
    assert.equal(channel.sent.length, 0);
  }
  channel.onmessage({ data: { type: 'request', pair, nonce } });
  const initial = channel.sent.at(-1);
  const ack = { type: 'ack', pair, nonce, session: initial.session, revision: initial.revision };
  for (const extra of [{ pair: randomUUID() }, { pair: undefined }, { session: randomUUID() }, { nonce: randomUUID() }, { revision: initial.revision + 1 }]) {
    channel.onmessage({ data: { ...ack, ...extra } });
    assert.equal(env.get('#display-status').textContent, '客顯未連線');
  }
  channel.onmessage({ data: ack }); assert.equal(env.get('#display-status').textContent, '客顯已連線');
  env.advance(DISPLAY_TIMEOUT); env.timers[0]();
  channel.onmessage({ data: ack }); assert.equal(env.get('#display-status').textContent, '客顯未連線');
  channel.onmessage({ data: { type: 'request', pair, nonce } });
  env.context.fetch = () => new Promise(resolve => pending.push(resolve));
  state.catalog = { release: 'example' }; state.items = [{ quantity: 1, secret: 'TOKEN-SECRET' }];
  const first = renderOrder(); assert.equal(channel.sent.at(-1).phase, 'calculating');
  const second = renderOrder();
  pending[0]({ ok: true, json: async () => ({ data: quote('100') }) }); await first;
  assert.equal(channel.sent.at(-1).phase, 'calculating');
  pending[1]({ ok: true, json: async () => ({ data: quote('200') }) }); await second;
  assert.deepEqual(channel.sent.at(-1), {
    type: 'snapshot', pair, nonce, session: pair, revision: 4, mode: 'view', phase: 'order',
    items: [{ name: '茶', variant: '500 ml', quantity: 1, customerNote: '少冰', unitPrice: '200', lineTotal: '200', options: [{ name: '甜度', values: ['半糖'] }], toppings: [{ name: '珍珠', portions: 1 }] }], total: '200'
  });
  assert.equal(JSON.stringify(channel.sent).includes('TOKEN-SECRET'), false);
  const third = renderOrder();
  assert.equal(channel.sent.at(-1).phase, 'calculating'); assert.equal('total' in channel.sent.at(-1), false);
  assert.equal(env.get('#total').textContent, '—');
  pending[2]({ ok: true, json: async () => ({ data: quote('300') }) }); await third;
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function touchMain() {
  const env = await main();
  env.context.testing.state.catalog = structuredClone(catalog);
  env.nonce = randomUUID(); env.channel = env.channels[0];
  env.channel.onmessage({ data: { type: 'request', pair: env.pair, nonce: env.nonce } });
  env.get('#display-mode').listeners.change({ target: { value: 'touch' } });
  return env;
}
function customerAction(env, extra = {}) {
  return { type: 'add-item', pair: env.pair, nonce: env.nonce, session: env.pair,
    revision: env.channel.sent.findLast(m => m.type === 'snapshot').revision,
    operationId: randomUUID(), item: { productId: 'oolong', variantId: 'oolong-500', quantity: 1, toppings: [], options: [], customerNote: '' }, ...extra };
}
function realQuotes(env) {
  env.context.fetch = async (_, options) => ({ ok: true, json: async () => ({ data: quoteOrder(JSON.parse(options.body), catalog) }) });
}

test('試算 headers 或 body 掛起都會逾時解鎖，忽略取消的晚到結果也不能加單', async () => {
  for (const stage of ['headers', 'body']) {
    const env = await touchMain(); let finish; let signal;
    env.context.fetch = (_, options) => {
      signal = options.signal;
      if (stage === 'headers') return new Promise(resolve => { finish = resolve; });
      return Promise.resolve({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
    };
    const old = customerAction(env);
    env.channel.onmessage({ data: old }); await tick();
    env.advance(10000); await tick();
    assert.equal(signal.aborted, true);
    assert.equal(env.context.testing.state.items.length, 0);
    assert.match(env.channel.sent.at(-1).message, /逾時/);
    // Refresh the existing connection, without reloading the main order.
    env.channel.onmessage({ data: { type: 'request', pair: env.pair, nonce: env.nonce } });
    realQuotes(env);
    env.channel.onmessage({ data: customerAction(env) }); await tick();
    assert.equal(env.context.testing.state.items.length, 1, 'timeout releases the global pending lock');
    if (stage === 'headers') finish({ ok: true, json: async () => ({ data: quote('22000') }) });
    else finish({ data: quote('22000') });
    await tick();
    assert.equal(env.context.testing.state.items.length, 1, 'late quote cannot add the timed-out item');
  }
});

test('超過 1000 次操作可繼續點餐，已回收的成功操作重播仍被舊 revision 拒絕', async () => {
  const env = await touchMain(); realQuotes(env);
  const accepted = customerAction(env);
  env.channel.onmessage({ data: accepted }); await tick();
  assert.equal(env.context.testing.state.items.length, 1);
  env.context.fetch = async () => ({ ok: false, json: async () => ({ error: { message: '選項不正確' } }) });
  for (let i = 0; i < 1005; i++) {
    env.channel.onmessage({ data: customerAction(env) }); await tick();
  }
  assert.ok(env.context.testing.operationCount() <= 1000);
  let calls = 0;
  env.context.fetch = async (_, options) => { calls++; return { ok: true, json: async () => ({ data: quoteOrder(JSON.parse(options.body), catalog) }) }; };
  env.channel.onmessage({ data: accepted }); await tick();
  assert.equal(calls, 0); assert.equal(env.context.testing.state.items.length, 1);
  env.channel.onmessage({ data: customerAction(env) }); await tick();
  assert.equal(calls, 1); assert.equal(env.context.testing.state.items.length, 2);
});

test('顧客加入前也檢查完整訂單的 UTF-8 大小，不改動原訂單', async () => {
  const env = await touchMain();
  const item = { ...customerAction(env).item, customerNote: '茶'.repeat(200), internalNote: '茶'.repeat(200) };
  env.context.testing.state.items = Array.from({ length: 60 }, () => structuredClone(item));
  let calls = 0; env.context.fetch = () => { calls++; throw new Error('must not fetch'); };
  env.channel.onmessage({ data: customerAction(env) }); await tick();
  assert.equal(calls, 0); assert.equal(env.context.testing.state.items.length, 60);
  assert.match(env.channel.sent.at(-1).message, /大小上限/);
});

test('多客顯只在首次連線傳菜單，request 不向其他客顯廣播，心跳不重繪觸控 DOM', async () => {
  const transport = bus(); const host = await main(transport);
  host.context.testing.state.catalog = structuredClone(catalog);
  host.get('#display-mode').listeners.change({ target: { value: 'touch' } });
  const first = await display(host.pair, transport); transport.flush();
  const second = await display(host.pair, transport); transport.flush();
  assert.equal(first.get('touch-menu').hidden, false);
  const connection = first.channels[0].sent.find(m => m.type === 'request');
  const channel = host.channels[0], before = channel.sent.length;
  const mutations = first.mutations();
  first.timers[0](); transport.flush();
  const replies = channel.sent.slice(before);
  assert.equal(replies.length, 1); assert.equal(replies[0].nonce, connection.nonce);
  assert.equal(replies[0].type, 'heartbeat'); assert.equal('catalog' in replies[0], false);
  assert.equal(first.mutations(), mutations);
  host.timers[0](); transport.flush();
  assert.ok(channel.sent.slice(before).every(m => !('catalog' in m)));
  realQuotes(host);
  host.context.testing.state.items = [customerAction({ pair: host.pair, nonce: connection.nonce, channel }).item];
  await host.context.testing.renderOrder(); transport.flush();
  assert.equal(first.get('total').textContent, '22.000 ₫');
  assert.equal(second.get('total').textContent, '22.000 ₫');
  assert.ok(channel.sent.slice(before).every(m => !('catalog' in m)), 'order revisions reuse the acknowledged menu');
  // A fresh nonce after disconnect must receive the full menu again.
  first.advance(DISPLAY_TIMEOUT); first.timers[0](); transport.flush();
  assert.equal(first.get('touch-menu').hidden, false);
  assert.ok(channel.sent.slice(before).some(m => m.catalog));
  host.context.testing.state.catalog = { ...structuredClone(catalog), release: 'release-new' };
  host.context.testing.state.catalog.products[0].nameZh = '新菜單茶';
  host.context.testing.state.items = [];
  await host.context.testing.renderOrder(); transport.flush();
  assert.equal(first.get('touch-products').children[0].children[1].textContent, '新菜單茶');
});

test('觸控客顯與伺服器共用菜單限制，拒絕無效完整菜單與未快取的版本', async () => {
  const env = await display(randomUUID()); const channel = env.channels[0];
  const menu = structuredClone(catalog);
  const snapshot = orderFor(env, { phase: 'standby', mode: 'touch', catalog: menu, catalogRelease: menu.release });
  const invalid = structuredClone(menu); invalid.products[0].nameZh = 'a'.repeat(101);
  channel.onmessage({ data: { ...snapshot, catalog: invalid } });
  assert.equal(channel.sent.length, 1);
  const duplicate = structuredClone(menu); duplicate.products[0].variants.push({ ...duplicate.products[0].variants[0] });
  channel.onmessage({ data: { ...snapshot, catalog: duplicate } });
  assert.equal(channel.sent.length, 1);
  channel.onmessage({ data: snapshot });
  assert.equal(env.get('touch-menu').hidden, false);
  const ackCount = channel.sent.length;
  channel.onmessage({ data: { ...snapshot, revision: 3, catalog: undefined, catalogRelease: 'unknown-release' } });
  assert.equal(channel.sent.length, ackCount);
  channel.onmessage({ data: { ...snapshot, revision: 3, catalog: undefined } });
  assert.equal(channel.sent.at(-1).revision, 3);
});
