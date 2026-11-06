import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { catalog } from '../src/catalog.js';
import { hashStaffPassword } from '../src/staff-auth.js';
import { sha256 } from '../src/pos-utils.js';

// Embedded PostgreSQL validates real DDL/constraints/rollback. A single PGlite connection
// is serialized; this does not prove native multi-connection PostgreSQL lock scheduling.
export async function operationsDatabase() {
  const db=new PGlite({types:{20:{from:v=>v,to:v=>String(v)}}});
  for(const file of ['001_catalog.sql','002_staff_auth.sql','004_operations.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  let gate=Promise.resolve();
  const acquire=async()=>{const previous=gate;let release;gate=new Promise(resolve=>{release=resolve;});await previous;return release;};
  const pool={
    async connect(){const release=await acquire();return {query:(sql,params=[])=>db.query(sql,params),release};},
    async query(sql,params=[]){const release=await acquire();try{return await db.query(sql,params);}finally{release();}}
  };
  const ids={organization:randomUUID(),store:randomUUID(),device:randomUUID(),staff:randomUUID(),manager:randomUUID()};
  const key='test_device_key_012345678901234567890123456789',password='test-password-strong';
  const permissions=['pos','cash.manage','bank.confirm','bank.manage','members','members.manage','wallet.topup','wallet.charge','wallet.adjust','refund.request','refund.approve','refund.execute','reports','print','print.reprint','audit','export'];
  await pool.query('INSERT INTO iutra_pos.pos_organizations(id,name) VALUES($1,$2)',[ids.organization,'Test org']);
  const policy={walletEnabled:true,memberVerification:'pin',verificationAttempts:3,verificationLockMinutes:15,refundEnabled:true,partialRefunds:true,refundMax:'1000000',refundWindowDays:30,dualApproval:true};
  await pool.query('INSERT INTO iutra_pos.pos_stores(id,organization_id,name,policy) VALUES($1,$2,$3,$4::jsonb)',[ids.store,ids.organization,'Test store',JSON.stringify(policy)]);
  await pool.query('INSERT INTO iutra_pos.pos_devices(id,store_id,name,key_hash) VALUES($1,$2,$3,$4)',[ids.device,ids.store,'Test device',sha256(key)]);
  const passwordHash=await hashStaffPassword(password);
  for(const [id,name] of [[ids.staff,'cashier'],[ids.manager,'supervisor']]) {
    await pool.query('INSERT INTO iutra_pos.staff_users(id,login_name,display_name,password_hash) VALUES($1,$2,$2,$3)',[id,name,passwordHash]);
    await pool.query('INSERT INTO iutra_pos.pos_grants(staff_id,device_id,permissions) VALUES($1,$2,$3)',[id,ids.device,permissions]);
  }
  const menu={...catalog,release:'release-test',isExample:false};
  await pool.query('INSERT INTO iutra_pos.catalog_releases(release,catalog) VALUES($1,$2::jsonb)',[menu.release,JSON.stringify(menu)]);
  await pool.query('UPDATE iutra_pos.catalog_state SET current_release=$1 WHERE singleton=true',[menu.release]);
  return {db,pool,ids,key,password,menu,policy,permissions,auth:{user:{id:ids.staff},deviceId:ids.device,deviceKey:key},managerAuth:{user:{id:ids.manager},deviceId:ids.device,deviceKey:key},close:()=>db.close()};
}
