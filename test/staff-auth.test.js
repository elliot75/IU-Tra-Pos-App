import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { createStaffAuth, hashStaffPassword, StaffAuthError } from '../src/staff-auth.js';

async function fixture(options) {
  let now = Date.UTC(2026, 0, 1);
  const user = { id: 'staff-1', login_name: 'alice', display_name: 'Alice', can_manage_catalog: false, active: true, password_hash: await hashStaffPassword('correct password'), failed_attempts: 0, locked_until: null };
  const sessions = new Map();
  const calls = [];
  const pool = {
    calls, user, sessions, fail: false,
    advance(ms) { now += ms; },
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (pool.fail) throw Error('secret database connection string');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT id, login_name')) return { rows: params[0] === user.login_name ? [{ ...user, locked: user.locked_until > now }] : [] };
      if (sql.startsWith('UPDATE iutra_pos.staff_users SET failed_attempts = CASE')) {
        user.failed_attempts = user.locked_until && user.locked_until <= now ? 1 : user.failed_attempts + 1;
        user.locked_until = user.failed_attempts >= 5 ? now + 900000 : null;
        return { rows: [{ locked: !!user.locked_until }] };
      }
      if (sql.startsWith('UPDATE iutra_pos.staff_users SET failed_attempts = 0')) { user.failed_attempts = 0; user.locked_until = null; return { rows: [] }; }
      if (sql.startsWith('INSERT INTO iutra_pos.staff_sessions')) { const session = { hash: params[2], expires: now + 28800000, revoked: false }; sessions.set(session.hash, session); return { rows: [{ expires_at: new Date(session.expires) }] }; }
      if (sql.startsWith('SELECT u.id')) { const s = sessions.get(params[0]); return { rows: s && !s.revoked && s.expires > now && user.active ? [user] : [] }; }
      if (sql.startsWith('UPDATE iutra_pos.staff_sessions')) { const s = sessions.get(params[0]); if (s) s.revoked = true; return { rows: [] }; }
      throw Error('unexpected SQL');
    }
  };
  return { pool, auth: createStaffAuth(pool, options) };
}
const expectError = (status, code) => error => error instanceof StaffAuthError && error.status === status && error.code === code && !error.message.includes('secret');
const expectInvalid = error => {
  assert.ok(error instanceof StaffAuthError);
  assert.deepEqual(
    { status: error.status, code: error.code, message: error.message },
    { status: 401, code: 'UNAUTHENTICATED', message: '登入資料無效或帳號無法使用' }
  );
  return true;
};

test('scrypt 密碼加鹽，成功登入後只儲存 token 雜湊', async () => {
  assert.notEqual(await hashStaffPassword('correct password'), await hashStaffPassword('correct password'));
  const { pool, auth } = await fixture();
  const result = await auth.login('alice', 'correct password');
  assert.deepEqual(result.user, { id: 'staff-1', loginName: 'alice', displayName: 'Alice', canManageCatalog: false });
  assert.equal(new Date(result.expiresAt).getTime() - (pool.sessions.values().next().value.expires - 28800000), 28800000);
  const hash = createHash('sha256').update(result.token).digest('hex');
  assert.ok(pool.sessions.has(hash));
  assert.ok(!JSON.stringify(pool.calls).includes(result.token));
  assert.ok(!JSON.stringify(pool.calls).includes('correct password'));
  assert.deepEqual(await auth.authenticate(result.token), result.user);
  await auth.logout(result.token);
  await assert.rejects(auth.authenticate(result.token), expectError(401, 'UNAUTHENTICATED'));
});

test('第五次失敗與鎖定回應不洩漏帳號，15 分鐘內正確密碼也不可繞過', async () => {
  const { pool, auth } = await fixture();
  for (let n = 1; n <= 5; n++) {
    await assert.rejects(auth.login('alice', 'wrong'), expectInvalid);
    assert.equal(pool.user.failed_attempts, n);
    if (n < 5) assert.equal(pool.user.locked_until, null);
  }
  const lockDeadline = pool.user.locked_until;
  assert.equal(lockDeadline, Date.UTC(2026, 0, 1) + 900000);
  await assert.rejects(auth.login('alice', 'correct password'), expectInvalid);
  await assert.rejects(auth.login('alice', 'wrong'), expectInvalid);
  pool.advance(899999);
  await assert.rejects(auth.login('alice', 'correct password'), expectInvalid);
  assert.equal(pool.sessions.size, 0);
  assert.equal(pool.user.failed_attempts, 5);
  assert.equal(pool.user.locked_until, lockDeadline);

  pool.advance(1);
  const result = await auth.login('alice', 'correct password');
  assert.equal(pool.user.failed_attempts, 0);
  assert.equal(pool.user.locked_until, null);
  assert.deepEqual(await auth.authenticate(result.token), result.user);
  assert.ok(pool.calls.some(([sql]) => sql.includes('FOR UPDATE')));
});

