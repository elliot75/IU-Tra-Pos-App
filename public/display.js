import { DISPLAY_CHANNEL, DISPLAY_TIMEOUT, DISPLAY_HEARTBEAT, displayId, isDisplayId, displayPairFromHash } from './display-protocol.js';

const element = id => document.getElementById(id);
// Pin the source for this page's lifetime, including timeout and visibility reconnects.
const pair = displayPairFromHash(location.hash);
const channel = pair && typeof BroadcastChannel === 'function' ? new BroadcastChannel(DISPLAY_CHANNEL) : null;
let nonce;
let session = null;
let revision = -1;
let lastSnapshot = 0;

function standby(message = '等待店員開始點餐') {
  element('heading').textContent = '歡迎光臨';
  element('message').textContent = message;
  element('items').replaceChildren();
  element('amount').hidden = true;
  element('total').textContent = '';
}
function reconnect() {
  nonce = displayId(); session = null; revision = -1; lastSnapshot = 0;
  standby(!pair ? '請由主畫面開啟客顯' : channel ? '等待指定主畫面連線；若主畫面已重新整理，請由主畫面重新開啟客顯' : '此瀏覽器不支援客顯連線');
  requestSnapshot();
}
function requestSnapshot() { if (channel) channel.postMessage({ type: 'request', pair, nonce }); }
const text = value => typeof value === 'string' && value.length <= 500;
const count = value => Number.isSafeInteger(value) && value > 0 && value <= 100;
function validOrder(data) {
  return Array.isArray(data.items) && data.items.length > 0 && data.items.length <= 100 &&
    typeof data.total === 'string' && /^\d{1,30}$/.test(data.total) && data.items.every(item =>
      item && text(item.name) && text(item.variant) && count(item.quantity) &&
      Array.isArray(item.options) && item.options.length <= 100 && item.options.every(group =>
        group && text(group.name) && Array.isArray(group.values) && group.values.length <= 100 && group.values.every(text)) &&
      Array.isArray(item.toppings) && item.toppings.length <= 100 && item.toppings.every(topping =>
        topping && text(topping.name) && count(topping.portions)));
}
function render(data) {
  if (data.phase !== 'order') {
    standby(data.phase === 'calculating' ? '正在計算訂單' : data.phase === 'unavailable' ? '目前無法計算訂單，請洽店員' : '等待店員開始點餐');
    return;
  }
  element('heading').textContent = '您的點餐';
  element('message').textContent = '請確認品項與規格';
  const rows = data.items.map(item => {
    const row = document.createElement('div'); row.className = 'item';
    const title = document.createElement('div'); title.className = 'item-title';
    const name = document.createElement('span'); name.textContent = item.name;
    const quantity = document.createElement('span'); quantity.textContent = `${item.quantity} 杯`;
    title.append(name, quantity);
    const detail = document.createElement('p'); detail.className = 'item-detail';
    detail.textContent = [item.variant, ...item.options.map(group => `${group.name}：${group.values.join('、')}`), ...item.toppings.map(topping => `${topping.name} × ${topping.portions} 份 / 杯`)].join(' · ');
    row.append(title, detail); return row;
  });
  element('items').replaceChildren(...rows);
  element('total').textContent = `${new Intl.NumberFormat('vi-VN').format(BigInt(data.total))} ₫`;
  element('amount').hidden = false;
}
if (channel) channel.onmessage = ({ data }) => {
  // Pair selects the source, nonce scopes the connection attempt. Neither authenticates scripts.
  if (!data || typeof data !== 'object' || data.type !== 'snapshot' || data.pair !== pair ||
      data.nonce !== nonce || !isDisplayId(data.session) || data.session !== pair ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !['standby', 'calculating', 'unavailable', 'order'].includes(data.phase) ||
      (data.phase === 'order' && !validOrder(data))) return;
  if (lastSnapshot && Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) { reconnect(); return; }
  if (session && (data.session !== session || data.revision < revision)) return;
  const changed = data.session !== session || data.revision !== revision;
  session = data.session; revision = data.revision; lastSnapshot = Date.now();
  if (changed) render(data);
  channel.postMessage({ type: 'ack', pair, nonce, session, revision });
};
setInterval(() => {
  if (lastSnapshot && Date.now() - lastSnapshot >= DISPLAY_TIMEOUT) reconnect();
  else requestSnapshot();
}, DISPLAY_HEARTBEAT);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });
reconnect();
