import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from '../src/catalog.js';
import { validateCatalog, expandCatalog } from '../src/catalog-validation.js';

test('商品圖片接受可選的 HTTPS 網址，拒絕不安全的網址', () => {
  const data = structuredClone({ categories: catalog.categories, products: catalog.products });
  for (const imageUrl of [undefined, '', 'https://images.example.com/tea.jpg?version=1', `/catalog-images/${'a'.repeat(64)}.jpg`]) {
    if (imageUrl === undefined) delete data.products[0].imageUrl; else data.products[0].imageUrl = imageUrl;
    assert.doesNotThrow(() => validateCatalog(data, { publishing: true }));
  }
  for (const imageUrl of [null, 123, 'http://example.com/a.jpg', 'javascript:alert(1)', 'https://user:password@example.com/a', 'https://example.com/a b', '//example.com/a', '/catalog-images/../secret.jpg', `/catalog-images/${'a'.repeat(64)}.svg`, `/catalog-images/${'a'.repeat(64)}.jpg?x=1`]) {
    data.products[0].imageUrl = imageUrl;
    assert.throws(() => validateCatalog(data));
  }
});

test('預設選項可省略或部分設定，且必須唯一、屬於群組並符合上限', () => {
  const data = structuredClone({ categories: catalog.categories, products: catalog.products });
  data.products[0].optionGroups = [{ id: 'ice', nameZh: '冰量', nameVi: 'Đá', minSelect: 2, maxSelect: 2, values: [
    { id: 'less', nameZh: '少冰', nameVi: 'Ít đá' }, { id: 'normal', nameZh: '正常冰', nameVi: 'Đá' }
  ] }];
  const group = data.products[0].optionGroups[0];
  for (const defaults of [undefined, [], ['less'], ['less', 'normal']]) {
    if (defaults === undefined) delete group.defaultValueIds; else group.defaultValueIds = defaults;
    assert.doesNotThrow(() => validateCatalog(data, { publishing: true }));
  }
  for (const defaults of [null, 'less', ['missing'], ['less', 'less'], ['less', 'normal', 'missing'], [3]]) {
    group.defaultValueIds = defaults;
    assert.throws(() => validateCatalog(data));
  }
  group.defaultValueIds = ['less', 'normal']; group.minSelect = 1; group.maxSelect = 1;
  assert.throws(() => validateCatalog(data));
});


const menu = () => structuredClone({ categories: catalog.categories, products: catalog.products });
const optionGroup = (id, extra = {}) => ({ id, nameZh: id, nameVi: id, minSelect: 0, maxSelect: 1,
  values: [{ id: 'a', nameZh: '甲', nameVi: 'A' }, { id: 'b', nameZh: '乙', nameVi: 'B' }], ...extra });

test('舊扁平菜單相容，供應狀態僅接受布林值並在發布補上預設', () => {
  const data = menu(); delete data.products[0].optionGroups;
  const expanded = expandCatalog(data, { publishing: true });
  for (const value of [expanded.products[0], ...expanded.products[0].variants, ...expanded.products[0].toppings]) {
    assert.equal(value.active, true); assert.equal(value.soldOut, false);
  }
  assert.equal('active' in data.products[0], false, '不修改草稿');
  assert.equal('optionGroups' in expanded.products[0], false, '維持無群組舊格式');
  for (const path of [x => x.products[0], x => x.products[0].variants[0], x => x.products[0].toppings[0]]) {
    for (const key of ['active', 'soldOut']) {
      for (const invalid of [undefined, null, 0, 1, 'false', {}, []]) {
        const changed = menu(); path(changed)[key] = invalid;
        assert.throws(() => validateCatalog(changed));
      }
      for (const valid of [true, false]) {
        const changed = menu(); path(changed)[key] = valid;
        assert.equal(path(expandCatalog(changed))[key], valid);
        assert.doesNotThrow(() => validateCatalog(changed));
      }
    }
  }
});