test('鎖定到期後錯誤密碼從一次重算，成功清除並可再次鎖定', async () => {
  const { pool, auth } = await fixture();
  for (let n = 0; n < 5; n++) await assert.rejects(auth.login('alice', 'wrong'), expectInvalid);
  pool.advance(900000);
  await assert.rejects(auth.login('alice', 'wrong'), expectInvalid);
  assert.equal(pool.user.failed_attempts, 1);
  assert.equal(pool.user.locked_until, null);
  await auth.login('alice', 'correct password');
  assert.equal(pool.user.failed_attempts, 0);
  assert.equal(pool.user.locked_until, null);
  for (let n = 0; n < 5; n++) await assert.rejects(auth.login('alice', 'wrong'), expectInvalid);
  await assert.rejects(auth.login('alice', 'correct password'), expectInvalid);
  assert.equal(pool.sessions.size, 1);
});

test('未知、停用、鎖定與一般登入均執行一次相同參數的 scrypt', async () => {
  const scrypt = promisify(scryptCallback);
  const derivations = [];
  const { pool, auth } = await fixture({
    async scrypt(...args) {
      derivations.push(args);
      return scrypt(...args);
    }
  });
  async function attempt(login, password, succeeds = false) {
    const before = derivations.length;
    if (succeeds) await auth.login(login, password);
    else await assert.rejects(auth.login(login, password), expectInvalid);
    assert.equal(derivations.length, before + 1);
    const [input, salt, length, options] = derivations.at(-1);
    assert.equal(input, password);
    assert.ok(Buffer.isBuffer(salt));
    assert.equal(salt.length, 16);
    assert.equal(length, 64);
    assert.deepEqual(options, { N: 16384, r: 8, p: 1 });
    return salt;
  }

  const dummySalt = await attempt('unknown', 'correct password');
  pool.user.active = false;
  assert.deepEqual(await attempt('alice', 'correct password'), dummySalt);
  assert.deepEqual(await attempt('alice', 'wrong'), dummySalt);
  assert.equal(pool.user.failed_attempts, 0);
  pool.user.active = true;
  const realSalt = Buffer.from(pool.user.password_hash.split('$')[1], 'hex');
  for (let n = 0; n < 5; n++) assert.deepEqual(await attempt('alice', 'wrong'), realSalt);
  assert.deepEqual(await attempt('alice', 'correct password'), realSalt);
  assert.deepEqual(await attempt('alice', 'wrong'), realSalt);
  assert.deepEqual(await attempt('unknown', 'wrong'), dummySalt);
  assert.equal(pool.sessions.size, 0);
  pool.advance(900000);
  assert.deepEqual(await attempt('alice', 'correct password', true), realSalt);

  const before = derivations.length;
  for (const [login, password] of [['bad login', 'x'], ['alice', ''], ['alice', 'x'.repeat(1025)]]) {
    await assert.rejects(auth.login(login, password), expectInvalid);
  }
  assert.equal(derivations.length, before);
});

test('即使 dummy hash 比對成功，未知及停用帳號仍不得建立 session', async () => {
  let calls = 0;
  const { pool, auth } = await fixture({
    async scrypt() { calls++; return Buffer.alloc(64); }
  });
  await assert.rejects(auth.login('unknown', 'password'), expectInvalid);
  pool.user.active = false;
  await assert.rejects(auth.login('alice', 'password'), expectInvalid);
  assert.equal(calls, 2);
  assert.equal(pool.sessions.size, 0);
  assert.equal(pool.user.failed_attempts, 0);
});

test('停用、過期、錯誤憑證與無效輸入均拒絕', async () => {
  const { pool, auth } = await fixture();
  const { token } = await auth.login('alice', 'correct password');
  pool.user.active = false;
  await assert.rejects(auth.authenticate(token), expectError(401, 'UNAUTHENTICATED'));
  await assert.rejects(auth.login('alice', 'correct password'), expectError(401, 'UNAUTHENTICATED'));
  pool.user.active = true; pool.advance(28800000);
  await assert.rejects(auth.authenticate(token), expectError(401, 'UNAUTHENTICATED'));
  await assert.rejects(auth.authenticate('bad'), expectError(401, 'UNAUTHENTICATED'));
  await assert.rejects(auth.login('unknown', 'x'), expectError(401, 'UNAUTHENTICATED'));
  await assert.rejects(auth.login('alice', 'x'.repeat(1025)), expectError(401, 'UNAUTHENTICATED'));
});

test('資料庫失敗不洩露錯誤且 fail closed', async () => {
  const { pool, auth } = await fixture();
  const { token } = await auth.login('alice', 'correct password');
  pool.fail = true;
  await assert.rejects(auth.login('alice', 'correct password'), expectError(503, 'SERVICE_UNAVAILABLE'));
  await assert.rejects(auth.login('unknown', 'wrong'), expectError(503, 'SERVICE_UNAVAILABLE'));
  await assert.rejects(createStaffAuth(null).login('alice', 'correct password'), expectError(503, 'SERVICE_UNAVAILABLE'));
  await assert.rejects(auth.authenticate(token), expectError(503, 'SERVICE_UNAVAILABLE'));
  await assert.rejects(auth.logout(token), expectError(503, 'SERVICE_UNAVAILABLE'));
  await assert.rejects(createStaffAuth(null).authenticate(token), expectError(503, 'SERVICE_UNAVAILABLE'));
});
