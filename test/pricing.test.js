import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteOrder } from '../src/pricing.js';
const item = (variantId = 'oolong-700', toppings = [], quantity = 1) => ({ productId: 'oolong', variantId, toppings, quantity });
const quote = items => quoteOrder({ menuRelease: 'example-v1', items });

test('規格驗收範例：兩杯共 51,000 VND', () => {
  const result = quote([item('oolong-700', [{ id: 'example-topping', portions: 1 }]), item('oolong-500')]);
  assert.equal(result.items[0].lineTotal, '29000');
  assert.equal(result.total, '51000');
});
test('配料按每杯份數及杯數計算', () => {
  assert.equal(quote([item('oolong-700', [{ id: 'example-topping', portions: 2 }], 3)]).total, '102000');
});
test('伺服器不採用客戶端提供的價格', () => {
  assert.equal(quote([{ ...item(), price: '1', unitPrice: '1' }]).total, '24000');
});
test('拒絕錯誤版本、規格、配料及份數', () => {
  assert.throws(() => quoteOrder({ menuRelease: 'old', items: [item()] }));
  assert.throws(() => quote([item('invalid')]));
  assert.throws(() => quote([item('oolong-700', [{ id: 'example-topping', portions: 4 }])]));
  assert.throws(() => quote([item('oolong-700', [{ id: 'example-topping', portions: 1 }, { id: 'example-topping', portions: 1 }])]));
  assert.throws(() => quote([item('oolong-500', [], 0)]));
  assert.throws(() => quote([item('oolong-500', [], 1.5)]));
  assert.throws(() => quote([]));
});
