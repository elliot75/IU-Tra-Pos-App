import { randomUUID } from 'node:crypto';
import { ServiceError } from './catalog-store.js';
import { validateCatalog } from './catalog-validation.js';
import { quoteOrder, ValidationError } from './pricing.js';

// POS-01: development-only unpaid drafts; this does not create a sale or payment.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const unavailable = () => new ServiceError(503, 'SERVICE_UNAVAILABLE', '訂單草稿服務暫時無法使用');
const missing = () => new ServiceError(404, 'NOT_FOUND', '找不到訂單草稿');
const conflict = () => new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '操作識別碼已用於不同的輸入');
const stale = () => new ServiceError(409, 'MENU_RELEASE_CONFLICT', '菜單版本已變更或尚未發布');

// Compare all JSON input fields, independent of object key order. Reject values JSON
// would silently drop or alter so different requests cannot become equivalent.
function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 32) throw new ValidationError('訂單輸入巢狀層數過多');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || seen.has(value)) throw new ValidationError('訂單輸入必須是 JSON 資料');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ValidationError('訂單輸入必須是 JSON 資料');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new ValidationError('訂單輸入必須是 JSON 資料');
    result = `[${value.map(v => canonical(v, seen, depth + 1)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen, depth + 1)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}
const output = row => ({ id: row.id, staffId: row.staff_id, operationId: row.operation_id, status: 'development_draft', quote: row.quote, createdAt: new Date(row.created_at).toISOString() });
function matching(row, request) {
  if (canonical(row.request) !== request) throw conflict();
  return output(row);
}
const lookup = (client, staffId, operationId) => client.query('SELECT id, staff_id, operation_id, request, quote, created_at FROM iutra_pos.order_drafts WHERE staff_id = $1 AND operation_id = $2', [staffId, operationId]);

export class OrderDraftStore {
  constructor(pool) { this.pool = pool; }

  async create({ staffId, operationId, menuRelease, items } = {}) {
    if (!uuid(staffId) || !uuid(operationId) || typeof menuRelease !== 'string' || !menuRelease || menuRelease.length > 100) throw new ValidationError('員工、操作識別碼或菜單版本不正確');
    if (!Array.isArray(items) || items.length === 0 || items.length > 100 || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new ValidationError('商品明細格式不正確');
    staffId = staffId.toLowerCase(); operationId = operationId.toLowerCase();
    const request = canonical({ menuRelease, items });
    if (Buffer.byteLength(request) > 200000) throw new ValidationError('訂單輸入過大');
    let client;
    try {
      if (!this.pool) throw unavailable();
      client = await this.pool.connect();
      await client.query('BEGIN');
      let found = await lookup(client, staffId, operationId);
      if (found.rows.length) {
        const result = matching(found.rows[0], request);
        await client.query('COMMIT');
        return result;
      }
      const state = await client.query('SELECT s.current_release, r.catalog FROM iutra_pos.catalog_state s LEFT JOIN iutra_pos.catalog_releases r ON r.release = s.current_release WHERE s.singleton = $1 FOR SHARE OF s', [true]);
      if (!state.rows.length) throw unavailable();
      // Another request can finish while this transaction waits for the state lock.
      found = await lookup(client, staffId, operationId);
      if (found.rows.length) {
        const result = matching(found.rows[0], request);
        await client.query('COMMIT');
        return result;
      }
      const { current_release: current, catalog } = state.rows[0];
      if (!current || current === 'example-v1' || current !== menuRelease || !catalog || catalog.release !== current || catalog.isExample !== false) throw stale();
      validateCatalog({ categories: catalog.categories, products: catalog.products }, { publishing: true });
      const quote = quoteOrder({ menuRelease, items }, catalog);
      const inserted = await client.query('INSERT INTO iutra_pos.order_drafts (id, staff_id, operation_id, menu_release, request, quote, total_vnd) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::bigint) ON CONFLICT (staff_id, operation_id) DO NOTHING RETURNING id, staff_id, operation_id, request, quote, created_at', [randomUUID(), staffId, operationId, menuRelease, request, JSON.stringify(quote), quote.total]);
      const row = inserted.rows[0] ?? (await lookup(client, staffId, operationId)).rows[0];
      if (!row) throw unavailable();
      const result = matching(row, request);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
      if (error instanceof ServiceError || error instanceof ValidationError) throw error;
      throw unavailable();
    } finally { if (client) client.release(); }
  }

  async get({ staffId, id } = {}) {
    if (!uuid(staffId) || !uuid(id)) throw new ValidationError('員工或草稿識別碼不正確');
    try {
      if (!this.pool) throw unavailable();
      const result = await this.pool.query('SELECT id, staff_id, operation_id, quote, created_at FROM iutra_pos.order_drafts WHERE staff_id = $1 AND id = $2', [staffId, id]);
      if (!result.rows.length) throw missing();
      return output(result.rows[0]);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw unavailable();
    }
  }
}
