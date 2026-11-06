import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsDatabase } from '../test-support/operations-db.js';
import { OperationsStore } from '../src/operations.js';

const options={requestHashKey:'operations_review_secret_01234567890123456789'};
async function fixture(t) {
  const f=await operationsDatabase();t.after(()=>f.close());
  const store=new OperationsStore(f.pool,options);
  const call=async(command,input,auth=f.auth)=>(await store.execute(auth,randomUUID(),command,input)).result;
  const shift=await call('openShift',{openingCash:'0',responsibility:'review regression'});
  const bank={bankCode:'970436',accountNumber:'1234567890',accountName:'TEST STORE',verified:true,reason:'test',expectedVersion:0,currentPassword:f.password};
  const order=()=>call('createOrder',{clientOrderId:randomUUID(),shiftId:shift.id,menuRelease:f.menu.release,items:[{productId:'oolong',variantId:'oolong-500',quantity:1,toppings:[],options:[]}]});
  const topup=async()=>{
    const member=await call('createMember',{memberCode:randomUUID(),displayName:'Test',pin:'123456'});
    const request=await call('topup',{walletId:member.wallet.id,shiftId:shift.id,amount:'100000',method:'bank'});
    return {member,request};
  };
  return {...f,store,call,shift,bank,order,topup};
}

// PGlite serializes connections. These are privilege/state/SQL-CAS regressions,
// not a native PostgreSQL multi-connection concurrency test.
test('refund request and execution work without UPDATE privileges on immutable payments',async t=>{
  const f=await fixture(t),order=await f.order();
  const request=await f.call('requestPayment',{orderId:order.id,expectedVersion:order.version,method:'cash'});
  await f.call('confirmCash',{id:request.id,tendered:order.total});
  await f.pool.query('CREATE ROLE review_refund NOLOGIN');
  await f.pool.query('GRANT USAGE ON SCHEMA iutra_pos TO review_refund');
  await f.pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA iutra_pos TO review_refund');
  await f.pool.query('GRANT UPDATE ON iutra_pos.pos_orders,iutra_pos.pos_refunds,iutra_pos.pos_shifts TO review_refund');
  await f.pool.query('GRANT INSERT ON iutra_pos.pos_refunds,iutra_pos.pos_operations,iutra_pos.pos_audit,iutra_pos.pos_cash_movements,iutra_pos.pos_outbox TO review_refund');
  await f.pool.query('GRANT EXECUTE ON FUNCTION iutra_pos.pos_lock_authorization(uuid,uuid) TO review_refund');
  const rolePool={async connect(){const client=await f.pool.connect();return {release:client.release,async query(sql,params){const result=await client.query(sql,params);if(sql==='BEGIN')await client.query('SET LOCAL ROLE review_refund');return result;}};}};
  const store=new OperationsStore(rolePool,options);
  const call=async(command,input,auth=f.auth)=>(await store.execute(auth,randomUUID(),command,input)).result;
  const client=await rolePool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query('SELECT * FROM iutra_pos.pos_payments FOR UPDATE'),{code:'42501'});
  } finally {await client.query('ROLLBACK');client.release();}
  let refund=await call('requestRefund',{orderId:order.id,amount:order.total,reason:'test refund'});
  await assert.rejects(call('requestRefund',{orderId:order.id,amount:'1',reason:'over capacity'}),{code:'PAYMENT_STATE_CONFLICT'});
  refund=await call('approveRefund',{id:refund.id,expectedVersion:refund.version},f.managerAuth);
  refund=await call('startRefund',{id:refund.id,expectedVersion:refund.version});
  assert.equal(refund.status,'processing');
  refund=await call('finishRefund',{id:refund.id,expectedVersion:refund.version,outcome:'succeeded',externalRef:'',reason:'returned cash'});
  assert.equal(refund.status,'succeeded');
  assert.equal((await f.pool.query('SELECT amount::text AS amount FROM iutra_pos.pos_payments')).rows[0].amount,order.total);
});

test('bank SQL CAS rejects zero-version conflict even after an empty precheck',async t=>{
  const f=await fixture(t);
  const original=await f.call('setBank',f.bank);
  await assert.rejects(f.call('setBank',{...f.bank,accountNumber:'9999999999'}),{code:'VERSION_CONFLICT'});
  // Simulate the stale precheck explicitly; execute the real INSERT/ON CONFLICT in PGlite.
  let precheckRows=[];
  let casAttempts=0;
  const stalePool={async connect(){const client=await f.pool.connect();return {release:client.release,async query(sql,params){
    if(sql==='SELECT * FROM iutra_pos.pos_banks WHERE store_id=$1 FOR UPDATE') return {rows:precheckRows};
    if(sql.startsWith('INSERT INTO iutra_pos.pos_banks')) casAttempts++;
    return client.query(sql,params);
  }};}};
  const store=new OperationsStore(stalePool,options);
  const set=input=>store.execute(f.auth,randomUUID(),'setBank',input);
  await assert.rejects(set({...f.bank,accountNumber:'9999999999'}),{code:'VERSION_CONFLICT'});
  assert.equal(casAttempts,1);
  assert.deepEqual((await f.store.list(f.auth,'banks'))[0],original);
  const updated=await f.call('setBank',{...f.bank,expectedVersion:1,accountNumber:'8888888888'});
  assert.equal(updated.version,2);
  precheckRows=[original];
  await assert.rejects(set({...f.bank,expectedVersion:1}),{code:'VERSION_CONFLICT'});
  assert.equal(casAttempts,2);
  assert.deepEqual((await f.store.list(f.auth,'banks'))[0],updated);
});

