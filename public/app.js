const $ = (selector, parent = document) => parent.querySelector(selector);
const money = value => `${new Intl.NumberFormat('vi-VN').format(BigInt(value))} ₫`;
const state = { catalog: null, items: [], product: null, quantity: 1, portions: [], revision: 0 };
const dialog = $('#product-dialog');
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);

async function request(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message || '無法完成操作'); error.status = response.status; throw error; }
  return result.data;
}
function showProducts(category) {
  const products = state.catalog.products.filter(p => !category || p.categoryId === category);
  $('#products').innerHTML = products.length ? products.map(p => `<button type="button" class="product" data-product="${escapeHtml(p.id)}"><span class="product-art"><span class="cup"></span></span><span class="product-info"><strong>${escapeHtml(p.nameZh)}</strong><small>${escapeHtml(p.nameVi)}</small><span class="product-price">${money(p.variants.reduce((a, b) => BigInt(a.price) < BigInt(b.price) ? a : b).price)} 起 <span class="plus">＋</span></span></span></button>`).join('') : '<p>此分類目前沒有商品。</p>';
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
function openProduct(id) {
  const product = state.catalog.products.find(p => p.id === id);
  if (!product) return;
  state.product = product; state.quantity = 1; state.portions = product.toppings.map(() => 0);
  $('#dialog-title').textContent = product.nameZh;
  $('#dialog-subtitle').textContent = product.nameVi;
  $('#variants').innerHTML = product.variants.map((v, i) => `<label class="variant"><span><input name="variant" type="radio" value="${escapeHtml(v.id)}" ${i === 0 ? 'checked' : ''}> ${escapeHtml(v.label)}</span><strong>${money(v.price)}</strong></label>`).join('');
  $('#toppings').innerHTML = product.toppings.length ? product.toppings.map((t, i) => `<div class="topping-row"><span>${escapeHtml(t.nameZh)}<small>${money(t.price)} / ${escapeHtml(t.unit)}，最多 ${t.maxPortions} 份</small></span><div class="stepper"><button type="button" data-topping-index="${i}" data-change="-1" aria-label="減少${escapeHtml(t.nameZh)}">−</button><output data-portions="${i}">0</output><button type="button" data-topping-index="${i}" data-change="1" aria-label="增加${escapeHtml(t.nameZh)}">＋</button></div></div>`).join('') : '<p class="subtext">此商品沒有配料選項。</p>';
  $('#quantity').textContent = '1';
  dialog.showModal();
}
async function renderOrder() {
  const revision = ++state.revision;
  const itemsElement = $('#order-items');
  $('#item-count').textContent = `${state.items.reduce((sum, item) => sum + item.quantity, 0)} 杯`;
  if (!state.items.length) {
    itemsElement.innerHTML = '<div class="empty"><span class="empty-icon">＋</span><strong>還沒有選擇飲品</strong>從菜單選擇商品，開始點餐。</div>';
    $('#subtotal').textContent = $('#total').textContent = money(0);
    $('#order-error').textContent = '';
    return;
  }
  try {
    const quote = await request('/api/v1/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ menuRelease: state.catalog.release, items: state.items }) });
    if (revision !== state.revision) return;
    itemsElement.innerHTML = quote.items.map((item, index) => `<div class="order-item"><div class="item-top"><span class="item-name">${escapeHtml(item.nameZh)}</span><strong>${money(item.lineTotal)}</strong></div><p class="item-detail">${escapeHtml(item.variant)} × ${item.quantity} 杯${item.toppings.map(t => `<br>${escapeHtml(t.nameZh)} × ${t.portions} 份 / 杯`).join('')}</p><div class="item-bottom"><small>每杯 ${money(item.unitPrice)}</small><button class="remove" type="button" data-remove="${index}">移除</button></div></div>`).join('');
    $('#subtotal').textContent = money(quote.subtotal);
    $('#total').textContent = money(quote.total);
    $('#order-error').textContent = '';
  } catch (error) {
    if (revision !== state.revision) return;
    itemsElement.innerHTML = '<p>無法計算目前訂單。若菜單已更新，請重新載入頁面並重新點餐。</p><button class="remove" type="button" data-clear>清除訂單</button>';
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
dialog.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button?.dataset.quantity) { state.quantity = Math.max(1, Math.min(100, state.quantity + Number(button.dataset.quantity))); $('#quantity').textContent = state.quantity; }
  if (button?.dataset.toppingIndex !== undefined) {
    const index = Number(button.dataset.toppingIndex);
    state.portions[index] = Math.max(0, Math.min(state.product.toppings[index].maxPortions, state.portions[index] + Number(button.dataset.change)));
    $(`[data-portions="${index}"]`, dialog).textContent = state.portions[index];
  }
});
$('#product-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state.items.length >= 100) { $('#order-error').textContent = '最多可加入 100 筆明細'; dialog.close(); return; }
  state.items.push({ productId: state.product.id, variantId: $('input[name="variant"]:checked', dialog).value, quantity: state.quantity, toppings: state.product.toppings.flatMap((t, index) => state.portions[index] ? [{ id: t.id, portions: state.portions[index] }] : []) });
  dialog.close(); renderOrder();
});
$('#order-items').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (button) state.items.splice(Number(button.dataset.remove), 1);
  else if (event.target.closest('[data-clear]')) state.items = [];
  else return;
  renderOrder();
});
try { showCatalog(await request('/api/v1/catalog/published')); }
catch (error) {
  $('#catalog-status').textContent = '菜單未載入';
  $('#menu-tag').textContent = '尚無可用菜單';
  $('#products').innerHTML = `<div class="catalog-empty"><p>${escapeHtml(error.status === 404 ? '目前尚未發布菜單。請先至商品管理建立並發布。' : '無法取得已發布菜單，請檢查資料庫與服務狀態。')}</p><button class="category" type="button" data-example>使用示範菜單</button></div>`;
  renderOrder();
}
