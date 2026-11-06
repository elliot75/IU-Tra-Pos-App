import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createServer } from '../src/server.js';
import { StaffAuthError } from '../src/staff-auth.js';
import { createAuthTransport } from '../src/auth-transport.js';

const manager = { id: 'staff-1', loginName: 'manager', displayName: '店長', canManageCatalog: true };
const staff = { id: 'staff-2', loginName: 'staff', displayName: '店員', canManageCatalog: false };
function fakeAuth() {
  const active = new Map();
  return {
    async login(name, password) {
      if (password !== 'valid-password' || !['manager', 'staff'].includes(name)) throw new StaffAuthError(401, 'UNAUTHENTICATED', '登入資料無效');
      const user = name === 'manager' ? manager : staff;
      const token = `${name}-token`;
      active.set(token, user);
      return { token, expiresAt: '2030-01-01T00:00:00.000Z', user };
    },
    async authenticate(token) { const user = active.get(token); if (!user) throw new StaffAuthError(401, 'UNAUTHENTICATED', '登入資料無效'); return user; },
    async logout(token) { active.delete(token); }
  };
}
const pool = { async query() { return { rows: [{ revision: '0', catalog: { categories: [], products: [] } }] }; } };
async function withServer(fn, options = {}) {
  const server = createServer({ pool, staffAuth: fakeAuth(), authTransport: createAuthTransport({ mode: 'local-development', trustedProxyIps: '' }), ...options }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function request(base, path, { token, method = 'GET', data, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: res.status, body: await res.json() };
}

test('本機商品圖片可讀取，其他路徑不會作為商品圖片提供', async () => {
  const dir = new URL('../public/catalog-images/', import.meta.url);
  const name = `${'a'.repeat(64)}.png`;
  const file = new URL(name, dir);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  await mkdir(dir, { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
  try {
    await withServer(async base => {
      const response = await fetch(`${base}/catalog-images/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal((await fetch(`${base}/catalog-images/${'b'.repeat(64)}.png`)).status, 404);
      assert.equal((await fetch(`${base}/catalog-images/${'a'.repeat(64)}.svg`)).status, 404);
    });
  } finally { await unlink(file); }
});

test('管理菜單可接受較大請求，其他端點仍維持大小限制', async () => {
  await withServer(async base => {
    const login = await request(base, '/api/v1/sessions', { method: 'POST', data: { loginName: 'manager', password: 'valid-password' } });
    const headers = { authorization: `Bearer ${login.body.data.token}`, 'content-type': 'application/json' };
    const oversized = JSON.stringify({ padding: 'a'.repeat(70000) });
    const catalogResponse = await fetch(base + '/api/v1/admin/catalog', { method: 'PUT', headers, body: oversized });
    assert.equal((await catalogResponse.json()).error.message, '請求格式不正確');
    const loginResponse = await fetch(base + '/api/v1/sessions', { method: 'POST', headers, body: oversized });
    assert.equal((await loginResponse.json()).error.message, '請求內容過大');
    const maxResponse = await fetch(base + '/api/v1/admin/catalog', { method: 'PUT', headers, body: JSON.stringify({ padding: 'a'.repeat(262145) }) });
    assert.equal((await maxResponse.json()).error.message, '請求內容過大');
  });
});

test('安全模式在驗證前拒絕 HTTP，可信代理須提供 https，客顯模組可載入', async () => {
  const authTransport = createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '127.0.0.1' });
  await withServer(async base => {
    for (const path of ['/api/v1/sessions', '/api/v1/sessions/current', '/api/v1/me', '/api/v1/admin/catalog']) {
      assert.equal((await request(base, path)).status, 403);
      assert.equal((await request(base, path, { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
    }
    const login = { method: 'POST', data: { loginName: 'manager', password: 'valid-password' } };
    assert.equal((await request(base, '/api/v1/sessions', login)).status, 403);
    assert.equal((await request(base, '/api/v1/sessions', { ...login, headers: { 'x-forwarded-proto': 'https' } })).status, 200);
    for (const [path, exported] of [['/display-protocol.js', 'export const DISPLAY_CHANNEL'], ['/validation.js', 'export function normalizeNote'], ['/catalog-validation.js', 'export function validateCatalog']]) {
      const module = await fetch(base + path);
      assert.equal(module.status, 200);
      assert.match(module.headers.get('content-type'), /javascript/);
      assert.ok((await module.text()).includes(exported));
    }
  }, { authTransport });
  await withServer(async base => {
    assert.equal((await request(base, '/api/v1/me', { headers: { 'x-forwarded-proto': 'https' } })).status, 403);
  }, { authTransport: createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '' }) });
});

test('區網測試模式公布 HTTP 登入設定並保留登入權限檢查', async () => {
  await withServer(async base => {
    const config = await request(base, '/api/v1/auth/config');
    assert.equal(config.body.data.allowInsecureHttp, true);
    assert.equal((await request(base, '/api/v1/admin/catalog')).status, 401);
    const login = await request(base, '/api/v1/sessions', { method: 'POST', data: { loginName: 'manager', password: 'valid-password' } });
    assert.equal(login.status, 200);
    assert.equal((await request(base, '/api/v1/admin/catalog', { token: login.body.data.token })).status, 200);
  }, { authTransport: createAuthTransport({ mode: 'lan-development', trustedProxyIps: '' }) });
  await withServer(async base => {
    assert.equal((await request(base, '/api/v1/auth/config')).body.data.allowInsecureHttp, false);
  }, { authTransport: createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '' }) });
});

test('來源限流跨帳號且忽略不可信 X-Real-IP，在驗證前拒絕第 11 次', async () => {
  let calls = 0;
  await withServer(async base => {
    for (let i = 0; i < 11; i++) {
      const result = await request(base, '/api/v1/sessions', { method: 'POST', headers: { 'x-real-ip': `203.0.113.${i}` }, data: { loginName: `user-${i}`, password: 'wrong' } });
      assert.equal(result.status, i < 10 ? 401 : 429);
    }
    assert.equal(calls, 10);
  }, { staffAuth: { async login() { calls++; throw new StaffAuthError(401, 'UNAUTHENTICATED', '登入資料無效'); } } });
});

test('可信代理按真實來源限流，成功登入與無效 JSON 都計次', async () => {
  await withServer(async base => {
    const headers = { 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.1' };
    for (let i = 0; i < 9; i++) assert.equal((await request(base, '/api/v1/sessions', { method: 'POST', headers, data: { loginName: 'manager', password: 'valid-password' } })).status, 200);
    assert.equal((await fetch(base + '/api/v1/sessions', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await request(base, '/api/v1/sessions', { method: 'POST', headers, data: {} })).status, 429);
    assert.equal((await request(base, '/api/v1/sessions', { method: 'POST', headers: { ...headers, 'x-real-ip': '203.0.113.2' }, data: { loginName: 'manager', password: 'valid-password' } })).status, 200);
  }, { authTransport: createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '127.0.0.1' }) });
});

test('具名登入、權限驗證與登出保護商品後台', async () => {
  await withServer(async base => {
    assert.equal((await request(base, '/api/v1/admin/catalog')).status, 401);
    assert.equal((await request(base, '/api/v1/sessions', { method: 'POST', data: { loginName: 'manager', password: 'wrong' } })).status, 401);
    const clerk = (await request(base, '/api/v1/sessions', { method: 'POST', data: { loginName: 'staff', password: 'valid-password' } })).body.data;
    assert.equal((await request(base, '/api/v1/admin/catalog', { token: clerk.token })).status, 403);
    const login = await request(base, '/api/v1/sessions', { method: 'POST', data: { loginName: 'manager', password: 'valid-password' } });
    assert.equal(login.status, 200);
    assert.equal((await request(base, '/api/v1/me', { token: login.body.data.token })).body.data.displayName, '店長');
    assert.equal((await request(base, '/api/v1/admin/catalog', { token: login.body.data.token })).status, 200);
    assert.equal((await request(base, '/api/v1/sessions/current', { method: 'DELETE', token: login.body.data.token })).status, 200);
    assert.equal((await request(base, '/api/v1/admin/catalog', { token: login.body.data.token })).status, 401);
  });
});
