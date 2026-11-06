// 規格書驗收範例，並非正式菜單。價格以 VND 整數字串表示。
export const catalog = Object.freeze({
  release: 'example-v1',
  isExample: true,
  categories: [{ id: 'tea', nameZh: '原茶', nameVi: 'Trà' }],
  products: [{
    id: 'oolong', categoryId: 'tea', nameZh: '烏龍茶', nameVi: 'Trà Ô Long',
    variants: [{ id: 'oolong-500', label: '500 ml', price: '22000' }, { id: 'oolong-700', label: '700 ml', price: '24000' }],
    toppings: [{ id: 'example-topping', nameZh: '示範配料', nameVi: 'Topping mẫu', unit: '份', price: '5000', maxPortions: 3 }],
    // Optional examples only; real imported groups require an explicit manager classification.
    optionGroups: [
      { id: 'example-sugar', kind: 'sugar', nameZh: '甜度（示範）', nameVi: 'Đường (mẫu)', minSelect: 0, maxSelect: 1, values: [
        { id: 'example-half-sugar', nameZh: '半糖', nameVi: 'Nửa đường' }, { id: 'example-normal-sugar', nameZh: '正常糖', nameVi: 'Đủ đường' }
      ] },
      { id: 'example-ice', kind: 'ice', nameZh: '冰量（示範）', nameVi: 'Đá (mẫu)', minSelect: 0, maxSelect: 1, values: [
        { id: 'example-less-ice', nameZh: '少冰', nameVi: 'Ít đá' }, { id: 'example-normal-ice', nameZh: '正常冰', nameVi: 'Đủ đá' }
      ] }
    ]
  }]
});
