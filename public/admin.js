const $ = (selector, parent = document) => parent.querySelector(selector);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const state = { token: '', revision: null, catalog: null, dirty: false, busy: false, epoch: 0, userId: null, loginName: '' };
class StaleResponse extends Error {}
// randomUUID 僅在安全環境可用；getRandomValues 在區網 HTTP 也可使用。
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
function message(text, success = false) { $('#message').textContent = text; $('#message').classList.toggle('success', success); }
function controls() {
  $('#editor').inert = state.busy || !state.token;
  document.querySelectorAll('#access-form button, #access-form input').forEach(node => { node.disabled = state.busy; });
  $('#login-name').readOnly = Boolean(state.catalog);
  $('#publish').disabled = state.dirty || state.busy || !state.token;
  $('#save').disabled = state.busy || !state.token;
}
function dirty(value = true) { state.dirty = value; $('#dirty-status').textContent = value ? '有尚未儲存的變更' : '草稿已儲存'; controls(); }
function busy(value) { state.busy = value; controls(); }
async function api(path, method = 'GET', body, token = state.token, epoch = state.epoch) {
  let response, result;
  try {
    response = await fetch(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    result = await response.json();
  } catch (error) { if (epoch !== state.epoch) throw new StaleResponse(); throw error; }
  if (epoch !== state.epoch) throw new StaleResponse();
  if (!response.ok) { const error = new Error(result.error?.message || '操作失敗，請檢查設定與服務狀態。'); error.status = response.status; throw error; }
  return result.data;
}
function actionError(error) {
  if (error instanceof StaleResponse) return;
  if (error.status === 401) {
    state.epoch++; state.token = ''; state.busy = false;
    $('#editor').hidden = true; $('#signed-in').hidden = true;
    $('#login-submit').hidden = false; $('#logout').hidden = false;
    $('#login-submit').textContent = '重新登入並保留草稿';
    $('#login-name').value = state.loginName;
    controls();
    message('登入已失效。草稿已保留在本頁，請使用同一帳號重新登入，再重試原操作。');
  } else message(error.message);
}
function field(label, value, binding, type = 'text') { return `<label>${label}<input type="${type}" ${type === 'number' ? 'min="0" max="100" step="1"' : ''} value="${html(value)}" data-bind="${html(binding)}"></label>`; }
function render() {
  $('#revision').textContent = `草稿版本 ${state.revision}`;
  $('#category-list').innerHTML = state.catalog.categories.length ? state.catalog.categories.map((c, i) => `<div class="category-row">${field('中文名稱', c.nameZh, `c.${i}.nameZh`)}${field('越文名稱', c.nameVi, `c.${i}.nameVi`)}<button class="danger" type="button" data-action="remove-category" data-i="${i}">移除</button></div>`).join('') : '<p class="empty-hint">尚無分類，請先新增分類。</p>';
  $('#product-list').innerHTML = state.catalog.products.length ? state.catalog.products.map((p, i) => {
    const options = state.catalog.categories.map(c => `<option value="${html(c.id)}" ${c.id === p.categoryId ? 'selected' : ''}>${html(c.nameZh || '未命名分類')}</option>`).join('');
    const variants = p.variants.map((v, j) => `<div class="detail-row">${field('容量或規格', v.label, `v.${i}.${j}.label`)}${field('完整售價（VND）', v.price, `v.${i}.${j}.price`)}<button class="danger" type="button" data-action="remove-variant" data-i="${i}" data-j="${j}">移除</button></div>`).join('');
    const toppings = p.toppings.map((t, j) => `<div class="detail-row topping-fields">${field('中文名稱', t.nameZh, `t.${i}.${j}.nameZh`)}${field('越文名稱', t.nameVi, `t.${i}.${j}.nameVi`)}${field('單位', t.unit, `t.${i}.${j}.unit`)}${field('售價（VND）', t.price, `t.${i}.${j}.price`)}${field('上限', t.maxPortions, `t.${i}.${j}.maxPortions`, 'number')}<button class="danger" type="button" data-action="remove-topping" data-i="${i}" data-j="${j}">移除</button></div>`).join('');
    const groups = (p.optionGroups || []).map((g, j) => {
      const values = g.values.map((v, k) => `<div class="detail-row option-value">${field('選項中文', v.nameZh, `o.${i}.${j}.${k}.nameZh`)}${field('選項越文', v.nameVi, `o.${i}.${j}.${k}.nameVi`)}<label class="default-option"><input type="checkbox" data-default="${i}.${j}.${k}" ${(g.defaultValueIds || []).includes(v.id) ? 'checked' : ''}> 預設選項</label><button class="danger" type="button" data-action="remove-option" data-i="${i}" data-j="${j}" data-k="${k}">移除</button></div>`).join('');
      return `<div class="option-editor"><div class="subheading"><strong>選項群組</strong><button class="danger" type="button" data-action="remove-group" data-i="${i}" data-j="${j}">移除群組</button></div><div class="group-fields">${field('群組中文（例如甜度）', g.nameZh, `g.${i}.${j}.nameZh`)}${field('群組越文', g.nameVi, `g.${i}.${j}.nameVi`)}${field('最少選擇數', g.minSelect, `g.${i}.${j}.minSelect`, 'number')}${field('最多選擇數', g.maxSelect, `g.${i}.${j}.maxSelect`, 'number')}</div>${values}<button class="secondary" type="button" data-action="add-option" data-i="${i}" data-j="${j}">新增選項</button></div>`;
    }).join('');
    return `<article class="product-card"><div class="card-heading"><h3>${html(p.nameZh || '新商品')}</h3><button class="danger" type="button" data-action="remove-product" data-i="${i}">移除商品</button></div><div class="fields">${field('中文名稱', p.nameZh, `p.${i}.nameZh`)}${field('越文名稱', p.nameVi, `p.${i}.nameVi`)}<label>分類<select data-bind="p.${i}.categoryId">${options}</select></label></div><div class="subheading"><h4>容量與售價</h4><button class="secondary" type="button" data-action="add-variant" data-i="${i}">新增容量</button></div>${variants || '<p class="empty-hint">至少需要一個容量。</p>'}<div class="subheading"><h4>可選配料</h4><button class="secondary" type="button" data-action="add-topping" data-i="${i}">新增配料</button></div>${toppings || '<p class="empty-hint">此商品未設定配料。</p>'}<div class="subheading"><h4>甜度、冰量等選項</h4><button class="secondary" type="button" data-action="add-group" data-i="${i}">新增選項群組</button></div><p class="empty-hint">必選一項請將最少與最多選擇數都設為 1；預設選項不可超過最多選擇數，不足最少選擇數時點餐需補選。選項目前不加價。</p>${groups}</article>`;
  }).join('') : '<p class="empty-hint">尚無商品。</p>';
  $('#editor').hidden = false;
  dirty(state.dirty);
}
$('#access-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || state.token) return;
  const epoch = ++state.epoch;
  const resuming = Boolean(state.catalog);
  busy(true); message('正在登入⋯');
  let newToken = '';
  try {
    if (!window.isSecureContext) {
      const config = await api('/api/v1/auth/config', 'GET', undefined, '', epoch);
      if (config.allowInsecureHttp !== true) throw new Error('伺服器尚未啟用區網 HTTP 測試登入，請設定 AUTH_TRANSPORT_MODE=lan-development 或使用 HTTPS。');
    }
    const session = await api('/api/v1/sessions', 'POST', { loginName: $('#login-name').value, password: $('#password').value }, '', epoch);
    newToken = session.token;
    if (!session.user.canManageCatalog) throw new Error('沒有商品管理權限');
    if (resuming && session.user.id !== state.userId) throw new Error('請使用原帳號重新登入，以恢復草稿。');
    if (!resuming) {
      const data = await api('/api/v1/admin/catalog', 'GET', undefined, newToken, epoch);
      state.catalog = data.catalog; state.revision = data.revision; state.dirty = false;
    }
    state.token = newToken; state.userId = session.user.id; state.loginName = session.user.loginName;
    $('#signed-in').textContent = `目前登入：${session.user.displayName}`;
    $('#signed-in').hidden = false; $('#logout').hidden = false; $('#login-submit').hidden = true;
    render(); message(resuming ? '已重新登入，原草稿與版本已保留，請重試儲存或發布。' : '已登入並載入商品草稿。', true);
  } catch (error) {
    if (newToken) { try { await api('/api/v1/sessions/current', 'DELETE', undefined, newToken, epoch); } catch {} }
    if (epoch !== state.epoch) return;
    state.token = '';
    $('#editor').hidden = true; $('#signed-in').hidden = true;
    $('#login-submit').hidden = false; $('#logout').hidden = !state.catalog;
    message(error.message);
  } finally {
    if (epoch === state.epoch) { $('#password').value = ''; busy(false); }
  }
});
$('#logout').addEventListener('click', async () => {
  if (state.dirty && !confirm('尚有未儲存變更，登出會捨棄這些變更。繼續嗎？')) return;
  const token = state.token;
  const epoch = ++state.epoch; // Immediately invalidate every in-flight response.
  state.token = ''; state.catalog = null; state.dirty = false; state.userId = null; state.loginName = ''; state.revision = null;
  $('#category-list').innerHTML = ''; $('#product-list').innerHTML = ''; $('#password').value = '';
  $('#editor').hidden = true; $('#signed-in').hidden = true; $('#signed-in').textContent = '';
  $('#logout').hidden = true; $('#login-submit').hidden = false; $('#login-submit').textContent = '登入並載入草稿'; $('#revision').textContent = '尚未載入';
  busy(true);
  let remoteLogout = true;
  try { if (token) await api('/api/v1/sessions/current', 'DELETE', undefined, token, epoch); } catch { remoteLogout = false; }
  if (epoch !== state.epoch) return;
  message(remoteLogout ? '已登出。' : '本頁已登出，但無法確認伺服器登出；登入狀態會在到期後失效。', remoteLogout);
  busy(false);
});
$('#editor').addEventListener('input', event => {
  if (state.busy || !state.token) return;
  if (event.target.dataset.default !== undefined) {
    const [i, j, k] = event.target.dataset.default.split('.').map(Number);
    const group = state.catalog.products[i].optionGroups[j];
    const valueId = group.values[k].id;
    group.defaultValueIds = (group.defaultValueIds || []).filter(value => value !== valueId);
    if (event.target.checked) group.defaultValueIds.push(valueId);
    dirty();
    return;
  }
  const path = event.target.dataset.bind?.split('.'); if (!path) return;
  let object;
  if (path[0] === 'c') object = state.catalog.categories[Number(path[1])];
  if (path[0] === 'p') object = state.catalog.products[Number(path[1])];
  if (path[0] === 'v') object = state.catalog.products[Number(path[1])].variants[Number(path[2])];
  if (path[0] === 't') object = state.catalog.products[Number(path[1])].toppings[Number(path[2])];
  if (path[0] === 'g') object = state.catalog.products[Number(path[1])].optionGroups[Number(path[2])];
  if (path[0] === 'o') object = state.catalog.products[Number(path[1])].optionGroups[Number(path[2])].values[Number(path[3])];
  const key = path.at(-1);
  object[key] = ['maxPortions', 'minSelect', 'maxSelect'].includes(key) ? Number(event.target.value) : event.target.value;
  dirty();
});
$('#editor').addEventListener('click', event => {
  if (state.busy || !state.token) return;
  const button = event.target.closest('[data-action]'); if (!button) return;
  const i = Number(button.dataset.i), j = Number(button.dataset.j), k = Number(button.dataset.k), products = state.catalog.products, categories = state.catalog.categories;
  switch (button.dataset.action) {
    case 'add-category': categories.push({ id: id(), nameZh: '', nameVi: '' }); break;
    case 'remove-category': if (products.some(p => p.categoryId === categories[i].id)) { message('請先移動或移除這個分類下的商品。'); return; } categories.splice(i, 1); break;
    case 'add-product': if (!categories.length) { message('請先新增分類。'); return; } products.push({ id: id(), categoryId: categories[0].id, nameZh: '', nameVi: '', variants: [{ id: id(), label: '', price: '0' }], toppings: [] }); break;
    case 'remove-product': products.splice(i, 1); break;
    case 'add-variant': products[i].variants.push({ id: id(), label: '', price: '0' }); break;
    case 'remove-variant': products[i].variants.splice(j, 1); break;
    case 'add-topping': products[i].toppings.push({ id: id(), nameZh: '', nameVi: '', unit: '份', price: '0', maxPortions: 3 }); break;
    case 'remove-topping': products[i].toppings.splice(j, 1); break;
    case 'add-group': (products[i].optionGroups ||= []).push({ id: id(), nameZh: '', nameVi: '', minSelect: 1, maxSelect: 1, values: [{ id: id(), nameZh: '', nameVi: '' }] }); break;
    case 'remove-group': products[i].optionGroups.splice(j, 1); break;
    case 'add-option': products[i].optionGroups[j].values.push({ id: id(), nameZh: '', nameVi: '' }); break;
    case 'remove-option': {
      const group = products[i].optionGroups[j];
      const [removed] = group.values.splice(k, 1);
      if (group.defaultValueIds) group.defaultValueIds = group.defaultValueIds.filter(value => value !== removed.id);
      break;
    }
    default: return;
  }
  state.dirty = true; message(''); render();
});
$('#save').addEventListener('click', async () => {
  if (state.busy || !state.token) return;
  const epoch = state.epoch;
  busy(true); message('正在儲存草稿⋯');
  try { const data = await api('/api/v1/admin/catalog', 'PUT', { expectedRevision: state.revision, catalog: state.catalog }); state.catalog = data.catalog; state.revision = data.revision; state.dirty = false; render(); message('草稿已儲存，尚未發布。', true); }
  catch (error) { actionError(error); }
  finally { if (epoch === state.epoch) busy(false); }
});
$('#publish').addEventListener('click', async () => {
  if (state.dirty || state.busy || !state.token) return;
  const epoch = state.epoch;
  busy(true); message('正在發布菜單⋯');
  try { await api('/api/v1/admin/catalog/publish', 'POST', { expectedRevision: state.revision }); message('菜單已發布。重新整理點餐頁面即可載入。', true); }
  catch (error) { actionError(error); }
  finally { if (epoch === state.epoch) busy(false); }
});
window.addEventListener('beforeunload', event => { if (state.dirty) event.preventDefault(); });
