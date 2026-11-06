import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as protocol from '../public/display-protocol.js';

const root = new URL('../public/', import.meta.url);
const { DISPLAY_CHANNEL, DISPLAY_TIMEOUT, DISPLAY_HEARTBEAT, displayPairFromHash, isDisplayId } = protocol;

// Bridge the single named ESM import to its real, natively imported namespace.
// This keeps vm DOM isolation without requiring --experimental-vm-modules or copying protocol code.
async function load(env, file, expose = '') {
  const source = await readFile(new URL(file, root), 'utf8');
  let imports = 0;
  const script = source.replace(/^import \{ ([\w, ]+) \} from '\.\/display-protocol\.js';$/gm, (_, names) => {
    imports++;
    for (const name of names.split(',').map(name => name.trim())) assert.ok(name in protocol);
    return `const { ${names} } = globalThis.displayProtocol;`;
  });
  assert.equal(imports, 1, 'each page imports the shared protocol');
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
      innerHTML: '', dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      replaceChildren(...children) { this.children = children; mutations++; },
      append(...children) { this.children.push(...children); mutations++; },
      querySelector: get, querySelectorAll() { return []; }
    };
  }
  function get(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }
  let now = 10000; const timers = []; const channels = []; const listeners = {};
  class Channel {
    constructor(name) { this.name = name; this.sent = []; this.active = true; channels.push(this); transport?.connect(this); }
    postMessage(message) { this.sent.push(structuredClone(message)); transport?.send(this, message); }
    close() { this.active = false; }
  }
  const document = { querySelector: get, getElementById: get, createElement: node, addEventListener(type, fn) { listeners[type] = fn; }, hidden: false };
  const context = vm.createContext({
    document, location: { hash }, BroadcastChannel: Channel, displayProtocol: protocol,
    Date: { now: () => now }, setInterval: (fn, delay) => { assert.equal(delay, DISPLAY_HEARTBEAT); timers.push(fn); },
    Intl, BigInt, console,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: {} }) })
  });
  return { context, get, timers, channels, listeners, mutations: () => mutations, advance(ms) { now += ms; } };
}

async function main(transport) {
  const env = setup({ transport });
  await load(env, 'app.js', 'globalThis.testing = { state, renderOrder };');
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
  lineTotal: total, unitPrice: total, secret: 'TOKEN-SECRET' }], subtotal: total, total, secret: 'TOKEN-SECRET' });

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
    type: 'snapshot', pair, nonce, session: pair, revision: 4, phase: 'order',
    items: [{ name: '茶', variant: '500 ml', quantity: 1, options: [{ name: '甜度', values: ['半糖'] }], toppings: [{ name: '珍珠', portions: 1 }] }], total: '200'
  });
  assert.equal(JSON.stringify(channel.sent).includes('TOKEN-SECRET'), false);
  const third = renderOrder();
  assert.equal(channel.sent.at(-1).phase, 'calculating'); assert.equal('total' in channel.sent.at(-1), false);
  assert.equal(env.get('#total').textContent, '—');
  pending[2]({ ok: true, json: async () => ({ data: quote('300') }) }); await third;
});
