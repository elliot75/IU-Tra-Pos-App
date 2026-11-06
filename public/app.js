import { DISPLAY_CHANNEL, DISPLAY_TIMEOUT, DISPLAY_HEARTBEAT, displayId, isDisplayId } from './display-protocol.js';
import { normalizeNote, quoteBody } from './validation.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const money = value => `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} ₫`;
const state = { catalog: null, items: [], product: null, quantity: 1, portions: [], revision: 0, editing: null };
const dialog = $('#product-dialog');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);

// Fresh per page load, never persisted: old displays must not follow a refreshed main page.
// The session is also the explicit pairing destination; it is not authentication.
const displaySession = displayId();
$('#open-display').href = `/display#pair=${displaySession}`;
const displayChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DISPLAY_CHANNEL) : null;
const displayRequests = new Map();
let displayProjection = { phase: 'standby' };
let displayRevision = 0;
let displayAckAt = 0;
let displayMode = 'view';
const customerOperations = new Map();
let customerOperationPending = false;
$('#display-mode').value = displayMode;
$('#display-mode').addEventListener('change', event => {
  displayMode = event.target.value === 'touch' ? 'touch' : 'view';
  displayRevision++; displayAckAt = 0; sendDisplaySnapshot(); updateDisplayStatus();
});
let projectedCatalogSource = null, projectedCatalog = null;
function publicCatalog() {
  if (!state.catalog) return null;
  if (projectedCatalogSource === state.catalog) return projectedCatalog;
  projectedCatalogSource = state.catalog;
  projectedCatalog = {
    release: state.catalog.release,
    categories: state.catalog.categories.map(({ id, nameZh, nameVi }) => ({ id, nameZh, nameVi })),
    products: state.catalog.products.map(({ id, categoryId, nameZh, nameVi, imageUrl, variants, toppings, optionGroups }) => ({
      id, categoryId, nameZh, nameVi, ...(imageUrl ? { imageUrl } : {}),
      variants: variants.map(({ id, label, price }) => ({ id, label, price })),
      toppings: toppings.map(({ id, nameZh, nameVi, unit, price, maxPortions }) => ({ id, nameZh, nameVi, unit, price, maxPortions })),
      optionGroups: (optionGroups || []).map(({ id, nameZh, nameVi, minSelect, maxSelect, values, defaultValueIds }) => ({ id, nameZh, nameVi, minSelect, maxSelect, values: values.map(({ id, nameZh, nameVi }) => ({ id, nameZh, nameVi })), ...(defaultValueIds ? { defaultValueIds } : {}) }))
    }))
  };
  return projectedCatalog;
}
function updateDisplayStatus() {
  $('#display-status').textContent = !displayChannel ? '此瀏覽器不支援客顯連線' : Date.now() - displayAckAt < DISPLAY_TIMEOUT ? '客顯已連線' : '客顯未連線';
}
function connectedDisplay(nonce) {
  const connection = displayRequests.get(nonce);
  return connection && Date.now() - connection.seen < DISPLAY_TIMEOUT;
}
function pruneDisplays() {
  for (const nonce of displayRequests.keys()) if (!connectedDisplay(nonce)) displayRequests.delete(nonce);
}
function sendDisplaySnapshot(targetNonce) {
  if (!displayChannel) return;
  pruneDisplays();
  for (const [nonce, connection] of displayRequests) {
    if (targetNonce && nonce !== targetNonce) continue;
    const envelope = { pair: displaySession, nonce, session: displaySession, revision: displayRevision };
    if (connection.revision === displayRevision) {
      displayChannel.postMessage({ type: 'heartbeat', ...envelope });
      continue;
    }
    const menu = displayMode === 'touch' && state.catalog ? {
      catalogRelease: state.catalog.release,
      ...(connection.catalogRelease !== state.catalog.release ? { catalog: publicCatalog() } : {})
    } : {};
    displayChannel.postMessage({ type: 'snapshot', ...envelope, mode: displayMode, ...menu, ...displayProjection });
  }
}
if (displayChannel) displayChannel.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object' || data.pair !== displaySession || !isDisplayId(data.nonce)) return;
  if (data.type === 'request') {
    pruneDisplays();
    if (!displayRequests.has(data.nonce) && displayRequests.size >= 20) return;
    const connection = displayRequests.get(data.nonce) || { revision: -1, catalogRelease: null };
    connection.seen = Date.now();
    displayRequests.set(data.nonce, connection);
    sendDisplaySnapshot(data.nonce);
  } else if (data.type === 'add-item') {
    void addCustomerItem(data);
  } else if (data.type === 'ack' && data.session === displaySession && data.revision === displayRevision && connectedDisplay(data.nonce)) {
    const connection = displayRequests.get(data.nonce);
    connection.revision = data.revision;
    connection.catalogRelease = displayMode === 'touch' && data.catalogRelease === state.catalog?.release ? data.catalogRelease : null;
    displayAckAt = Date.now(); updateDisplayStatus();
  }
};
setInterval(() => { sendDisplaySnapshot(); updateDisplayStatus(); }, DISPLAY_HEARTBEAT);
updateDisplayStatus();
function projectQuote(quote) {
  return { phase: 'order', items: quote.items.map(item => ({
    name: item.nameZh, variant: item.variant, quantity: item.quantity, customerNote: item.customerNote || '',
    options: (item.options || []).map(group => ({ name: group.nameZh, values: group.values.map(value => value.nameZh) })),
    toppings: item.toppings.map(topping => ({ name: topping.nameZh, portions: topping.portions }))
  })), total: String(quote.total) };
}

