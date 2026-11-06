import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthTransport, createLoginRateLimiter } from '../src/auth-transport.js';

const transport = (options = {}) => createAuthTransport({ mode: 'https-proxy', trustedProxyIps: '', ...options });
function req(remoteAddress, headers = {}, encrypted = false) {
  return { socket: { remoteAddress, encrypted }, headers, rawHeaders: Object.entries(headers).flat() };
}
const denied = fn => assert.throws(fn, error => error.status === 403 && error.code === 'HTTPS_REQUIRED');
const limited = fn => assert.throws(fn, error => error.status === 429);

test('未設定環境變數時預設 https-proxy 且不信任任何代理', () => {
  const saved = { AUTH_TRANSPORT_MODE: process.env.AUTH_TRANSPORT_MODE, TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS };
  try {
    delete process.env.AUTH_TRANSPORT_MODE;
    delete process.env.TRUSTED_PROXY_IPS;
    const auth = createAuthTransport();
    denied(() => auth.requireProtectedTransport(req('127.0.0.1', { 'x-forwarded-proto': 'https' })));
    process.env.AUTH_TRANSPORT_MODE = 'local-development';
    createAuthTransport().requireProtectedTransport(req('127.0.0.1'));
    process.env.AUTH_TRANSPORT_MODE = 'https-proxy';
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    createAuthTransport().requireProtectedTransport(req('127.0.0.1', { 'x-forwarded-proto': 'https' }));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('安全模式拒絕 loopback、LAN HTTP 及偽造代理標頭，接受直接 TLS', () => {
  for (const ip of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '192.168.1.20']) {
    denied(() => transport().requireProtectedTransport(req(ip, { 'x-forwarded-proto': 'https' })));
    transport().requireProtectedTransport(req(ip, {}, true));
  }
});

test('只有 explicit 可信代理及單一 https 標頭可通過', () => {
  const auth = transport({ trustedProxyIps: '127.0.0.1,2001:db8::1' });
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:0db8:0:0::1']) {
    auth.requireProtectedTransport(req(ip, { 'x-forwarded-proto': 'https' }));
    for (const value of [undefined, 'http', 'https,http', 'https, https', 'HTTPS', ['https'], ' https ']) {
      denied(() => auth.requireProtectedTransport(req(ip, value === undefined ? {} : { 'x-forwarded-proto': value })));
    }
  }
  const duplicate = req('127.0.0.1', { 'x-forwarded-proto': 'https' });
  duplicate.rawHeaders.push('X-Forwarded-Proto', 'https');
  denied(() => auth.requireProtectedTransport(duplicate));
  denied(() => auth.requireProtectedTransport(req('192.168.1.2', { 'x-forwarded-proto': 'https' })));
});

test('local-development 明確設定只放行 loopback HTTP，設定錯誤即失敗', () => {
  const auth = transport({ mode: 'local-development' });
  for (const ip of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) auth.requireProtectedTransport(req(ip));
  for (const ip of ['192.168.1.2', '128.0.0.1', undefined]) denied(() => auth.requireProtectedTransport(req(ip)));
  for (const mode of ['', 'development', 'http', 'HTTPS-PROXY', null]) assert.throws(() => transport({ mode }));
  for (const trustedProxyIps of ['*', 'localhost', '127.0.0.0/8', '127.0.0.1,', 'bad', 'fe80::1%lo0', ['127.0.0.1']]) assert.throws(() => transport({ trustedProxyIps }));
});

test('來源只信任已列代理的單一有效 X-Real-IP，無效時以 peer 計數', () => {
  const auth = transport({ trustedProxyIps: '127.0.0.1' });
  assert.equal(auth.sourceIP(req('127.0.0.1', { 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(auth.sourceIP(req('127.0.0.1', { 'x-real-ip': '::ffff:203.0.113.7' })), '203.0.113.7');
  assert.equal(auth.sourceIP(req('192.168.1.2', { 'x-real-ip': '203.0.113.7' })), '192.168.1.2');
  for (const value of ['', 'invalid', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', '[::1]', ['1.2.3.4']]) {
    assert.equal(auth.sourceIP(req('::ffff:127.0.0.1', { 'x-real-ip': value })), '127.0.0.1');
  }
  const duplicate = req('127.0.0.1', { 'x-real-ip': '203.0.113.7' });
  duplicate.rawHeaders.push('X-Real-IP', '203.0.113.8');
  assert.equal(auth.sourceIP(duplicate), '127.0.0.1');
  assert.equal(auth.sourceIP(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), '127.0.0.1');
});

test('來源限流 10 次／60 秒，有界且過期清理不淘汰活躍來源', () => {
  let time = 0;
  const limiter = createLoginRateLimiter({ now: () => time, maxSources: 2 });
  for (let i = 0; i < 10; i++) limiter.check('a');
  limited(() => limiter.check('a'));
  time = 1000; limiter.check('b');
  limited(() => limiter.check('c'));
  limited(() => limiter.check('a'));
  time = 59999; limited(() => limiter.check('a'));
  time = 60000; limiter.check('c'); // a expires, b remains; capacity reclaimed.
  limited(() => limiter.check('a'));
  time = 61000; limiter.check('a');
  for (let i = 0; i < 9; i++) limiter.check('a');
  limited(() => limiter.check('a'));
  for (const maxSources of [0, -1, Infinity, 1.5]) assert.throws(() => createLoginRateLimiter({ maxSources }));
});
