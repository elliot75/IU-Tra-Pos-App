import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import pg from 'pg';
import { hashStaffPassword, validLoginName } from '../src/staff-auth.js';

async function readPassword() {
  const input = process.stdin;
  const tty = input.isTTY;
  let value = '';
  const decoder = new StringDecoder('utf8');
  if (tty) { process.stderr.write('密碼（不回顯）：'); input.setRawMode(true); }
  try {
    for await (const chunk of input) {
      const text = decoder.write(chunk);
      for (const char of text) {
        if (char === '\u0003') throw new Error('cancelled');
        if (char === '\r' || char === '\n') return value;
        if (tty && (char === '\u007f' || char === '\b')) { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (char === '\u0004' && tty) throw new Error('cancelled');
        value += char;
        if (Buffer.byteLength(value, 'utf8') > 1024) throw new Error('too long');
      }
    }
    return value + decoder.end();
  } finally { if (tty) { input.setRawMode(false); process.stderr.write('\n'); } }
}

async function main() {
  const args = process.argv.slice(2);
  const canManageCatalog = args.includes('--can-manage-catalog');
  const positional = args.filter(arg => arg !== '--can-manage-catalog');
  if (args.length !== positional.length + (canManageCatalog ? 1 : 0) || positional.length !== 2 || !validLoginName(positional[0]) || !positional[1].trim() || Array.from(positional[1]).length > 100 || positional[1].includes('\0')) {
    process.stderr.write('用法：node scripts/create-staff.js <登入名> <顯示名> [--can-manage-catalog]\n密碼由 stdin 讀取；管理權限須明確加上旗標。\n');
    process.exitCode = 1; return;
  }
  if (!process.env.DATABASE_URL) { process.stderr.write('必須設定 DATABASE_URL。\n'); process.exitCode = 1; return; }
  let pool;
  try {
    const password = await readPassword();
    if (Array.from(password).length < 12) { process.stderr.write('密碼須至少 12 個字元。\n'); process.exitCode = 1; return; }
    const hash = await hashStaffPassword(password);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('INSERT INTO iutra_pos.staff_users (id, login_name, display_name, password_hash, can_manage_catalog) VALUES ($1, $2, $3, $4, $5)', [randomUUID(), positional[0], positional[1], hash, canManageCatalog]);
    process.stdout.write('員工帳號已建立。\n');
  } catch {
    process.stderr.write('無法建立員工帳號；請檢查輸入、資料庫狀態及權限。\n');
    process.exitCode = 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
await main();
