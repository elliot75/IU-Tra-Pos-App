import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PERMISSIONS } from '../src/operations.js';
import { amount, fields, sha256, text, uuid } from '../src/pos-utils.js';

export function validateConfiguration(config) {
  fields(config,['organization','store','device','grants']);
  fields(config.organization,['id','name']);uuid(config.organization.id);text(config.organization.name,100);
  fields(config.store,['id','name','timezone','dayCutoff','policy']);uuid(config.store.id);text(config.store.name,100);
  new Intl.DateTimeFormat('en',{timeZone:config.store.timezone});
  if(!Number.isInteger(config.store.dayCutoff)||config.store.dayCutoff<0||config.store.dayCutoff>1439) throw new Error('dayCutoff 必須為午夜後分鐘 0..1439');
  const policy=config.store.policy;
  fields(policy,['walletEnabled','memberVerification','refundEnabled','partialRefunds','refundMax','dualApproval'],['verificationAttempts','verificationLockMinutes','refundWindowDays']);
  for(const name of ['walletEnabled','refundEnabled','partialRefunds','dualApproval']) if(typeof policy[name]!=='boolean') throw new Error('policy 布林欄位不正確');
  if(policy.memberVerification!==null && policy.memberVerification!=='pin') throw new Error('只提供待核准的 PIN 驗證轉接，其他方法保持停用');
  amount(policy.refundMax);
  if(policy.walletEnabled && (policy.memberVerification!=='pin'||!Number.isInteger(policy.verificationAttempts)||policy.verificationAttempts<1||policy.verificationAttempts>10||!Number.isInteger(policy.verificationLockMinutes)||policy.verificationLockMinutes<1||policy.verificationLockMinutes>1440)) throw new Error('啟用錢包前須明確核准 PIN、失敗上限與鎖定分鐘');
  if(policy.refundEnabled && (!Number.isInteger(policy.refundWindowDays)||policy.refundWindowDays<1||policy.refundWindowDays>3650)) throw new Error('啟用退款前須明確核准期限');
  fields(config.device,['id','name','key']);uuid(config.device.id);text(config.device.name,100);
  if(typeof config.device.key!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(config.device.key)||config.device.key.includes('REPLACE')) throw new Error('設備 key 須另產生至少 32 字元隨機秘密，不能使用範例');
  if(!Array.isArray(config.grants)||config.grants.length>100) throw new Error('grants 格式錯誤');
  const seen=new Set();
  for(const grant of config.grants){fields(grant,['loginName','permissions','role']);if(!['cashier','operator'].includes(grant.role))throw new Error('請明確標示 cashier 或 operator 角色');text(grant.loginName,64);if(seen.has(grant.loginName))throw new Error('重複授權');seen.add(grant.loginName);if(!Array.isArray(grant.permissions)||new Set(grant.permissions).size!==grant.permissions.length||grant.permissions.some(p=>!PERMISSIONS.includes(p)))throw new Error('未知或重複權限');}
  return config;
}
export async function configure(pool,config) {
  validateConfiguration(config);const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const existing=(await client.query('SELECT organization_id FROM iutra_pos.pos_stores WHERE id=$1 FOR UPDATE',[config.store.id])).rows[0];
    if(existing && existing.organization_id!==config.organization.id) throw new Error('不可轉移既有門市的組織');
    const device=(await client.query('SELECT store_id FROM iutra_pos.pos_devices WHERE id=$1 FOR UPDATE',[config.device.id])).rows[0];
    if(device && device.store_id!==config.store.id) throw new Error('不可轉移已有交易的設備');
    await client.query('INSERT INTO iutra_pos.pos_organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name',[config.organization.id,config.organization.name]);
    await client.query('INSERT INTO iutra_pos.pos_stores(id,organization_id,name,timezone,day_cutoff,policy) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,timezone=EXCLUDED.timezone,day_cutoff=EXCLUDED.day_cutoff,policy=EXCLUDED.policy',[config.store.id,config.organization.id,config.store.name,config.store.timezone,config.store.dayCutoff,JSON.stringify(config.store.policy)]);
    await client.query('INSERT INTO iutra_pos.pos_devices(id,store_id,name,key_hash) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,key_hash=EXCLUDED.key_hash',[config.device.id,config.store.id,config.device.name,sha256(config.device.key)]);
    for(const grant of config.grants){
      const staff=(await client.query('SELECT id,can_manage_catalog FROM iutra_pos.staff_users WHERE login_name=$1 AND active=true',[grant.loginName])).rows[0];
      if(!staff) throw new Error('授權帳號不存在或已停用');
      if(grant.role==='cashier' && (staff.can_manage_catalog || grant.permissions.some(p=>['bank.manage','members.manage','wallet.adjust','refund.approve','refund.execute','cash.manage','audit','export'].includes(p)))) throw new Error('收銀角色不可同時具管理或主管資金權限');
      await client.query('INSERT INTO iutra_pos.pos_grants(staff_id,device_id,permissions) VALUES($1,$2,$3) ON CONFLICT(staff_id,device_id) DO UPDATE SET permissions=EXCLUDED.permissions',[staff.id,config.device.id,grant.permissions]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [file,mode]=process.argv.slice(2);
  let pool;
  try {
    if(!file||!['--check','--apply'].includes(mode))throw new Error('用法：node --env-file-if-exists=.env scripts/configure-pos.js private/pos-config.json --check 或 --apply');
    const config=validateConfiguration(JSON.parse(await readFile(file,'utf8')));
    if(mode==='--check') console.log('設定格式有效；未連線、未修改資料庫。');
    else {if(!process.env.DATABASE_URL)throw new Error('尚未設定 DATABASE_URL');pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:3000});await configure(pool,config);console.log('已套用明確指定的門市、設備及帳號授權。未指定的既有授權保留；撤權須明確給空 permissions。');}
  }catch(error){console.error(error instanceof Error && !error.code?error.message:'設定未完成；請檢查目標及遷移狀態，不輸出資料庫憑證。');process.exitCode=1;}finally{await pool?.end();}
}
