import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog } from '../src/catalog.js';
import { validateCatalog } from '../src/catalog-validation.js';

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
