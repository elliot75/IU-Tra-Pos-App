import { createHash } from 'node:crypto';
import { ValidationError } from './pricing.js';
import { ServiceError } from './catalog-store.js';

export const MAX_MONEY = 1000000000000n;
export const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new ValidationError('識別碼必須為 UUID');
  return value.toLowerCase();
}
export function amount(value, { signed = false, positive = false } = {}) {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d{0,12})$/ : /^(0|[1-9]\d{0,12})$/).test(value)) throw new ValidationError('金額必須為整數 VND 字串');
  const n = BigInt(value);
  if (n > MAX_MONEY || n < (signed ? -MAX_MONEY : 0n) || (positive && n === 0n)) throw new ValidationError('金額超出允許範圍');
  return n;
}
export function text(value, max = 200, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError('文字為必填，且不可含控制字元或超過長度');
  return value.trim();
}
export function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) throw new ValidationError('版本不正確');
  return value;
}
export function fields(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(k => !Object.hasOwn(input,k)) || Object.keys(input).some(k => !required.includes(k) && !optional.includes(k))) throw new ValidationError('請求欄位不正確');
}
export function canonical(value, depth = 0) {
  if (depth > 32) throw new ValidationError('資料巢狀層數過多');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value,-0)) return JSON.stringify(value);
  if (!value || typeof value !== 'object') throw new ValidationError('資料必須為 JSON');
  if (Array.isArray(value)) return `[${value.map(v => canonical(v,depth+1)).join(',')}]`;
  if (![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new ValidationError('資料必須為 JSON');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k],depth+1)}`).join(',')}}`;
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function businessDate(date, timezone, cutoff) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  const local = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  if (Number(parts.hour)*60+Number(parts.minute)<cutoff) local.setUTCDate(local.getUTCDate()-1);
  return local.toISOString().slice(0,10);
}
export function bankQR({bankCode,accountNumber,accountName}, value, reference) {
  const tlv = (tag,content) => { const length = Buffer.byteLength(content); if(length>99) throw new ValidationError('QR 欄位過長'); return tag+String(length).padStart(2,'0')+content; };
  const receiver = tlv('00',bankCode)+tlv('01',accountNumber);
  const merchant = tlv('00','A000000727')+tlv('01',receiver)+tlv('02','QRIBFTTA');
  let payload = tlv('00','01')+tlv('01','12')+tlv('38',merchant)+tlv('53','704')+tlv('54',String(value))+tlv('58','VN');
  const label = accountName.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'D').toUpperCase().replace(/[^A-Z0-9 ]/g,'').slice(0,25);
  if (label) payload+=tlv('59',label);
  payload+=tlv('62',tlv('08',reference))+'6304';
  let crc=0xffff;
  for(const byte of Buffer.from(payload)) { crc^=byte<<8; for(let i=0;i<8;i++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff; }
  return payload+crc.toString(16).toUpperCase().padStart(4,'0');
}
export const csvCell = value => `"${String(value??'').replace(/^[\s]*[=+\-@\t\r]/,s=>`'${s}`).replace(/"/g,'""')}"`;
const monetaryFields = new Set(['amount','opening_cash','counted_cash','expected_cash','difference','subtotal','total','tendered','change_given','principal_balance','bonus_balance','delta','balance_after']);
export const jsonSafe = value => JSON.parse(JSON.stringify(value,(key,v)=>(typeof v==='bigint' || (monetaryFields.has(key) && typeof v==='number'))?String(v):v));
