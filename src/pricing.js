import { catalog } from './catalog.js';

import { ValidationError, normalizeNote } from '../public/validation.js';
export { ValidationError } from '../public/validation.js';

const maxMoney = 1000000000000n;
function fail(message) { throw new ValidationError(message); }

// 只接受產品與規格識別，金額一律來自伺服器菜單，並以 BigInt 計算。
export function quoteOrder(input, selectedCatalog = catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('訂單格式不正確');
  if (input.menuRelease !== selectedCatalog.release) fail('菜單版本不正確，請重新載入');
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) fail('請選擇商品，最多 100 筆明細');
  let total = 0n;
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('商品明細格式不正確');
    const customerNote = normalizeNote(item.customerNote), internalNote = normalizeNote(item.internalNote);
    const product = selectedCatalog.products.find(p => p.id === item.productId);
    const variant = product?.variants.find(v => v.id === item.variantId);
    if (!product || !variant) fail('商品或容量不存在');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) fail('杯數須為 1 至 100 的整數');
    if (!Array.isArray(item.toppings) || item.toppings.length > product.toppings.length) fail('配料格式不正確');
    const seen = new Set();
    let unitPrice = BigInt(variant.price);
    const toppings = item.toppings.map(selection => {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)) fail('配料格式不正確');
      const topping = product.toppings.find(t => t.id === selection.id);
      if (!topping || seen.has(selection.id)) fail('配料不存在或重複');
      seen.add(selection.id);
      if (!Number.isInteger(selection.portions) || selection.portions < 1 || selection.portions > topping.maxPortions) fail('配料份數超出範圍');
      unitPrice += BigInt(topping.price) * BigInt(selection.portions);
      return { id: topping.id, nameZh: topping.nameZh, nameVi: topping.nameVi, unit: topping.unit, portions: selection.portions, price: topping.price };
    });
    const groups = product.optionGroups ?? [];
    const selections = item.options === undefined ? [] : item.options;
    if (!Array.isArray(selections) || selections.length > groups.length) fail('選項格式不正確');
    const selectedGroups = new Map();
    for (const selection of selections) {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)) fail('選項格式不正確');
      const group = groups.find(g => g.id === selection.groupId);
      if (!group || selectedGroups.has(selection.groupId)) fail('選項群組不存在或重複');
      if (!Array.isArray(selection.valueIds) || selection.valueIds.length > group.maxSelect) fail('選項數量不正確');
      const seenValues = new Set();
      const values = selection.valueIds.map(valueId => {
        const value = group.values.find(v => v.id === valueId);
        if (!value || seenValues.has(valueId)) fail('選項不存在或重複');
        seenValues.add(valueId);
        return { id: value.id, nameZh: value.nameZh, nameVi: value.nameVi };
      });
      selectedGroups.set(group.id, { groupId: group.id, nameZh: group.nameZh, nameVi: group.nameVi, values });
    }
    for (const group of groups) {
      const count = selectedGroups.get(group.id)?.values.length ?? 0;
      if (count < group.minSelect || count > group.maxSelect) fail('選項數量不正確');
    }
    const options = [...selectedGroups.values()];
    const lineTotal = unitPrice * BigInt(item.quantity);
    total += lineTotal;
    if (total > maxMoney) fail('訂單金額超出上限');
    return { productId: product.id, variantId: variant.id, nameZh: product.nameZh, nameVi: product.nameVi, variant: variant.label, quantity: item.quantity, toppings, options, customerNote, internalNote, unitPrice: String(unitPrice), lineTotal: String(lineTotal) };
  });
  return { menuRelease: selectedCatalog.release, currency: 'VND', items, subtotal: String(total), total: String(total) };
}
