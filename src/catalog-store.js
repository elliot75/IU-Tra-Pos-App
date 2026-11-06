import { randomUUID } from 'node:crypto';
import { validateCatalog, validateRevision } from './catalog-validation.js';
import { ValidationError } from './pricing.js';

export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const unavailable = () => new ServiceError(503, 'SERVICE_UNAVAILABLE', '商品資料庫未設定、未初始化或暫時無法使用');
const conflict = () => new ServiceError(409, 'REVISION_CONFLICT', '草稿已變更，請重新載入');
const missing = () => new ServiceError(404, 'NOT_FOUND', '尚未發布菜單');
const draft = row => ({ revision: Number(row.revision), catalog: row.catalog });

export class CatalogStore {
  constructor(pool) { this.pool = pool; }
  async query(sql, params = []) {
    if (!this.pool) throw unavailable();
    try { return await this.pool.query(sql, params); } catch { throw unavailable(); }
  }
  async getDraft() {
    const result = await this.query('SELECT revision, catalog FROM iutra_pos.catalog_state WHERE singleton = $1', [true]);
    if (!result.rows.length) throw unavailable();
    return draft(result.rows[0]);
  }
  async getPublished() {
    const result = await this.query('SELECT r.catalog FROM iutra_pos.catalog_state s LEFT JOIN iutra_pos.catalog_releases r ON r.release = s.current_release WHERE s.singleton = $1', [true]);
    if (!result.rows.length) throw unavailable();
    if (!result.rows[0].catalog) throw missing();
    return result.rows[0].catalog;
  }
  async transaction(work) {
    if (!this.pool) throw unavailable();
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
      if (error instanceof ServiceError || error instanceof ValidationError) throw error;
      throw unavailable();
    } finally { if (client) client.release(); }
  }
  async update(expectedRevision, catalog) {
    validateRevision(expectedRevision); validateCatalog(catalog);
    return this.transaction(async client => {
      const result = await client.query('UPDATE iutra_pos.catalog_state SET catalog = $1::jsonb, revision = revision + 1 WHERE singleton = $2 AND revision = $3 AND revision < $4 RETURNING revision, catalog', [JSON.stringify(catalog), true, expectedRevision, Number.MAX_SAFE_INTEGER]);
      if (!result.rows.length) {
        const exists = await client.query('SELECT 1 FROM iutra_pos.catalog_state WHERE singleton = $1', [true]);
        if (!exists.rows.length) throw unavailable();
        throw conflict();
      }
      return draft(result.rows[0]);
    });
  }
  async publish(expectedRevision) {
    validateRevision(expectedRevision);
    return this.transaction(async client => {
      const result = await client.query('SELECT revision, catalog FROM iutra_pos.catalog_state WHERE singleton = $1 FOR UPDATE', [true]);
      if (!result.rows.length) throw unavailable();
      const row = result.rows[0];
      if (Number(row.revision) !== expectedRevision) throw conflict();
      validateCatalog(row.catalog, { publishing: true });
      const published = { release: `release-${randomUUID()}`, isExample: false, ...row.catalog };
      await client.query('INSERT INTO iutra_pos.catalog_releases (release, catalog) VALUES ($1, $2::jsonb)', [published.release, JSON.stringify(published)]);
      await client.query('UPDATE iutra_pos.catalog_state SET current_release = $1 WHERE singleton = $2', [published.release, true]);
      return published;
    });
  }
}