function customerItem(input) {
  const ident = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ident(input.productId) || !ident(input.variantId) ||
      !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100 ||
      !Array.isArray(input.toppings) || input.toppings.length > 50 || !Array.isArray(input.options) || input.options.length > 50 ||
      typeof input.customerNote !== 'string' || input.customerNote.length > 200 || /[\u0000-\u001f\u007f]/.test(input.customerNote)) throw new Error('商品資料不正確');
  const toppings = input.toppings.map(t => {
    if (!t || !ident(t.id) || !Number.isInteger(t.portions) || t.portions < 1 || t.portions > 100) throw new Error('配料資料不正確');
    return { id: t.id, portions: t.portions };
  });
  const options = input.options.map(g => {
    if (!g || !ident(g.groupId) || !Array.isArray(g.valueIds) || g.valueIds.length > 50 || !g.valueIds.every(ident)) throw new Error('選項資料不正確');
    return { groupId: g.groupId, valueIds: [...g.valueIds] };
  });
  return { productId: input.productId, variantId: input.variantId, quantity: input.quantity, toppings, options, customerNote: normalizeNote(input.customerNote), internalNote: '' };
}
async function addCustomerItem(data) {
  if (data.session !== displaySession || !isDisplayId(data.operationId) || !connectedDisplay(data.nonce)) return;
  const reply = (ok, message) => displayChannel.postMessage({ type: 'add-result', pair: displaySession, nonce: data.nonce, session: displaySession, operationId: data.operationId, ok, message });
  let item;
  try { item = customerItem(data.item); } catch (error) { reply(false, error.message); return; }
  const fingerprint = JSON.stringify({ revision: data.revision, item });
  const previous = customerOperations.get(data.operationId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) reply(false, '此操作識別已用於其他內容');
    else if (previous.result) reply(previous.result.ok, previous.result.message);
    return;
  }
  // A successful add advances displayRevision. Evicted requests still carry their
  // original revision and cannot commit again. Never evict an in-flight operation.
  for (const [id, operation] of customerOperations) {
    if (operation.result && (operation.revision !== displayRevision || customerOperations.size >= 1000)) customerOperations.delete(id);
  }
  const operation = { fingerprint, revision: data.revision, result: null };
  customerOperations.set(data.operationId, operation);
  const finish = (ok, message) => { operation.result = { ok, message }; reply(ok, message); };
  if (displayMode !== 'touch' || !state.catalog || data.revision !== displayRevision || displayProjection.phase === 'calculating' || displayProjection.phase === 'unavailable') { finish(false, '畫面狀態已變更，請重新確認'); return; }
  if (customerOperationPending || state.items.length >= 100) { finish(false, '目前無法加入商品，請稍後再試'); return; }
  customerOperationPending = true;
  const originalRevision = displayRevision;
  const originalCatalog = state.catalog;
  try {
    const quote = await request('/api/v1/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: quoteBody(originalCatalog.release, [...state.items, item]) });
    if (displayMode !== 'touch' || displayRevision !== originalRevision || state.catalog !== originalCatalog || !connectedDisplay(data.nonce)) { finish(false, '訂單已變更，請重新確認'); return; }
    state.items.push(item);
    state.revision++;
    showQuote(quote);
    finish(true, '已加入訂單');
  } catch (error) { finish(false, error.message || '無法驗證商品，請重試'); }
  finally { customerOperationPending = false; }
}
async function request(url, options) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('連線逾時，請稍後重試'));
      controller.abort();
    }, 10000);
  });
  try {
    // Include reading the response body in the deadline. The race also settles
    // if a transport fails to honor abort; its late result cannot mutate orders.
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error?.message || '無法完成操作'); error.status = response.status; throw error; }
      return result.data;
    })()]);
  } finally { clearTimeout(timer); }
}
$('#products').addEventListener('error', event => {
  if (event.target.tagName === 'IMG') event.target.hidden = true;
}, true);
function showProducts(category) {
  const products = state.catalog.products.filter(p => !category || p.categoryId === category);
  $('#products').innerHTML = products.length ? products.map(p => `<button type="button" class="product" data-product="${escapeHtml(p.id)}"><span class="product-art"><span class="cup"></span>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span><span class="product-info"><strong>${escapeHtml(p.nameZh)}</strong><small>${escapeHtml(p.nameVi)}</small><span class="product-price">${money(p.variants.reduce((a, b) => BigInt(a.price) < BigInt(b.price) ? a : b).price)} 起 <span class="plus">＋</span></span></span></button>`).join('') : '<p>此分類目前沒有商品。</p>';
}
function showCatalog(catalog) {
  state.catalog = catalog;
  state.items = [];
  $('#catalog-status').textContent = catalog.isExample ? '示範模式' : '已發布菜單';
  $('#menu-tag').textContent = catalog.isExample ? '示範菜單' : '已發布菜單';
  $('#notice').textContent = catalog.isExample ? '目前使用規格書範例資料，訂單不會儲存，也不能收款。' : '訂單目前不會儲存，也不能收款。';
  $('#categories').innerHTML = '<button class="category active" type="button">全部品項</button>' + catalog.categories.map(c => `<button class="category" type="button" data-category="${escapeHtml(c.id)}">${escapeHtml(c.nameZh)} <span>${escapeHtml(c.nameVi)}</span></button>`).join('');
  showProducts(); renderOrder();
}
function openProduct(id, editIndex = null) {
  if (state.editing?.saving) return;
  const product = state.catalog.products.find(p => p.id === id);
  const item = editIndex === null ? null : state.items[editIndex];
  if (!product || (editIndex !== null && (!item || item.productId !== id))) return;
  state.product = product;
  state.editing = item ? { index: editIndex, item, revision: state.revision } : null;
  state.quantity = item?.quantity ?? 1;
  state.portions = product.toppings.map(t => item?.toppings.find(selected => selected.id === t.id)?.portions ?? 0);
  $('#dialog-title').textContent = product.nameZh;
  $('#dialog-subtitle').textContent = product.nameVi;
  $('.add-button', dialog).textContent = item ? '儲存修改' : '加入訂單';
  $('#variants').innerHTML = product.variants.map((v, i) => `<label class="variant"><span><input name="variant" type="radio" value="${escapeHtml(v.id)}" ${(item ? item.variantId === v.id : i === 0) ? 'checked' : ''}> ${escapeHtml(v.label)}</span><strong>${money(v.price)}</strong></label>`).join('');
  $('#product-error').textContent = '';
  $('#customer-note').value = item?.customerNote || ''; $('#internal-note').value = item?.internalNote || '';
  $('#option-groups').innerHTML = (product.optionGroups || []).map((g, i) => {
    const single = g.maxSelect === 1;
    const selected = item ? (item.options.find(option => option.groupId === g.id)?.valueIds || []) : (g.defaultValueIds || []);
    const none = single && g.minSelect === 0 ? `<label class="option-choice"><input type="radio" name="option-group-${i}" value="" ${selected.length ? '' : 'checked'}> 不選</label>` : '';
    const choices = g.values.map(v => `<label class="option-choice"><input type="${single ? 'radio' : 'checkbox'}" ${single ? `name="option-group-${i}"` : ''} data-option-group="${i}" value="${escapeHtml(v.id)}" ${selected.includes(v.id) ? 'checked' : ''} ${g.maxSelect === 0 ? 'disabled' : ''}> ${escapeHtml(v.nameZh)} <span>${escapeHtml(v.nameVi)}</span></label>`).join('');
    return `<fieldset><legend>${escapeHtml(g.nameZh)} <small>${g.minSelect ? `至少選 ${g.minSelect} 項` : '可不選'}，最多 ${g.maxSelect} 項</small></legend><div class="option-choices">${none}${choices}</div></fieldset>`;
  }).join('');
  $('#toppings').innerHTML = product.toppings.length ? product.toppings.map((t, i) => `<div class="topping-row"><span>${escapeHtml(t.nameZh)}<small>${money(t.price)} / ${escapeHtml(t.unit)}，最多 ${t.maxPortions} 份</small></span><div class="stepper"><button type="button" data-topping-index="${i}" data-change="-1" aria-label="減少${escapeHtml(t.nameZh)}">−</button><output data-portions="${i}">${state.portions[i]}</output><button type="button" data-topping-index="${i}" data-change="1" aria-label="增加${escapeHtml(t.nameZh)}">＋</button></div></div>`).join('') : '<p class="subtext">此商品沒有配料選項。</p>';
  $('#quantity').textContent = String(state.quantity);
  dialog.showModal();
}
function showQuote(quote) {
  displayProjection = projectQuote(quote);
  displayRevision++; displayAckAt = 0;
  sendDisplaySnapshot(); updateDisplayStatus();
  $('#item-count').textContent = `${state.items.reduce((sum, item) => sum + item.quantity, 0)} 杯`;
  $('#order-items').innerHTML = quote.items.map((item, index) => `<div class="order-item"><div class="item-top"><span class="item-name">${escapeHtml(item.nameZh)}</span><strong>${money(item.lineTotal)}</strong></div><p class="item-detail">${escapeHtml(item.variant)} × ${item.quantity} 杯${(item.options || []).map(g => `<br>${escapeHtml(g.nameZh)}：${g.values.map(v => escapeHtml(v.nameZh)).join('、')}`).join('')}${item.toppings.map(t => `<br>${escapeHtml(t.nameZh)} × ${t.portions} 份 / 杯`).join('')}${item.customerNote ? `<br>顧客備註：${escapeHtml(item.customerNote)}` : ''}${item.internalNote ? `<br>內部備註：${escapeHtml(item.internalNote)}` : ''}</p><div class="item-bottom"><small>每杯 ${money(item.unitPrice)}</small><div class="item-actions"><button type="button" data-edit="${index}">修改</button><button type="button" data-copy="${index}">複製</button><button class="remove" type="button" data-remove="${index}">移除</button></div></div></div>`).join('');
  $('#subtotal').textContent = money(quote.subtotal);
  $('#total').textContent = money(quote.total);
  $('#order-error').textContent = '';
}
async function renderOrder() {
  const revision = ++state.revision;
  displayAckAt = 0;
  displayRevision++;
  displayProjection = { phase: state.items.length ? 'calculating' : 'standby' };
  sendDisplaySnapshot(); updateDisplayStatus();
  const itemsElement = $('#order-items');
  $('#item-count').textContent = `${state.items.reduce((sum, item) => sum + item.quantity, 0)} 杯`;
  if (!state.items.length) {
    itemsElement.innerHTML = '<div class="empty"><span class="empty-icon">＋</span><strong>還沒有選擇飲品</strong>從菜單選擇商品，開始點餐。</div>';
    $('#subtotal').textContent = $('#total').textContent = money(0);
    $('#order-error').textContent = '';
    return;
  }
  itemsElement.innerHTML = '<p>正在計算目前訂單⋯</p>';
  $('#subtotal').textContent = $('#total').textContent = '—';
  try {
    const quote = await request('/api/v1/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: quoteBody(state.catalog.release, state.items) });
    if (revision !== state.revision) return;
    showQuote(quote);
  } catch (error) {
    if (revision !== state.revision) return;
    displayProjection = { phase: 'unavailable' };
    displayRevision++; displayAckAt = 0;
    sendDisplaySnapshot(); updateDisplayStatus();
    itemsElement.innerHTML = '<p>無法計算目前訂單，可移除明細後重試。</p>' + state.items.map((item, index) => {
      const product = state.catalog.products?.find(p => p.id === item.productId);
      return `<div class="order-item"><strong>${escapeHtml(product?.nameZh || item.productId || '商品')} × ${item.quantity} 杯</strong><button class="remove" type="button" data-remove="${index}">移除</button></div>`;
    }).join('') + '<button class="remove" type="button" data-clear>清除訂單</button>';
    $('#subtotal').textContent = $('#total').textContent = '—';
    $('#order-error').textContent = error.message;
  }
}
$('#products').addEventListener('click', async event => {
  const product = event.target.closest('[data-product]');
  if (product) openProduct(product.dataset.product);
  if (event.target.closest('[data-example]')) {
    try { showCatalog(await request('/api/v1/catalog/example')); }
    catch (error) { $('#products').textContent = error.message; }
  }
});
$('#categories').addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; document.querySelectorAll('.category').forEach(b => b.classList.toggle('active', b === button)); showProducts(button.dataset.category); });
$('.close', dialog).addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => {
  if (state.editing?.saving) event.preventDefault();
});
dialog.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button?.dataset.quantity) { state.quantity = Math.max(1, Math.min(100, state.quantity + Number(button.dataset.quantity))); $('#quantity').textContent = state.quantity; }
  if (button?.dataset.toppingIndex !== undefined) {
    const index = Number(button.dataset.toppingIndex);
    state.portions[index] = Math.max(0, Math.min(state.product.toppings[index].maxPortions, state.portions[index] + Number(button.dataset.change)));
    $(`[data-portions="${index}"]`, dialog).textContent = state.portions[index];
  }
});
$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const editing = state.editing;
  if (editing?.saving) return;
  if (editing && (editing.revision !== state.revision || state.items[editing.index] !== editing.item)) {
    $('#product-error').textContent = '訂單已變更，請關閉後重新選擇明細。';
    return;
  }
  if (!editing && state.items.length >= 100) { $('#order-error').textContent = '最多可加入 100 筆明細'; dialog.close(); return; }
  const options = [];
  for (const [index, group] of (state.product.optionGroups || []).entries()) {
    const valueIds = [...dialog.querySelectorAll(`[data-option-group="${index}"]:checked`)].map(input => input.value);
    if (valueIds.length < group.minSelect || valueIds.length > group.maxSelect) {
      $('#product-error').textContent = `「${group.nameZh}」請選擇 ${group.minSelect} 至 ${group.maxSelect} 項。`;
      return;
    }
    if (valueIds.length) options.push({ groupId: group.id, valueIds });
  }
  try {
    const variant = $('input[name="variant"]:checked', dialog);
    if (!variant || !state.product.variants.some(v => v.id === variant.value)) throw new Error('請選擇商品規格');
    const item = { productId: state.product.id, variantId: variant.value, quantity: state.quantity, toppings: state.product.toppings.flatMap((t, index) => state.portions[index] ? [{ id: t.id, portions: state.portions[index] }] : []), options, customerNote: normalizeNote($('#customer-note').value), internalNote: normalizeNote($('#internal-note').value) };
    const items = [...state.items];
    if (editing) items[editing.index] = item; else items.push(item);
    const body = quoteBody(state.catalog.release, items);
    if (editing) {
      const catalog = state.catalog;
      const controls = [...dialog.querySelectorAll('input, button')].map(control => [control, control.disabled]);
      editing.saving = true;
      for (const [control] of controls) control.disabled = true;
      $('#product-error').textContent = '正在確認修改，請稍候⋯';
      try {
        const quote = await request('/api/v1/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (state.catalog !== catalog || state.revision !== editing.revision || state.items[editing.index] !== editing.item || state.editing !== editing) {
          throw new Error('訂單已變更，請關閉後重新選擇明細。');
        }
        state.items = items;
        state.revision++;
        showQuote(quote);
      } finally {
        editing.saving = false;
        for (const [control, disabled] of controls) control.disabled = disabled;
      }
    } else {
      state.items = items;
      void renderOrder();
    }
    state.editing = null;
    dialog.close();
  } catch (error) { $('#product-error').textContent = error.message; }
});
$('#order-items').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit]');
  if (edit) {
    const index = Number(edit.dataset.edit), item = state.items[index];
    if (item) openProduct(item.productId, index);
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const item = state.items[Number(copy.dataset.copy)];
    if (!item) return;
    if (state.items.length >= 100) { $('#order-error').textContent = '最多可加入 100 筆明細'; return; }
    const duplicate = { ...item, toppings: item.toppings.map(t => ({ ...t })), options: item.options.map(group => ({ ...group, valueIds: [...group.valueIds] })) };
    try { quoteBody(state.catalog.release, [...state.items, duplicate]); }
    catch (error) { $('#order-error').textContent = error.message; return; }
    state.items = [...state.items, duplicate];
  } else {
    const button = event.target.closest('[data-remove]');
    if (button) state.items.splice(Number(button.dataset.remove), 1);
    else if (event.target.closest('[data-clear]')) state.items = [];
    else return;
  }
  void renderOrder();
});
try { showCatalog(await request('/api/v1/catalog/published')); }
catch (error) {
  $('#catalog-status').textContent = '菜單未載入';
  $('#menu-tag').textContent = '尚無可用菜單';
  $('#products').innerHTML = `<div class="catalog-empty"><p>${escapeHtml(error.status === 404 ? '目前尚未發布菜單。請先至商品管理建立並發布。' : '無法取得已發布菜單，請檢查資料庫與服務狀態。')}</p><button class="category" type="button" data-example>使用示範菜單</button></div>`;
  renderOrder();
}
