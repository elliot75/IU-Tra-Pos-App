import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteOrder } from '../src/pricing.js';
import { catalog } from '../src/catalog.js';
const item = (variantId = 'oolong-700', toppings = [], quantity = 1) => ({ productId: 'oolong', variantId, toppings, quantity });
const quote = items => quoteOrder({ menuRelease: 'example-v1', items });

test('商品選項以伺服器名稱建立快照，不影響價格', () => {
  const menu = structuredClone(catalog);
  menu.products[0].optionGroups = [
    { id: 'ice', nameZh: '冰量', nameVi: 'Đá', minSelect: 1, maxSelect: 1, defaultValueIds: ['less'], values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít đá' }] },
    { id: 'sugar', nameZh: '甜度', nameVi: 'Đường', minSelect: 0, maxSelect: 1, values: [{ id: 'half', nameZh: '半糖', nameVi: 'Nửa đường' }] }
  ];
  const makeQuote = options => quoteOrder({ menuRelease: menu.release, items: [{ ...item(), options }] }, menu);
  const result = makeQuote([{ groupId: 'ice', nameZh: '偽造', price: '999', valueIds: ['less'] }]);
  assert.deepEqual(result.items[0].options, [{ groupId: 'ice', nameZh: '冰量', nameVi: 'Đá', values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít đá' }] }]);
  assert.equal(result.total, '24000');
  menu.products[0].optionGroups[0].values[0].nameZh = '改名';
  assert.equal(result.items[0].options[0].values[0].nameZh, '少冰');
  for (const options of [
    undefined, [], null, {},
    [{ groupId: 'ice', valueIds: [] }],
    [{ groupId: 'unknown', valueIds: ['less'] }],
    [{ groupId: 'ice', valueIds: ['half'] }],
    [{ groupId: 'ice', valueIds: ['missing'] }],
    [{ groupId: 'ice', valueIds: ['less', 'less'] }],
    [{ groupId: 'ice', valueIds: ['less'] }, { groupId: 'ice', valueIds: ['less'] }],
    [{ groupId: 'ice', valueIds: ['less'] }, { groupId: 'sugar', valueIds: 'half' }],
    [{ groupId: 'ice', valueIds: ['less'] }, { groupId: 'sugar', valueIds: ['half', 'half'] }]
  ]) assert.throws(() => makeQuote(options));
  assert.equal(makeQuote([{ groupId: 'ice', valueIds: ['less'] }, { groupId: 'sugar', valueIds: ['half'] }]).total, '24000');
  assert.deepEqual(quote([item()]).items[0].options, []);
  assert.throws(() => quote([{ ...item(), options: [{ groupId: 'ice', valueIds: ['less'] }] }]));
});

test('糖度與冰量各自最多選一項，伺服器拒絕繞過介面複選', () => {
  const menu = structuredClone(catalog);
  menu.products[0].optionGroups = [
    { id: 'sugar', nameZh: '甜度', nameVi: 'Đường', minSelect: 1, maxSelect: 1, values: [{ id: 'half', nameZh: '半糖', nameVi: 'Nửa' }, { id: 'normal', nameZh: '全糖', nameVi: 'Đủ' }] },
    { id: 'ice', nameZh: '冰量', nameVi: 'Đá', minSelect: 1, maxSelect: 1, values: [{ id: 'less', nameZh: '少冰', nameVi: 'Ít' }, { id: 'normal', nameZh: '正常冰', nameVi: 'Đủ' }] }
  ];
  const quoteOptions = options => quoteOrder({ menuRelease: menu.release, items: [{ ...item(), options }] }, menu);
  const sugar = { groupId: 'sugar', valueIds: ['half'] };
  const ice = { groupId: 'ice', valueIds: ['less'] };
  assert.equal(quoteOptions([sugar, ice]).total, '24000');
  assert.throws(() => quoteOptions([{ ...sugar, valueIds: ['half', 'normal'] }, ice]));
  assert.throws(() => quoteOptions([sugar, { ...ice, valueIds: ['less', 'normal'] }]));
});

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