test('additional bank sources stay reviewable without replacing funded topup source or amount',async t=>{
  const f=await fixture(t);await f.call('setBank',f.bank);
  const {member,request}=await f.topup();
  await f.pool.query("UPDATE iutra_pos.pos_wallets SET status='frozen' WHERE id=$1",[member.wallet.id]);
  const confirm=(externalRef,amount='100000')=>f.call('confirmBank',{id:request.id,externalRef,amount,bookedAt:new Date().toISOString(),note:'verified fact'});
  const first=await confirm('FIRST');
  assert.equal(first.exception.kind,'funded_pending_credit');
  const second=await confirm('SECOND','120000');
  await f.pool.query("UPDATE iutra_pos.pos_wallets SET status='active' WHERE id=$1",[member.wallet.id]);
  const third=await confirm('THIRD');
  for(const extra of [second,third]) {
    assert.equal(extra.exception.kind,'unmatched');
    assert.notEqual(extra.exception.bank_transaction_id,first.exception.bank_transaction_id);
    assert.equal((await f.call('reviewException',{id:extra.exception.id,resolution:'extra funds require separate handling'})).status,'reviewed');
  }
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM iutra_pos.pos_payments')).rows[0].n,0);
  const credited=await f.call('creditFundedTopup',{id:first.exception.id,reason:'recover original funding'});
  assert.equal(credited.payment.bank_transaction_id,first.exception.bank_transaction_id);
  assert.equal(credited.payment.amount,'100000');
  assert.equal((await f.store.list(f.auth,'wallets',{id:member.wallet.id})).principal_balance,'100000');
  assert.equal((await f.store.list(f.auth,'entries')).length,1);
  assert.equal((await f.store.list(f.auth,'payments')).length,1);
  const facts=(await f.pool.query('SELECT external_ref,amount::text AS amount FROM iutra_pos.pos_bank_transactions ORDER BY external_ref')).rows;
  assert.deepEqual(facts,[{external_ref:'FIRST',amount:'100000'},{external_ref:'SECOND',amount:'120000'},{external_ref:'THIRD',amount:'100000'}]);
  await assert.rejects(f.call('creditFundedTopup',{id:first.exception.id,reason:'retry'}),{code:'PAYMENT_STATE_CONFLICT'});
});

for(const purpose of ['order','topup']) test(`${purpose}: old bank funding is unmatched and retained; only one-second precision tolerance`,async t=>{
  const f=await fixture(t);await f.call('setBank',f.bank);
  let request,originId,table,member;
  if(purpose==='order') {
    const order=await f.order();originId=order.id;table='pos_orders';
    request=await f.call('requestPayment',{orderId:order.id,expectedVersion:order.version,method:'bank'});
  } else {
    ({request,member}=await f.topup());originId=request.topup_id;table='pos_topups';
  }
  // Deterministic origin, earlier than the request: no wall-clock boundary race.
  const origin=Date.now()-120000;
  await f.pool.query(`UPDATE iutra_pos.${table} SET created_at=$1 WHERE id=$2`,[new Date(origin).toISOString(),originId]);
  const confirm=(externalRef,bookedAt)=>f.call('confirmBank',{id:request.id,externalRef,amount:request.amount,bookedAt,note:'bank timestamp regression'});
  for(const [ref,time] of [['YEARS-OLD','2000-01-01T00:00:00.000Z'],['TOO-EARLY',new Date(origin-1001).toISOString()]]) {
    const result=await confirm(ref,time);
    assert.equal(result.exception.kind,'unmatched');
    const fact=(await f.pool.query('SELECT * FROM iutra_pos.pos_bank_transactions WHERE id=$1',[result.exception.bank_transaction_id])).rows[0];
    assert.equal(new Date(fact.booked_at).toISOString(),time);
    assert.equal(String(fact.amount),request.amount);
  }
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM iutra_pos.pos_payments')).rows[0].n,0);
  assert.equal((await f.store.list(f.auth,'paymentRequests',{id:request.id})).status,'pending');
  if(member) assert.equal((await f.store.list(f.auth,'wallets',{id:member.wallet.id})).principal_balance,'0');
  const paid=await confirm('SECONDS-PRECISION',new Date(origin-1000).toISOString());
  assert.equal(paid.payment.amount,request.amount);
  assert.equal((await f.store.list(f.auth,'payments')).length,1);
});
