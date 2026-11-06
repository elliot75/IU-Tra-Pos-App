import { ValidationError } from './pricing.js';

const MAX_MONEY = 1000000000000n;
const fail = message => { throw new ValidationError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, keys, label) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`${label}格式不正確`);
}
function text(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}不正確`);
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail('識別碼不正確');
}
function money(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,12})$/.test(value) || BigInt(value) > MAX_MONEY) fail('金額須為上限內的非負整數字串');
}
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}數量不正確`);
}
function unique(set, value) {
  if (set.has(value)) fail('識別碼重複');
  set.add(value);
}
export function validateCatalog(catalog, { publishing = false } = {}) {
  fields(catalog, ['categories', 'products'], '菜單');
  list(catalog.categories, 100, '分類');
  list(catalog.products, 500, '商品');
  if (publishing && (!catalog.categories.length || !catalog.products.length)) fail('發布菜單須包含分類及商品');
  const categories = new Set(), products = new Set(), variants = new Set();
  for (const category of catalog.categories) {
    fields(category, ['id', 'nameZh', 'nameVi'], '分類');
    id(category.id); unique(categories, category.id);
    text(category.nameZh, '分類中文名稱'); text(category.nameVi, '分類越文名稱');
  }
  for (const product of catalog.products) {
    fields(product, ['id', 'categoryId', 'nameZh', 'nameVi', 'variants', 'toppings', ...(Object.hasOwn(product ?? {}, 'optionGroups') ? ['optionGroups'] : [])], '商品');
    id(product.id); unique(products, product.id); id(product.categoryId);
    if (!categories.has(product.categoryId)) fail('商品分類不存在');
    text(product.nameZh, '商品中文名稱'); text(product.nameVi, '商品越文名稱');
    list(product.variants, 50, '規格'); list(product.toppings, 50, '配料');
    if (!product.variants.length) fail('商品須有至少一個規格');
    for (const variant of product.variants) {
      fields(variant, ['id', 'label', 'price'], '規格');
      id(variant.id); unique(variants, variant.id); text(variant.label, '規格名稱'); money(variant.price);
    }
    const groups = new Set();
    if (Object.hasOwn(product, 'optionGroups')) {
      list(product.optionGroups, 50, '選項群組');
      for (const group of product.optionGroups) {
        fields(group, ['id', 'nameZh', 'nameVi', 'minSelect', 'maxSelect', 'values'], '選項群組');
        id(group.id); unique(groups, group.id);
        text(group.nameZh, '群組中文名稱'); text(group.nameVi, '群組越文名稱');
        list(group.values, 50, '選項');
        if (!group.values.length || !Number.isInteger(group.minSelect) || !Number.isInteger(group.maxSelect) || group.minSelect < 0 || group.minSelect > group.maxSelect || group.maxSelect > group.values.length) fail('選項數量限制不正確');
        const values = new Set();
        for (const value of group.values) {
          fields(value, ['id', 'nameZh', 'nameVi'], '選項');
          id(value.id); unique(values, value.id);
          text(value.nameZh, '選項中文名稱'); text(value.nameVi, '選項越文名稱');
        }
      }
    }
    const toppings = new Set();
    for (const topping of product.toppings) {
      fields(topping, ['id', 'nameZh', 'nameVi', 'unit', 'price', 'maxPortions'], '配料');
      id(topping.id); unique(toppings, topping.id);
      text(topping.nameZh, '配料中文名稱'); text(topping.nameVi, '配料越文名稱'); text(topping.unit, '配料單位'); money(topping.price);
      if (!Number.isInteger(topping.maxPortions) || topping.maxPortions < 1 || topping.maxPortions > 100) fail('配料份數上限須為 1 至 100 的整數');
    }
  }
  return catalog;
}
export function validateRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > Number.MAX_SAFE_INTEGER) fail('版本號不正確');
}
