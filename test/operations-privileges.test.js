import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsDatabase } from '../test-support/operations-db.js';
import { OperationsStore } from '../src/operations.js';

test('受限資料庫角色可鎖定並開班，不能修改授權、停用鎖定保護或改寫財務事實',async t=>{
  const f=await operationsDatabase();t.after(()=>f.close());
  await f.pool.query('CREATE ROLE pos_limited_test NOLOGIN');
  await f.pool.query('GRANT USAGE ON SCHEMA iutra_pos TO pos_limited_test');
  await f.pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA iutra_pos TO pos_limited_test');
  await f.pool.query('GRANT INSERT ON iutra_pos.pos_shifts,iutra_pos.pos_operations,iutra_pos.pos_audit TO pos_limited_test');
  const rolePool={async connect(){const client=await f.pool.connect(),query=client.query;return {release:client.release,async query(sql,params){const result=await query(sql,params);if(sql==='BEGIN')await query('SET LOCAL ROLE pos_limited_test');return result;}};}};
  const store=new OperationsStore(rolePool,{requestHashKey:'limited_database_role_hmac_secret_0123456789'});
  assert.equal((await store.context(f.auth)).store.id,f.ids.store);
  const key=randomUUID(),body={openingCash:'0',responsibility:'最小權限測試'};
  // The lock capability is not executable by PUBLIC.
  await assert.rejects(store.execute(f.auth,key,'openShift',body),{status:503});
  await f.pool.query('GRANT EXECUTE ON FUNCTION iutra_pos.pos_lock_authorization(uuid,uuid) TO pos_limited_test');
  const opened=await store.execute(f.auth,key,'openShift',body);
  assert.equal(opened.result.status,'open');
  assert.deepEqual(await store.execute(f.auth,key,'openShift',body),opened);
  for(const sql of [
    "UPDATE iutra_pos.pos_grants SET permissions='{bank.manage}'",
    'UPDATE iutra_pos.pos_devices SET active=false',
    'UPDATE iutra_pos.pos_stores SET active=false',
    'UPDATE iutra_pos.staff_users SET can_manage_catalog=true',
    'UPDATE iutra_pos.pos_payments SET amount=0',
    'TRUNCATE iutra_pos.pos_audit',
    'ALTER TABLE iutra_pos.pos_audit DISABLE TRIGGER ALL'
  ]) {
    const client=await rolePool.connect();
    try {await client.query('BEGIN');await assert.rejects(client.query(sql),error=>error.code==='42501');}
    finally {await client.query('ROLLBACK');client.release();}
  }
});