test('群組類型由 kind 決定，糖冰不可複選，舊名稱不推斷類型', () => {
  for (const kind of [undefined, 'general', 'sugar', 'ice']) {
    const data = menu(); const group = optionGroup('g', { nameZh: '冰量', maxSelect: 2 });
    if (kind !== undefined) group.kind = kind;
    data.products[0].optionGroups = [group];
    if (kind === 'sugar' || kind === 'ice') {
      assert.throws(() => validateCatalog(data));
      group.maxSelect = 1;
      assert.doesNotThrow(() => validateCatalog(data));
      group.defaultValueIds = ['a', 'b'];
      assert.throws(() => validateCatalog(data));
    } else assert.doesNotThrow(() => validateCatalog(data));
  }
  for (const invalid of [null, '', 'Sugar', '甜度', 1]) {
    const data = menu(); data.products[0].optionGroups = [optionGroup('g', { kind: invalid })];
    assert.throws(() => validateCatalog(data));
  }
});

test('分類範本依序展開、完整覆寫、排除與單品追加，發布不洩漏範本關係', () => {
  const data = menu();
  data.optionGroups = [optionGroup('ice', { kind: 'ice' }), optionGroup('sugar', { kind: 'sugar' }), optionGroup('extra')];
  data.categories[0].optionGroupIds = ['sugar', 'ice', 'extra'];
  data.products[0].excludedOptionGroupIds = ['extra'];
  data.products[0].optionGroups = [optionGroup('local'), optionGroup('ice', { kind: 'ice', nameZh: '單品冰量', defaultValueIds: ['b'] })];
  const result = expandCatalog(data, { publishing: true });
  assert.deepEqual(result.products[0].optionGroups.map(g => g.id), ['sugar', 'ice', 'local']);
  assert.equal(result.products[0].optionGroups[1].nameZh, '單品冰量');
  assert.deepEqual(result.products[0].optionGroups[1].defaultValueIds, ['b']);
  assert.equal('optionGroups' in result, false);
  assert.equal('optionGroupIds' in result.categories[0], false);
  assert.equal('excludedOptionGroupIds' in result.products[0], false);
  assert.equal(result.products[0].optionGroups[2].kind, 'general');
  assert.doesNotThrow(() => validateCatalog(result, { publishing: true }));
  data.optionGroups[1].values[0].nameZh = '稍後改名';
  data.products[0].optionGroups[1].defaultValueIds.push('a');
  assert.equal(result.products[0].optionGroups[0].values[0].nameZh, '甲');
  assert.deepEqual(result.products[0].optionGroups[1].defaultValueIds, ['b']);
});

test('拒絕範本關係衝突、錯誤覆寫、展開上限及各層未知欄位', () => {
  const base = menu(); base.optionGroups = [optionGroup('shared')];
  base.categories[0].optionGroupIds = ['shared']; base.products[0].optionGroups = [];
  const cases = [
    x => x.optionGroups.push(optionGroup('shared')),
    x => x.categories[0].optionGroupIds = ['missing'],
    x => x.categories[0].optionGroupIds = ['shared', 'shared'],
    x => x.categories[0].optionGroupIds = null,
    x => x.products[0].excludedOptionGroupIds = ['missing'],
    x => x.products[0].excludedOptionGroupIds = ['shared', 'shared'],
    x => { x.products[0].excludedOptionGroupIds = ['shared']; x.products[0].optionGroups = [optionGroup('shared')]; },
    x => x.products[0].optionGroups = [{ id: 'shared', maxSelect: 1 }],
    x => x.products[0].optionGroups = [optionGroup('shared', { minSelect: 2, maxSelect: 1 })],
    x => x.products[0].optionGroups = [optionGroup('shared', { defaultValueIds: ['missing'] })],
    x => x.products[0].optionGroups = [optionGroup('shared', { defaultValueIds: ['a', 'a'] })],
    x => x.products[0].optionGroups = Array.from({ length: 50 }, (_, i) => optionGroup(`local-${i}`)),
    x => x.optionGroups[0].unexpected = true,
    x => x.categories[0].active = true,
    x => x.products[0].variants[0].unexpected = true,
    x => x.products[0].toppings[0].unexpected = true,
    x => x.unexpected = true
  ];
  for (const change of cases) {
    const invalid = structuredClone(base); change(invalid);
    assert.throws(() => expandCatalog(invalid, { publishing: true }));
  }
  const replaced = structuredClone(base);
  replaced.products[0].optionGroups = [optionGroup('shared', { values: [{ id: 'new', nameZh: '新值', nameVi: 'New' }] })];
  assert.deepEqual(expandCatalog(replaced).products[0].optionGroups[0].values.map(v => v.id), ['new'], '覆寫不混入範本的值與預設');
});
