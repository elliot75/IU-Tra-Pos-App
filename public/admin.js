const $ = (selector, parent = document) => parent.querySelector(selector);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const state = { token: '', revision: null, catalog: null, dirty: false, busy: false };
const id = () => crypto.randomUUID();
function message(text, success = false) { $('#message').textContent = text; $('#message').classList.toggle('success', success); }
function dirty(value = true) { state.dirty = value; $('#dirty-status').textContent = value ? '有尚未儲存的變更' : '草稿已儲存'; $('#publish').disabled = value || state.busy; }
function busy(value) { state.busy = value; $('#editor').inert = value; $('#access-form button').disabled = value; $('#publish').disabled = value || state.dirty; }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || '操作失敗，請檢查設定與服務狀態。');
  return result.data;
}
function field(label, value, binding, type = 'text') { return `<label>${label}<input type="${type}" ${type === 'number' ? 'min="1" max="100" step="1"' : ''} value="${html(value)}" data-bind="${html(binding)}"></label>`; }
function render() {
  $('#revision').textContent = `草稿版本 ${state.revision}`;
  $('#category-list').innerHTML = state.catalog.categories.length ? state.catalog.categories.map((c, i) => `<div class="category-row">${field('中文名稱', c.nameZh, `c.${i}.nameZh`)}${field('越文名稱', c.nameVi, `c.${i}.nameVi`)}<button class="danger" type="button" data-action="remove-category" data-i="${i}">移除</button></div>`).join('') : '<p class="empty-hint">尚無分類，請先新增分類。</p>';
  $('#product-list').innerHTML = state.catalog.products.length ? state.catalog.products.map((p, i) => {
    const options = state.catalog.categories.map(c => `<option value="${html(c.id)}" ${c.id === p.categoryId ? 'selected' : ''}>${html(c.nameZh || '未命名分類')}</option>`).join('');
    const variants = p.variants.map((v, j) => `<div class="detail-row">${field('容量或規格', v.label, `v.${i}.${j}.label`)}${field('完整售價（VND）', v.price, `v.${i}.${j}.price`)}<button class="danger" type="button" data-action="remove-variant" data-i="${i}" data-j="${j}">移除</button></div>`).join('');
    const toppings = p.toppings.map((t, j) => `<div class="detail-row topping-fields">${field('中文名稱', t.nameZh, `t.${i}.${j}.nameZh`)}${field('越文名稱', t.nameVi, `t.${i}.${j}.nameVi`)}${field('單位', t.unit, `t.${i}.${j}.unit`)}${field('售價（VND）', t.price, `t.${i}.${j}.price`)}${field('上限', t.maxPortions, `t.${i}.${j}.maxPortions`, 'number')}<button class="danger" type="button" data-action="remove-topping" data-i="${i}" data-j="${j}">移除</button></div>`).join('');
    return `<article class="product-card"><div class="card-heading"><h3>${html(p.nameZh || '新商品')}</h3><button class="danger" type="button" data-action="remove-product" data-i="${i}">移除商品</button></div><div class="fields">${field('中文名稱', p.nameZh, `p.${i}.nameZh`)}${field('越文名稱', p.nameVi, `p.${i}.nameVi`)}<label>分類<select data-bind="p.${i}.categoryId">${options}</select></label></div><div class="subheading"><h4>容量與售價</h4><button class="secondary" type="button" data-action="add-variant" data-i="${i}">新增容量</button></div>${variants || '<p class="empty-hint">至少需要一個容量。</p>'}<div class="subheading"><h4>可選配料</h4><button class="secondary" type="button" data-action="add-topping" data-i="${i}">新增配料</button></div>${toppings || '<p class="empty-hint">此商品未設定配料。</p>'}</article>`;
  }).join('') : '<p class="empty-hint">尚無商品。</p>';
  $('#editor').hidden = false;
  dirty(state.dirty);
}
$('#access-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.dirty && !confirm('尚有未儲存變更，重新載入會捨棄這些變更。繼續嗎？')) return;
  state.token = $('#token').value;
  busy(true); message('正在載入草稿⋯');
  try { const data = await api('/api/v1/admin/catalog'); state.catalog = data.catalog; state.revision = data.revision; state.dirty = false; render(); message('已載入商品草稿。', true); }
  catch (error) { state.token = ''; state.catalog = null; state.dirty = false; $('#editor').hidden = true; $('#revision').textContent = '尚未載入'; message(error.message); }
  finally { busy(false); }
});
$('#editor').addEventListener('input', event => {
  const path = event.target.dataset.bind?.split('.'); if (!path) return;
  let object;
  if (path[0] === 'c') object = state.catalog.categories[Number(path[1])];
  if (path[0] === 'p') object = state.catalog.products[Number(path[1])];
  if (path[0] === 'v') object = state.catalog.products[Number(path[1])].variants[Number(path[2])];
  if (path[0] === 't') object = state.catalog.products[Number(path[1])].toppings[Number(path[2])];
  const key = path.at(-1);
  object[key] = key === 'maxPortions' ? Number(event.target.value) : event.target.value;
  dirty();
});
$('#editor').addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const i = Number(button.dataset.i), j = Number(button.dataset.j), products = state.catalog.products, categories = state.catalog.categories;
  switch (button.dataset.action) {
    case 'add-category': categories.push({ id: id(), nameZh: '', nameVi: '' }); break;
    case 'remove-category': if (products.some(p => p.categoryId === categories[i].id)) { message('請先移動或移除這個分類下的商品。'); return; } categories.splice(i, 1); break;
    case 'add-product': if (!categories.length) { message('請先新增分類。'); return; } products.push({ id: id(), categoryId: categories[0].id, nameZh: '', nameVi: '', variants: [{ id: id(), label: '', price: '0' }], toppings: [] }); break;
    case 'remove-product': products.splice(i, 1); break;
    case 'add-variant': products[i].variants.push({ id: id(), label: '', price: '0' }); break;
    case 'remove-variant': products[i].variants.splice(j, 1); break;
    case 'add-topping': products[i].toppings.push({ id: id(), nameZh: '', nameVi: '', unit: '份', price: '0', maxPortions: 3 }); break;
    case 'remove-topping': products[i].toppings.splice(j, 1); break;
    default: return;
  }
  state.dirty = true; message(''); render();
});
$('#save').addEventListener('click', async () => {
  busy(true); message('正在儲存草稿⋯');
  try { const data = await api('/api/v1/admin/catalog', 'PUT', { expectedRevision: state.revision, catalog: state.catalog }); state.catalog = data.catalog; state.revision = data.revision; state.dirty = false; render(); message('草稿已儲存，尚未發布。', true); }
  catch (error) { message(error.message); }
  finally { busy(false); }
});
$('#publish').addEventListener('click', async () => {
  if (state.dirty) return;
  busy(true); message('正在發布菜單⋯');
  try { await api('/api/v1/admin/catalog/publish', 'POST', { expectedRevision: state.revision }); message('菜單已發布。重新整理點餐頁面即可載入。', true); }
  catch (error) { message(error.message); }
  finally { busy(false); }
});
window.addEventListener('beforeunload', event => { if (state.dirty) event.preventDefault(); });
