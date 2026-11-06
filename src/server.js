import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { catalog } from './catalog.js';
import { quoteOrder, ValidationError } from './pricing.js';
import { CatalogStore, ServiceError } from './catalog-store.js';
import { createStaffAuth, StaffAuthError } from './staff-auth.js';
import { createAuthTransport, createLoginRateLimiter } from './auth-transport.js';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/display', ['display.html', 'text/html; charset=utf-8']],
  ['/display.html', ['display.html', 'text/html; charset=utf-8']],
  ['/display.js', ['display.js', 'text/javascript; charset=utf-8']],
  ['/display-protocol.js', ['display-protocol.js', 'text/javascript; charset=utf-8']],
  ['/display.css', ['display.css', 'text/css; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']]
]);
function send(res, status, data, requestId) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId });
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 65536) chunks.push(chunk);
  }
  if (size > 65536) throw new ValidationError('請求內容過大');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('JSON 格式不正確'); }
}
function exactFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new ValidationError('請求格式不正確');
}
function bearer(req) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) throw new StaffAuthError(401, 'UNAUTHENTICATED', '請先登入');
  return match[1];
}
export function createServer({ pool = null, staffAuth = createStaffAuth(pool), authTransport = createAuthTransport(), loginRateLimiter = createLoginRateLimiter() } = {}) {
  const store = new CatalogStore(pool);
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [name, type] = files.get(path);
        const content = await readFile(new URL(`../public/${name}`, import.meta.url));
        res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/api/v1/auth/config') return send(res, 200, { request_id: requestId, data: { allowInsecureHttp: authTransport.allowsInsecureHttp(req) } }, requestId);
      const authPath = path === '/api/v1/sessions' || path === '/api/v1/sessions/current' || path === '/api/v1/me' || path === '/api/v1/admin' || path.startsWith('/api/v1/admin/');
      if (authPath) authTransport.requireProtectedTransport(req);
      if (req.method === 'POST' && path === '/api/v1/sessions') {
        loginRateLimiter.check(authTransport.sourceIP(req));
        const input = await body(req); exactFields(input, ['loginName', 'password']);
        return send(res, 200, { request_id: requestId, data: await staffAuth.login(input.loginName, input.password) }, requestId);
      }
      if (req.method === 'GET' && path === '/api/v1/me') return send(res, 200, { request_id: requestId, data: await staffAuth.authenticate(bearer(req)) }, requestId);
      if (req.method === 'DELETE' && path === '/api/v1/sessions/current') {
        await staffAuth.logout(bearer(req));
        return send(res, 200, { request_id: requestId, data: { loggedOut: true } }, requestId);
      }
      if (path === '/api/v1/admin' || path.startsWith('/api/v1/admin/')) {
        const user = await staffAuth.authenticate(bearer(req));
        if (!user.canManageCatalog) throw new ServiceError(403, 'FORBIDDEN', '沒有商品管理權限');
      }
      if (req.method === 'GET' && path === '/api/v1/catalog/example') return send(res, 200, { request_id: requestId, data: catalog }, requestId);
      if (req.method === 'GET' && path === '/api/v1/catalog/published') return send(res, 200, { request_id: requestId, data: await store.getPublished() }, requestId);
      if (req.method === 'GET' && path === '/api/v1/admin/catalog') return send(res, 200, { request_id: requestId, data: await store.getDraft() }, requestId);
      if (req.method === 'PUT' && path === '/api/v1/admin/catalog') {
        const input = await body(req); exactFields(input, ['expectedRevision', 'catalog']);
        return send(res, 200, { request_id: requestId, data: await store.update(input.expectedRevision, input.catalog) }, requestId);
      }
      if (req.method === 'POST' && path === '/api/v1/admin/catalog/publish') {
        const input = await body(req); exactFields(input, ['expectedRevision']);
        return send(res, 200, { request_id: requestId, data: await store.publish(input.expectedRevision) }, requestId);
      }
      if (req.method === 'POST' && path === '/api/v1/quotes') {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.menuRelease !== 'string' || !input.menuRelease || input.menuRelease.length > 100) throw new ValidationError('菜單版本不正確，請重新載入');
        const selected = input.menuRelease === catalog.release ? catalog : await store.getPublished();
        return send(res, 200, { request_id: requestId, data: quoteOrder(input, selected) }, requestId);
      }
      if (req.method === 'GET' && path === '/api/v1/health') {
        let database = 'not_configured';
        if (pool) { try { await pool.query('SELECT 1'); database = 'connected'; } catch { database = 'unavailable'; } }
        return send(res, 200, { request_id: requestId, data: { service: 'ok', database } }, requestId);
      }
      return send(res, 404, { request_id: requestId, error: { code: 'NOT_FOUND', message: '找不到資源' } }, requestId);
    } catch (error) {
      const validation = error instanceof ValidationError;
      const known = error instanceof ServiceError || error instanceof StaffAuthError;
      const status = validation ? 400 : known ? error.status : 500;
      if (status === 500) console.error('Request failed:', requestId, error.name);
      return send(res, status, { request_id: requestId, error: { code: validation ? 'VALIDATION_ERROR' : known ? error.code : 'INTERNAL_ERROR', message: status === 500 ? '服務發生錯誤' : error.message } }, requestId);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 2 }) : null;
  const server = createServer({ pool });
  server.listen(port, host, () => console.log(`IUTRA POS development server: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { if (pool) await pool.end(); process.exit(0); }));
}
