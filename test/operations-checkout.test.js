import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOperations } from '../public/operations.js';

const BINDING_KEY = 'iutra.pos.workcheckout';
const binding = {
  clientOrderId: '11111111-1111-4111-8111-111111111111',
  displayPair: 'checkout-display-pair',
  orderId: '22222222-2222-4222-8222-222222222222'
};
const deviceId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';

function sessionStorage() {
  const values = new Map([[BINDING_KEY, JSON.stringify(binding)]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

// Only initialization/updateControls need DOM nodes. Authentication is supplied
// through the returned state; no login event or buildWorkspace is invoked.
function mount(storage) {
  const nodes = new Map([
    '#login-form', '#logout', '#refresh', '#pending-panel', '#query-pending',
    '#retry-pending', '#recover-secret', '#recover-secret-label'
  ].map(selector => [selector, {
    addEventListener() {},
    querySelectorAll() { return []; }
  }]));
  const optional = new Set(['#verify-form', '#create-order', '#cart-review']);
  const document = {
    querySelector(selector) {
      if (optional.has(selector)) return null;
      assert.ok(nodes.has(selector), `Unexpected DOM selector: ${selector}`);
      return nodes.get(selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-read]');
      return [];
    }
  };
  const channels = [];
  const window = {
    sessionStorage: storage,
    addEventListener() {},
    BroadcastChannel: class {
      constructor(name) {
        this.name = name;
        this.messages = [];
        channels.push(this);
      }
      postMessage(message) { this.messages.push(structuredClone(message)); }
    }
  };
  const { state } = mountOperations(document, window);
  assert.equal(channels.length, 1);
  const channel = channels[0];
  assert.equal(channel.name, 'iutra-pos-checkout');
  assert.equal(typeof channel.onmessage, 'function');
  assert.equal(state.displayPair, storage.getItem(BINDING_KEY) ? binding.displayPair : null);
  Object.assign(state, {
    token: 'test-session', user: { id: 'test-cashier' },
    deviceId, deviceKey: 'test-device-key',
    context: { permissions: ['pos'] }
  });
  return {
    messages: channel.messages,
    request: () => channel.onmessage({ data: {
      type: 'checkout-request', pair: binding.displayPair,
      clientOrderId: binding.clientOrderId
    } }),
    ack: (phase, overrides = {}) => channel.onmessage({ data: {
      type: 'checkout-ack', pair: binding.displayPair,
      clientOrderId: binding.clientOrderId, orderId: binding.orderId,
      phase, ...overrides
    } })
  };
}

function mockOrders(t, status, failures = 0) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, options });
    if (calls.length <= failures) {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'Unavailable' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: {
      id: binding.orderId, client_order_id: binding.clientOrderId,
      status, total: '22000', pickup_number: 'A007'
    } }) };
  });
  return calls;
}

function assertBindingRetained(storage) {
  assert.deepEqual(JSON.parse(storage.getItem(BINDING_KEY)), binding);
}

function assertOrderReads(calls, count) {
  assert.equal(calls.length, count);
  for (const { path, options } of calls) {
    assert.equal(path, `/api/v1/pos/orders/${binding.orderId}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(options.headers['X-POS-Device'], deviceId);
    assert.equal(options.headers['X-POS-Key'], 'test-device-key');
  }
}

function assertTerminal(message, phase) {
  assert.ok(message, 'A terminal checkout message must be broadcast');
  assert.equal(message.type, 'checkout');
  assert.equal(message.phase, phase);
  assert.equal(message.pair, binding.displayPair);
  assert.equal(message.clientOrderId, binding.clientOrderId);
  assert.equal(message.orderId, binding.orderId);
  assert.equal(message.total, '22000');
  assert.equal(message.pickupNumber, 'A007');
}

for (const [status, phase] of [['completed', 'completed'], ['cancelled', 'standby']]) {
  test(`${status}: repeat terminal checkout until matching acknowledgement`, async t => {
    const storage = sessionStorage();
    const calls = mockOrders(t, status);
    const app = mount(storage);
    await app.request();
    assertOrderReads(calls, 1);
    assert.equal(app.messages.length, 1);
    assertTerminal(app.messages[0], phase);
    assertBindingRetained(storage);

    // Each identity field must match independently; a nonterminal ack is also ignored.
    for (const wrong of [
      { clientOrderId: otherId }, { pair: 'other-display-pair' },
      { orderId: otherId }, { phase: 'payment' }
    ]) {
      await app.ack(phase, wrong);
      assertBindingRetained(storage);
      const previous = app.messages.length;
      await app.request();
      assert.equal(app.messages.length, previous + 1);
      assertTerminal(app.messages.at(-1), phase);
      assertBindingRetained(storage);
    }
    assertOrderReads(calls, 5);

    await app.ack(phase);
    assert.equal(storage.getItem(BINDING_KEY), null);
    await app.request();
    assertOrderReads(calls, 5);
    assert.equal(app.messages.length, 5, 'Matching ack also clears the in-memory binding');
  });

  test(`${status}: GET 503 retains binding and a later request retries successfully`, async t => {
    const storage = sessionStorage();
    const calls = mockOrders(t, status, 1);
    const app = mount(storage);
    await app.request();
    assertOrderReads(calls, 1);
    assert.deepEqual(app.messages, []);
    assertBindingRetained(storage);

    await app.request();
    assertOrderReads(calls, 2);
    assert.equal(app.messages.length, 1);
    assertTerminal(app.messages[0], phase);
    assertBindingRetained(storage);
    await app.ack(phase);
    assert.equal(storage.getItem(BINDING_KEY), null);
  });

  test(`${status}: remount recovers an unacknowledged terminal checkout from sessionStorage`, async t => {
    const storage = sessionStorage();
    const calls = mockOrders(t, status);
    const original = mount(storage);
    await original.request();
    assert.equal(original.messages.length, 1);
    assertTerminal(original.messages[0], phase);
    assertBindingRetained(storage);

    // A new closure/channel shares only storage, just as a reloaded page would.
    const reloaded = mount(storage);
    assert.deepEqual(reloaded.messages, []);
    await reloaded.request();
    assertOrderReads(calls, 2);
    assert.equal(reloaded.messages.length, 1);
    assertTerminal(reloaded.messages[0], phase);
    assertBindingRetained(storage);
    await reloaded.ack(phase);
    assert.equal(storage.getItem(BINDING_KEY), null);

    const afterAck = mount(storage);
    await afterAck.request();
    assertOrderReads(calls, 2);
    assert.deepEqual(afterAck.messages, [], 'Acknowledged binding stays cleared across reload');
  });
}
