import { ValidationError } from './validation.js';

const MAX_MONEY = 1000000000000n;
const fail = message => { throw new ValidationError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, label, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(`${label}格式不正確`);
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
const availabilityFields = ['active', 'soldOut'];
function availability(value) {
  for (const key of availabilityFields) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') fail('啟用及售罄狀態須為布林值');
}
export const isActive = value => !!value && value.active !== false;
export const isAvailable = value => isActive(value) && value.soldOut !== true;
export const optionMaxSelect = group => ['sugar', 'ice'].includes(group.kind) ? Math.min(1, group.maxSelect) : group.maxSelect;
export const productAvailable = product => isAvailable(product) && product.variants.some(isAvailable);

function validateGroups(groups) {
  list(groups, 50, '選項群組');
  const ids = new Set();
  for (const group of groups) {
    fields(group, ['id', 'nameZh', 'nameVi', 'minSelect', 'maxSelect', 'values'], '選項群組', ['defaultValueIds', 'kind']);
    id(group.id); unique(ids, group.id);
    if (Object.hasOwn(group, 'kind') && !['general', 'sugar', 'ice'].includes(group.kind)) fail('選項群組類型不正確');
    text(group.nameZh, '群組中文名稱'); text(group.nameVi, '群組越文名稱');
    list(group.values, 50, '選項');
    if (!group.values.length || !Number.isInteger(group.minSelect) || !Number.isInteger(group.maxSelect) || group.minSelect < 0 || group.minSelect > group.maxSelect || group.maxSelect > group.values.length || group.maxSelect !== optionMaxSelect(group)) fail('選項數量限制不正確；糖與冰最多選一項');
    const values = new Set();
    for (const value of group.values) {
      fields(value, ['id', 'nameZh', 'nameVi'], '選項');
      id(value.id); unique(values, value.id);
      text(value.nameZh, '選項中文名稱'); text(value.nameVi, '選項越文名稱');
    }
    if (Object.hasOwn(group, 'defaultValueIds')) {
      list(group.defaultValueIds, group.maxSelect, '預設選項');
      const defaults = new Set();
      for (const valueId of group.defaultValueIds) {
        id(valueId); unique(defaults, valueId);
        if (!values.has(valueId)) fail('預設選項不屬於此群組');
      }
      // Partial defaults are intentional: the order UI still enforces minSelect.
    }
  }
}
function references(value, label) {
  list(value, 50, label);
  const ids = new Set();
  for (const valueId of value) { id(valueId); unique(ids, valueId); }
  return ids;
}

// Deterministic expansion: inherit in category.optionGroupIds order, remove exclusions,
// replace inherited groups in place by a complete product group with the same ID,
// then append product-only groups in product order. Exclude+override is an error.
// Overrides are complete groups, never partial field merges; unused templates stay private.
function effectiveGroups(product, category, templates) {
  const inherited = category.optionGroupIds ?? [];
  const excluded = new Set(product.excludedOptionGroupIds ?? []);
  const overrides = new Map((product.optionGroups ?? []).map(group => [group.id, group]));
  for (const groupId of excluded) {
    if (!inherited.includes(groupId)) fail('只能排除目前分類套用的選項群組');
    if (overrides.has(groupId)) fail('同一選項群組不能同時排除與覆寫');
  }
  const groups = inherited.filter(groupId => !excluded.has(groupId)).map(groupId => overrides.get(groupId) ?? templates.get(groupId));
  groups.push(...(product.optionGroups ?? []).filter(group => !inherited.includes(group.id)));
  return groups;
}
export function validateCatalog(catalog, { publishing = false } = {}) {
  fields(catalog, ['categories', 'products'], '菜單', ['optionGroups']);
  list(catalog.categories, 100, '分類');
  list(catalog.products, 500, '商品');
  if (publishing && (!catalog.categories.length || !catalog.products.length)) fail('發布菜單須包含分類及商品');
  if (Object.hasOwn(catalog, 'optionGroups')) validateGroups(catalog.optionGroups);
  const templates = new Map((catalog.optionGroups ?? []).map(group => [group.id, group]));
  const categories = new Map(), products = new Set(), variants = new Set();
  for (const category of catalog.categories) {
    fields(category, ['id', 'nameZh', 'nameVi'], '分類', ['optionGroupIds']);
    id(category.id);
    if (categories.has(category.id)) fail('識別碼重複');
    categories.set(category.id, category);
    text(category.nameZh, '分類中文名稱'); text(category.nameVi, '分類越文名稱');
    if (Object.hasOwn(category, 'optionGroupIds')) {
      for (const groupId of references(category.optionGroupIds, '分類選項群組')) if (!templates.has(groupId)) fail('分類選項群組範本不存在');
    }
  }
  for (const product of catalog.products) {
    fields(product, ['id', 'categoryId', 'nameZh', 'nameVi', 'variants', 'toppings'], '商品', ['optionGroups', 'imageUrl', 'excludedOptionGroupIds', ...availabilityFields]);
    availability(product);
    if (Object.hasOwn(product, 'imageUrl') && product.imageUrl !== '') {
      if (typeof product.imageUrl !== 'string' || product.imageUrl.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(product.imageUrl)) fail('圖片網址不正確');
      if (!/^\/catalog-images\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(product.imageUrl)) {
        let url;
        try { url = new URL(product.imageUrl); } catch { fail('圖片網址不正確'); }
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail('圖片網址須為 HTTPS 網址或本機商品圖片');
      }
    }
    id(product.id); unique(products, product.id); id(product.categoryId);
    if (!categories.has(product.categoryId)) fail('商品分類不存在');
    text(product.nameZh, '商品中文名稱'); text(product.nameVi, '商品越文名稱');
    list(product.variants, 50, '規格'); list(product.toppings, 50, '配料');
    if (!product.variants.length) fail('商品須有至少一個規格');
    for (const variant of product.variants) {
      fields(variant, ['id', 'label', 'price'], '規格', availabilityFields);
      availability(variant);
      id(variant.id); unique(variants, variant.id); text(variant.label, '規格名稱'); money(variant.price);
    }
    if (Object.hasOwn(product, 'optionGroups')) validateGroups(product.optionGroups);
    if (Object.hasOwn(product, 'excludedOptionGroupIds')) references(product.excludedOptionGroupIds, '排除選項群組');
    validateGroups(effectiveGroups(product, categories.get(product.categoryId), templates));
    const toppings = new Set();
    for (const topping of product.toppings) {
      fields(topping, ['id', 'nameZh', 'nameVi', 'unit', 'price', 'maxPortions'], '配料', availabilityFields);
      availability(topping);
      id(topping.id); unique(toppings, topping.id);
      text(topping.nameZh, '配料中文名稱'); text(topping.nameVi, '配料越文名稱'); text(topping.unit, '配料單位'); money(topping.price);
      if (!Number.isInteger(topping.maxPortions) || topping.maxPortions < 1 || topping.maxPortions > 100) fail('配料份數上限須為 1 至 100 的整數');
    }
  }
  return catalog;
}

// Published menus contain only effective groups and explicit legacy availability defaults.
// Always clone: releases must not share arrays/objects with the editable draft.
export function expandCatalog(catalog, options = {}) {
  validateCatalog(catalog, options);
  const templates = new Map((catalog.optionGroups ?? []).map(group => [group.id, group]));
  const categories = new Map(catalog.categories.map(category => [category.id, category]));
  const flags = value => ({ ...value, active: value.active ?? true, soldOut: value.soldOut ?? false });
  return structuredClone({
    categories: catalog.categories.map(({ optionGroupIds, ...category }) => category),
    products: catalog.products.map(({ excludedOptionGroupIds, ...product }) => ({
      ...flags(product),
      variants: product.variants.map(flags), toppings: product.toppings.map(flags),
      ...((product.optionGroups !== undefined || categories.get(product.categoryId).optionGroupIds?.length) ? {
        optionGroups: effectiveGroups({ ...product, excludedOptionGroupIds }, categories.get(product.categoryId), templates).map(group => ({ ...group, kind: group.kind ?? 'general' }))
      } : {})
    }))
  });
}
