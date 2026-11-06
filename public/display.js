import { DISPLAY_CHANNEL, DISPLAY_TIMEOUT, DISPLAY_HEARTBEAT, displayId, isDisplayId, displayPairFromHash } from './display-protocol.js';
import { validateCatalog, isActive, isAvailable, productAvailable, optionMaxSelect } from './catalog-validation.js';
import { normalizeNote } from './validation.js';

const element = id => document.getElementById(id);
// Pin the source for this page's lifetime, including timeout and visibility reconnects.
const pair = displayPairFromHash(location.hash);
const channel = pair && typeof BroadcastChannel === 'function' ? new BroadcastChannel(DISPLAY_CHANNEL) : null;
let nonce;
let session = null;
let revision = -1;
let lastSnapshot = 0;
let mode = 'view', catalog = null, pending = null, selectedProduct = null, phase = 'standby';
let selectedCategory = null;
let paymentExpiresAt = 0;
const operationTimeout = 15000;

function standby(message = '等待店員開始點餐') {
  paymentExpiresAt = 0;
  element('heading').textContent = '歡迎光臨';
  element('message').textContent = message;
  element('items').replaceChildren();
  element('amount').hidden = true;
  element('total').textContent = '';
  element('payment-info').replaceChildren();
}
function reconnect() {
  nonce = displayId(); session = null; revision = -1; lastSnapshot = 0;
  mode = 'view'; catalog = null; element('touch-menu').hidden = true;
  if (element('touch-dialog').open) element('touch-dialog').close();
  if (pending) pending.uncertain = true;
  standby(!pair ? '請由主畫面開啟客顯' : channel ? '等待指定主畫面連線；若主畫面已重新整理，請由主畫面重新開啟客顯' : '此瀏覽器不支援客顯連線');
  requestSnapshot();
}
function requestSnapshot() { if (channel) channel.postMessage({ type: 'request', pair, nonce }); }
const text = value => typeof value === 'string' && value.length <= 500;
const count = value => Number.isSafeInteger(value) && value > 0 && value <= 100;
const amount = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const moneyFormatter = new Intl.NumberFormat('vi-VN');
const money = value => `${moneyFormatter.format(BigInt(value))} ₫`;
function validOrder(data) {
  return Array.isArray(data.items) && data.items.length > 0 && data.items.length <= 100 &&
    amount(data.total) && data.items.every(item =>
      item && text(item.name) && text(item.variant) && (item.customerNote === undefined || text(item.customerNote)) && count(item.quantity) &&
      ((item.unitPrice === undefined && item.lineTotal === undefined) ||
        (amount(item.unitPrice) && amount(item.lineTotal) && BigInt(item.unitPrice) * BigInt(item.quantity) === BigInt(item.lineTotal))) &&
      Array.isArray(item.options) && item.options.length <= 100 && item.options.every(group =>
        group && text(group.name) && Array.isArray(group.values) && group.values.length <= 100 && group.values.every(text)) &&
      Array.isArray(item.toppings) && item.toppings.length <= 100 && item.toppings.every(topping =>
        topping && text(topping.name) && count(topping.portions)));
}
function render(data) {
  paymentExpiresAt = 0;
  element('payment-info').replaceChildren();
  if (!['order','confirm','payment'].includes(data.phase)) {
    standby(data.phase === 'calculating' ? '正在計算訂單' : ['unavailable','exception'].includes(data.phase) ? '結果待核對，請洽店員；請勿再次付款' : '等待店員開始點餐');
    if (data.phase === 'completed') { element('heading').textContent = '付款完成'; element('message').textContent = `取餐號 ${typeof data.pickupNumber === 'string' ? data.pickupNumber.slice(0,20) : ''}`; }
    return;
  }
  element('heading').textContent = data.phase === 'payment' ? '等待付款' : data.phase === 'confirm' ? '核對訂單' : '您的點餐';
  element('message').textContent = data.phase === 'order' ? '請確認品項與規格' : '結帳中，請由店員操作';
  if (data.phase === 'payment') {
    const info = element('payment-info');
    info.append(make('p','',data.method === 'bank' ? '銀行轉帳，掃碼不代表已確認到帳' : data.method === 'wallet' ? '等待會員驗證與儲值扣款' : '請將現金交給店員'));
    const bank = data.bankSnapshot;
    paymentExpiresAt = data.method === 'bank' && Number.isFinite(Date.parse(data.expiresAt)) ? Date.parse(data.expiresAt) : 0;
    if (data.method === 'bank' && paymentExpiresAt > Date.now() && bank && text(bank.accountName) && /^\d{6}$/.test(bank.bankCode) && /^\d{6,34}$/.test(bank.accountNumber)) {
      info.append(make('p','',`${bank.accountName}　${bank.bankCode}　${bank.accountNumber}`));
      if (typeof data.qrDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]{1,100000}$/.test(data.qrDataUrl)) {
        const image = make('img'); image.alt = '目前訂單付款 QR'; image.src = data.qrDataUrl; image.className = 'payment-qr'; info.append(image);
      } else info.append(make('p','','付款碼尚未展示，請洽店員'));
    }
  }
  const rows = data.items.map(item => {
    const row = document.createElement('div'); row.className = 'item';
    const title = document.createElement('div'); title.className = 'item-title';
    const name = document.createElement('span'); name.textContent = item.name;
    const quantity = document.createElement('span'); quantity.textContent = `${item.quantity} 杯`;
    title.append(name, quantity);
    const detail = document.createElement('p'); detail.className = 'item-detail';
    detail.textContent = [item.variant, ...item.options.map(group => `${group.name}：${group.values.join('、')}`), ...item.toppings.map(topping => `${topping.name} × ${topping.portions} 份 / 杯`), ...(item.customerNote ? [`備註：${item.customerNote}`] : [])].join(' · ');
    row.append(title, detail);
    if (item.unitPrice !== undefined) {
      const prices = make('div', 'item-prices');
      const unitPrice = make('span', '', `每杯 ${money(item.unitPrice)}`);
      const lineTotal = make('strong', '', `小計 ${money(item.lineTotal)}`);
      prices.append(unitPrice, lineTotal); row.append(prices);
    }
    return row;
  });
  element('items').replaceChildren(...rows);
  element('total').textContent = money(data.total);
  element('amount').hidden = false;
}
// Build controls using textContent and DOM properties; the menu is supplied by the paired host.
const make = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
};
function validCatalog(menu) {
  if (!menu || !text(menu.release) || !menu.release || menu.release.length > 100) return false;
  try {
    validateCatalog({ categories: menu.categories, products: menu.products }, { publishing: true });
    return true;
  } catch { return false; }
}
function touchStatus(message) { element('touch-status').textContent = message; }
function renderMenu() {
  const visible = mode === 'touch' && !!catalog && !!lastSnapshot && ['order','standby'].includes(phase);
  element('touch-menu').hidden = !visible;
  if (!visible) return;
  if (!catalog.categories.some(c => c.id === selectedCategory)) selectedCategory = catalog.categories[0]?.id;
  const categories = catalog.categories.map(category => {
    const button = make('button', category.id === selectedCategory ? 'touch-category active' : 'touch-category', `${category.nameZh} ${category.nameVi}`);
    button.type = 'button'; button.disabled = !!pending || !['order','standby'].includes(phase);
    button.addEventListener('click', () => { selectedCategory = category.id; renderMenu(); });
    return button;
  });
  element('touch-categories').replaceChildren(...categories);
  const products = catalog.products.filter(p => isActive(p) && p.categoryId === selectedCategory).map(product => {
    const button = make('button', 'touch-product'); button.type = 'button'; button.disabled = !productAvailable(product) || !!pending || !['order','standby'].includes(phase);
    const variants = product.variants.filter(isAvailable);
    const min = variants.length ? variants.reduce((a, b) => BigInt(a.price) <= BigInt(b.price) ? a : b) : null;
    const art = make('span', 'touch-product-art');
    const fallback = make('span', 'touch-product-fallback', 'IUTRA'); art.append(fallback);
    if (typeof product.imageUrl === 'string' && (/^https:\/\//i.test(product.imageUrl) || /^\/catalog-images\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(product.imageUrl))) {
      try {
        const url = new URL(product.imageUrl, location.origin);
        if ((url.origin === location.origin && /^\/catalog-images\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(url.pathname)) || (url.protocol === 'https:' && url.hostname && !url.username && !url.password)) {
          const image = make('img'); image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
          image.addEventListener('error', () => image.remove()); image.src = url.href; art.append(image);
        }
      } catch { /* Keep the fallback for invalid image URLs. */ }
    }
    button.append(art, make('strong', '', product.nameZh), make('span', '', product.nameVi), make('b', '', productAvailable(product) ? `${money(min.price)} 起` : '售罄／暫停供應'));
    button.addEventListener('click', () => openProduct(product)); return button;
  });
  element('touch-products').replaceChildren(...(products.length ? products : [make('p', '', '此分類目前沒有商品。')]));
  touchStatus(pending ? (pending.uncertain ? '加入狀態待確認，請洽店員確認後重新開啟顧客畫面。' : '正在加入點餐，請稍候。') : '');
}
function openProduct(product) {
  if (!productAvailable(product) || pending || !['order','standby'].includes(phase) || mode !== 'touch' || !lastSnapshot || Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) return;
  selectedProduct = product;
  element('touch-title').textContent = product.nameZh; element('touch-subtitle').textContent = product.nameVi;
  element('touch-note').value = ''; element('touch-error').textContent = '';
  const fields = element('touch-fields'); fields.replaceChildren();
  const variants = make('fieldset'); variants.append(make('legend', '', '選擇容量'));
  const defaultVariant = product.variants.find(isAvailable)?.id;
  product.variants.forEach(variant => {
    if (!isActive(variant)) return;
    const label = make('label', 'touch-choice'); const input = make('input'); input.type = 'radio'; input.name = 'touch-variant'; input.value = variant.id; input.checked = variant.id === defaultVariant; input.disabled = !isAvailable(variant);
    label.append(input, make('span', '', `${variant.label}　${money(variant.price)}${isAvailable(variant) ? '' : '（售罄）'}`)); variants.append(label);
  }); fields.append(variants);
  (product.optionGroups || []).forEach((group, index) => {
    const field = make('fieldset'); field.append(make('legend', '', `${group.nameZh}：選 ${group.minSelect} 至 ${optionMaxSelect(group)} 項`));
    if (optionMaxSelect(group) === 1 && group.minSelect === 0) {
      const label = make('label', 'touch-choice'); const input = make('input'); input.type = 'radio'; input.name = `touch-group-${index}`; input.value = ''; input.checked = !(group.defaultValueIds || []).length;
      label.append(input, make('span', '', '不選')); field.append(label);
    }
    group.values.forEach(value => {
      const label = make('label', 'touch-choice'); const input = make('input'); input.type = optionMaxSelect(group) === 1 ? 'radio' : 'checkbox'; input.name = `touch-group-${index}`; input.value = value.id; input.checked = (group.defaultValueIds || []).includes(value.id); input.disabled = optionMaxSelect(group) === 0;
      input.addEventListener('change', () => {
        const checked = [...field.querySelectorAll('input')].filter(control => control.checked && control.value);
        if (checked.length > optionMaxSelect(group)) { input.checked = false; element('touch-error').textContent = `「${group.nameZh}」最多選 ${optionMaxSelect(group)} 項。`; }
        else element('touch-error').textContent = '';
      });
      label.append(input, make('span', '', `${value.nameZh} ${value.nameVi}`)); field.append(label);
    }); fields.append(field);
  });
  if (product.toppings.length) {
    const field = make('fieldset'); field.append(make('legend', '', '加點配料（每杯份數）'));
    product.toppings.forEach((topping, index) => {
      if (!isActive(topping)) return;
      const label = make('label', 'touch-number'); label.append(make('span', '', `${topping.nameZh} ${topping.nameVi}${isAvailable(topping) ? '' : '（售罄）'} · ${money(topping.price)} / ${topping.unit}（最多 ${topping.maxPortions}）`));
      const input = make('input'); input.type = 'number'; input.name = `touch-topping-${index}`; input.disabled = !isAvailable(topping); input.min = '0'; input.max = String(topping.maxPortions); input.step = '1'; input.value = '0'; input.inputMode = 'numeric'; label.append(input); field.append(label);
    }); fields.append(field);
  }
  const quantity = make('label', 'touch-number touch-quantity'); quantity.append(make('span', '', '杯數'));
  const input = make('input'); input.type = 'number'; input.name = 'touch-quantity'; input.min = '1'; input.max = '100'; input.step = '1'; input.value = '1'; input.inputMode = 'numeric'; quantity.append(input); fields.append(quantity);
  element('touch-dialog').showModal();
}
element('touch-close').addEventListener('click', () => element('touch-dialog').close());
element('touch-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pending || !['order','standby'].includes(phase) || mode !== 'touch' || !session || !lastSnapshot || Date.now() - lastSnapshot >= DISPLAY_TIMEOUT || !selectedProduct || !catalog?.products.includes(selectedProduct)) return;
  const form = element('touch-form'), product = selectedProduct;
  const variant = form.querySelector('input[name="touch-variant"]:checked');
  const quantity = Number(form.querySelector('input[name="touch-quantity"]').value);
  const error = message => { element('touch-error').textContent = message; };
  if (!productAvailable(product) || !variant || !product.variants.some(v => v.id === variant.value && isAvailable(v)) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return error('請選擇容量與 1 至 100 杯。');
  const options = [];
  for (const [index, group] of (product.optionGroups || []).entries()) {
    const valueIds = [...form.querySelectorAll(`input[name="touch-group-${index}"]:checked`)].map(input => input.value).filter(Boolean);
    if (valueIds.length < group.minSelect || valueIds.length > optionMaxSelect(group)) return error(`「${group.nameZh}」請選擇 ${group.minSelect} 至 ${optionMaxSelect(group)} 項。`);
    if (valueIds.length) options.push({ groupId: group.id, valueIds });
  }
  const toppings = [];
  for (const [index, topping] of product.toppings.entries()) {
    if (!isActive(topping)) continue;
    const raw = form.querySelector(`input[name="touch-topping-${index}"]`).value;
    const portions = Number(raw);
    if (raw === '' || !Number.isInteger(portions) || portions < 0 || portions > topping.maxPortions) return error(`「${topping.nameZh}」份數須為 0 至 ${topping.maxPortions}。`);
    if (portions && !isAvailable(topping)) return error('配料已停用或售罄');
    if (portions) toppings.push({ id: topping.id, portions });
  }
  let customerNote;
  try { customerNote = normalizeNote(element('touch-note').value); }
  catch (failure) { return error(failure.message); }
  const operationId = displayId();
  pending = { operationId, session, nonce, started: Date.now(), uncertain: false };
  channel.postMessage({ type: 'add-item', pair, nonce, session, revision, operationId, item: { productId: product.id, variantId: variant.value, quantity, toppings, options, customerNote } });
  element('touch-dialog').close(); renderMenu();
});
function acknowledge() {
  channel.postMessage({ type: 'ack', pair, nonce, session, revision, ...(mode === 'touch' && catalog ? { catalogRelease: catalog.release } : {}) });
}
if (channel) channel.onmessage = ({ data }) => {
  // Pair selects the source, nonce scopes the connection attempt. Neither authenticates scripts.
  if (data?.type === 'heartbeat') {
    if (!session || data.pair !== pair || data.nonce !== nonce || data.session !== session || data.revision !== revision) return;
    if (!lastSnapshot || Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) { reconnect(); return; }
    lastSnapshot = Date.now(); acknowledge();
    return;
  }
  if (data && data.type === 'add-result') {
    if (!pending || data.pair !== pair || data.nonce !== nonce || data.nonce !== pending.nonce || data.session !== session || data.session !== pending.session || data.operationId !== pending.operationId || typeof data.ok !== 'boolean' || (data.message !== undefined && !text(data.message))) return;
    if (!lastSnapshot || Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) { reconnect(); return; }
    pending = null; renderMenu(); touchStatus(data.ok ? (data.message || '已加入點餐。') : (data.message || '無法加入點餐，請再試一次或洽店員。'));
    return;
  }
  if (!data || typeof data !== 'object' || data.type !== 'snapshot' || data.pair !== pair ||
      data.nonce !== nonce || !isDisplayId(data.session) || data.session !== pair ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !['standby', 'calculating', 'unavailable', 'order', 'confirm', 'payment', 'completed', 'exception'].includes(data.phase) ||
      (data.mode !== undefined && !['view', 'touch'].includes(data.mode)) ||
      (data.mode === 'touch' && (data.catalog !== undefined
        ? !validCatalog(data.catalog) || data.catalogRelease !== data.catalog.release
        : !catalog || data.catalogRelease !== catalog.release)) ||
      (['order','confirm','payment'].includes(data.phase) && !validOrder(data)) ||
      (data.phase === 'payment' && !['cash','bank','wallet'].includes(data.method))) return;
  if (lastSnapshot && Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) { reconnect(); return; }
  if (session && (data.session !== session || data.revision < revision)) return;
  const changed = data.session !== session || data.revision !== revision;
  session = data.session; revision = data.revision; lastSnapshot = Date.now();
  if (changed) {
    mode = data.mode || 'view'; phase = data.phase; catalog = mode === 'touch' ? (data.catalog || catalog) : null;
    if (element('touch-dialog').open) element('touch-dialog').close();
    render(data); renderMenu();
  }
  acknowledge();
};
setInterval(() => {
  if (paymentExpiresAt && Date.now() >= paymentExpiresAt) { paymentExpiresAt = 0; element('payment-info').replaceChildren(make('p','','付款碼已到期，請洽店員核對；請勿重複付款')); }
  if (pending && !pending.uncertain && Date.now() - pending.started >= operationTimeout) { pending.uncertain = true; renderMenu(); }
  if (lastSnapshot && Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) reconnect();
  else requestSnapshot();
}, DISPLAY_HEARTBEAT);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!lastSnapshot || Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) reconnect();
  else requestSnapshot();
});
reconnect();
