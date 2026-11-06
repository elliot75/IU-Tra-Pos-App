import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD_MAX_BYTES = 1024;
// Same format and work factor as a real hash; account state still gates authentication.
const DUMMY_PASSWORD_HASH = `scrypt-v1$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export class StaffAuthError extends Error {
  constructor(status, code, message) { super(message); this.name = 'StaffAuthError'; this.status = status; this.code = code; }
}
const unavailable = () => new StaffAuthError(503, 'SERVICE_UNAVAILABLE', '員工認證服務暫時無法使用');
const invalid = () => new StaffAuthError(401, 'UNAUTHENTICATED', '登入資料無效或帳號無法使用');
const validPassword = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES;
export const validLoginName = value => typeof value === 'string' && LOGIN_PATTERN.test(value);
const tokenHash = token => createHash('sha256').update(token, 'utf8').digest('hex');
const userFromRow = row => ({ id: row.id, loginName: row.login_name, displayName: row.display_name, canManageCatalog: row.can_manage_catalog });

// Versioned, fixed scrypt parameters prevent a database value from choosing costly parameters.
export async function hashStaffPassword(password) {
  if (!validPassword(password)) throw new TypeError('Invalid password');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt-v1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, stored, deriveKey) {
  if (typeof stored !== 'string' || !/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(stored)) throw new Error('Invalid stored password hash');
  const [, salt, hash] = stored.split('$');
  const derived = await deriveKey(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}

// Instance-scoped test seam; requests and database rows cannot choose scrypt parameters.
export function createStaffAuth(pool, { scrypt: deriveKey = scrypt } = {}) {
  async function query(sql, params) {
    try { if (!pool) throw new Error(); return await pool.query(sql, params); } catch { throw unavailable(); }
  }
  return {
    async login(loginName, password) {
      if (!validLoginName(loginName) || !validPassword(password)) throw invalid();
      let client;
      let result;
      try {
        if (!pool) throw new Error();
        client = await pool.connect();
        await client.query('BEGIN');
        const found = await client.query('SELECT id, login_name, display_name, can_manage_catalog, password_hash, active, (locked_until > clock_timestamp()) AS locked FROM iutra_pos.staff_users WHERE login_name = $1 FOR UPDATE', [loginName]);
        const row = found.rows[0];
        const passwordMatches = await verifyPassword(password, row?.active ? row.password_hash : DUMMY_PASSWORD_HASH, deriveKey);
        if (!row || !row.active || row.locked) result = { error: invalid() };
        else if (!passwordMatches) {
          await client.query("UPDATE iutra_pos.staff_users SET failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= clock_timestamp() THEN 1 ELSE failed_attempts + 1 END, locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= clock_timestamp() THEN 1 ELSE failed_attempts + 1 END) >= 5 THEN clock_timestamp() + interval '15 minutes' ELSE NULL END WHERE id = $1 RETURNING (locked_until IS NOT NULL) AS locked", [row.id]);
          result = { error: invalid() };
        } else {
          await client.query('UPDATE iutra_pos.staff_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [row.id]);
          const token = randomBytes(32).toString('base64url');
          const session = await client.query("INSERT INTO iutra_pos.staff_sessions (id, staff_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '8 hours') RETURNING expires_at", [randomUUID(), row.id, tokenHash(token)]);
          result = { token, expiresAt: new Date(session.rows[0].expires_at).toISOString(), user: userFromRow(row) };
        }
        await client.query('COMMIT');
      } catch {
        if (client) { try { await client.query('ROLLBACK'); } catch {} }
        throw unavailable();
      } finally { if (client) client.release(); }
      if (result.error) throw result.error;
      return result;
    },
    async authenticate(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
      const result = await query('SELECT u.id, u.login_name, u.display_name, u.can_manage_catalog FROM iutra_pos.staff_sessions s JOIN iutra_pos.staff_users u ON u.id = s.staff_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.active = true', [tokenHash(token)]);
      if (!result.rows[0]) throw invalid();
      return userFromRow(result.rows[0]);
    },
    async logout(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
      await query('UPDATE iutra_pos.staff_sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)]);
    }
  };
}
