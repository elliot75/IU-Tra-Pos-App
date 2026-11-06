import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OperationsStore } from '../src/operations.js';
import { bankQR, businessDate, csvCell } from '../src/pos-utils.js';
import { operationsDatabase } from '../test-support/operations-db.js';
import { createServer } from '../src/server.js';
import { createAuthTransport } from '../src/auth-transport.js';

test('營運交易、資金不變量與 SQL 約束（嵌入式 PostgreSQL）',async t=>{
  const fixture=await operationsDatabase(); t.after(()=>fixture.close());
  const {pool,auth,managerAuth,ids,menu}=fixture,store=new OperationsStore(pool,{requestHashKey:'independent_test_hmac_secret_1234567890'});
  const execute=(command,input,key=randomUUID(),actor=auth)=>store.execute(actor,key,command,input);
  const call=async(command,input,key,actor)=>(await execute(command,input,key,actor)).result;
  const item=(price='oolong-500',quantity=1)=>({productId:'oolong',variantId:price,quantity,toppings:[],options:[],customerNote:'顧客',internalNote:'店內秘密'});
  let shift,cashOrder,cashRequest,cashPayment,member,wallet,walletOrder,walletRequest,refund;
  const newOrder=async(variant='oolong-500',quantity=1)=>call('createOrder',{clientOrderId:randomUUID(),shiftId:shift.id,menuRelease:menu.release,items:[item(variant,quantity)]});
  await t.test('權限從設備綁定解析，收銀不自動有管理權',async()=>{
    const ctx=await store.context(auth); assert.equal(ctx.store.id,ids.store); assert.equal(ctx.currentShift,null);
    await assert.rejects(store.context({...auth,deviceKey:'wrong_device_key_1234567890123456789'}),{status:403});
    await assert.rejects(store.context({...auth,deviceId:randomUUID()}),{status:403});
    await pool.query('UPDATE iutra_pos.pos_grants SET permissions=$1 WHERE staff_id=$2',[['pos'],ids.staff]);
    await assert.rejects(execute('cashMovement',{}),{status:403});
    await pool.query('UPDATE iutra_pos.pos_grants SET permissions=$1 WHERE staff_id=$2',[fixture.permissions,ids.staff]);
  });
  await t.test('開班防重、穩定冪等鍵與內容衝突',async()=>{
    const key=randomUUID(),input={openingCash:'100000',responsibility:'自填班次責任資訊'};
    shift=await call('openShift',input,key); assert.equal(shift.opening_cash,'100000');
    assert.deepEqual(await call('openShift',input,key),shift);
    assert.equal((await store.operation(auth,key)).result.id,shift.id);
    await assert.rejects(execute('openShift',{...input,openingCash:'200000'},key),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(call('openShift',input),{code:'PAYMENT_STATE_CONFLICT'});
    await assert.rejects(store.operation(managerAuth,key),{status:404});
  });
  await t.test('伺服器取價、快照版本、現金找零與原子提交',async()=>{
    await assert.rejects(call('createOrder',{clientOrderId:randomUUID(),shiftId:shift.id,menuRelease:'example-v1',items:[item()]}),{code:'MENU_RELEASE_CONFLICT'});
    cashOrder=await newOrder(); assert.equal(cashOrder.total,'22000');
    await assert.rejects(call('updateOrder',{id:cashOrder.id,expectedVersion:2,menuRelease:menu.release,items:[item()]}),{code:'VERSION_CONFLICT'});
    cashRequest=await call('requestPayment',{orderId:cashOrder.id,expectedVersion:1,method:'cash'});
    await assert.rejects(call('confirmCash',{id:cashRequest.id,tendered:'20000'}),{code:'AMOUNT_MISMATCH'});
    assert.equal((await store.list(auth,'payments')).length,0);
    const key=randomUUID(),input={id:cashRequest.id,tendered:'100000'};
    const results=await Promise.all([call('confirmCash',input,key),call('confirmCash',input,key)]);
    assert.deepEqual(results[0],results[1]); cashPayment=results[0].payment;
    assert.equal(cashPayment.amount,'22000'); assert.equal(results[0].change,'78000');
    assert.equal(results[0].order.status,'completed');
    const movements=await store.list(auth,'cashMovements');assert.equal(movements[0].amount,'22000');
    const jobs=await store.list(auth,'printJobs');assert.equal(jobs.length,3);
    assert.ok(jobs.every(job=>!JSON.stringify(job.snapshot).includes('店內秘密')));
    await assert.rejects(call('requestPayment',{orderId:cashOrder.id,expectedVersion:3,method:'cash'}),{code:'PAYMENT_STATE_CONFLICT'});
    await assert.rejects(pool.query('UPDATE iutra_pos.pos_payments SET amount=1 WHERE id=$1',[cashPayment.id]),/append-only/);
    const report=await store.report(auth,shift.id);assert.equal(report.sales,'22000');assert.equal(report.expectedCash,'122000');
  });
  await t.test('銀行重新驗證、版本快照、重複與晚到款異常',async()=>{
    const bankInput={bankCode:'970436',accountNumber:'1234567890',accountName:'IUTRA',verified:true,reason:'測試銀行核實',expectedVersion:0,currentPassword:fixture.password};
    await assert.rejects(call('setBank',{...bankInput,currentPassword:'incorrect'}),{code:'REAUTHENTICATION_REQUIRED'});
    await call('setBank',bankInput);
    const order=await newOrder(),request=await call('requestPayment',{orderId:order.id,expectedVersion:1,method:'bank'});
    assert.equal(request.bankSnapshot.accountNumber,'1234567890');assert.match(request.qrPayload,/^000201/);
    await call('setBank',{...bankInput,accountNumber:'9876543210',expectedVersion:1});
    assert.equal((await store.list(auth,'paymentRequests',{id:request.id})).bank_snapshot.accountNumber,'1234567890');
    const confirm={id:request.id,externalRef:'bank-unique-001',amount:'22000',bookedAt:new Date().toISOString(),note:'已查店家銀行紀錄'};
    const paid=await call('confirmBank',confirm);assert.equal(paid.order.status,'completed');
    const duplicate=await call('confirmBank',confirm);assert.equal(duplicate.exception.kind,'duplicate');
    const lateOrder=await newOrder(),late=await call('requestPayment',{orderId:lateOrder.id,expectedVersion:1,method:'bank'});
    await call('cancelPayment',{id:late.id,reason:'取消付款'});
    const arrival=await call('confirmBank',{...confirm,id:late.id,externalRef:'late-transfer'});assert.equal(arrival.exception.kind,'late');
    const shortOrder=await newOrder(),short=await call('requestPayment',{orderId:shortOrder.id,expectedVersion:1,method:'bank'});
    const mismatch=await call('confirmBank',{...confirm,id:short.id,externalRef:'short-transfer',amount:'21000'});assert.equal(mismatch.exception.kind,'short');
    assert.equal((await store.list(auth,'orders',{id:shortOrder.id})).status,'awaiting_payment');
    const unmatched=await call('confirmBank',{...confirm,id:short.id,externalRef:''});assert.equal(unmatched.exception.kind,'unmatched');
    await call('cancelOrder',{id:lateOrder.id,expectedVersion:3,reason:'測試取消'});
    await call('cancelOrder',{id:shortOrder.id,expectedVersion:2,reason:'待核對款獨立保留'});
  });
  await t.test('會員查詢遮罩，儲值先收款，同筆來源只入帳一次',async()=>{
    member=await call('createMember',{memberCode:'MEMBER001',displayName:'測試會員',pin:'123456'});wallet=member.wallet;
    const found=(await store.list(auth,'members'))[0];assert.equal(found.member_code,'***R001');assert.ok(!Object.hasOwn(found,'pin_hash'));
    const request=await call('topup',{walletId:wallet.id,shiftId:shift.id,amount:'100000',method:'cash'});
    assert.equal((await store.list(auth,'wallets',{id:wallet.id})).principal_balance,'0');
    const key=randomUUID(),input={id:request.id,tendered:'100000'};await call('confirmCash',input,key);await call('confirmCash',input,key);
    assert.equal((await store.list(auth,'wallets',{id:wallet.id})).principal_balance,'100000');
    const entries=await store.list(auth,'entries');assert.equal(entries.length,1);assert.equal(entries[0].delta,'100000');
    const report=await store.report(auth,shift.id);assert.equal(report.sales,'44000');assert.equal(report.topups,'100000');assert.equal(report.expectedCash,'222000');
    await assert.rejects(pool.query('DELETE FROM iutra_pos.pos_wallet_entries WHERE wallet_id=$1',[wallet.id]),/append-only/);
  });
  await t.test('驗證鎖定持久保存、token 綁付款與錢包',async()=>{
    walletOrder=await newOrder('oolong-700',3); walletRequest=await call('requestPayment',{orderId:walletOrder.id,expectedVersion:1,method:'wallet'});
    const input={memberId:member.id,pin:'000000',purpose:'payment',paymentRequestId:walletRequest.id};
    for(let i=0;i<3;i++) assert.equal((await call('verifyMember',input)).verified,false);
    assert.equal((await call('verifyMember',{...input,pin:'123456'})).verified,false);
    const attempts=await pool.query('SELECT failed_attempts FROM iutra_pos.pos_members WHERE id=$1',[member.id]);assert.equal(attempts.rows[0].failed_attempts,3);
    await pool.query('UPDATE iutra_pos.pos_members SET locked_until=now()-interval \'1 minute\' WHERE id=$1',[member.id]);
    const verification=await call('verifyMember',{...input,pin:'123456'});assert.equal(verification.verified,true);
    const key=randomUUID(),payload={id:walletRequest.id,walletId:wallet.id,verificationToken:verification.verificationToken};
    const results=await Promise.all([call('chargeWallet',payload,key),call('chargeWallet',payload,key)]);assert.deepEqual(results[0],results[1]);
    assert.equal((await store.list(auth,'wallets',{id:wallet.id})).principal_balance,'28000');
    const journal=await pool.query('SELECT result::text FROM iutra_pos.pos_operations WHERE command=\'verifyMember\'');assert.ok(journal.rows.every(r=>!r.result.includes(verification.verificationToken)));
    const tooMuch=await newOrder('oolong-700',2),next=await call('requestPayment',{orderId:tooMuch.id,expectedVersion:1,method:'wallet'});
    const verify=await call('verifyMember',{...input,pin:'123456',paymentRequestId:next.id});
    await assert.rejects(call('chargeWallet',{id:next.id,walletId:wallet.id,verificationToken:verify.verificationToken}),{code:'INSUFFICIENT_BALANCE'});
    assert.equal((await store.list(auth,'wallets',{id:wallet.id})).principal_balance,'28000');
    await call('cancelOrder',{id:tooMuch.id,expectedVersion:2,reason:'餘額不足不混合收款'});
  });
  await t.test('退款保留不超收款，unknown 不釋放；核准帳號分離',async()=>{
    refund=await call('requestRefund',{orderId:cashOrder.id,amount:'12000',reason:'測試退款'});
    await assert.rejects(call('requestRefund',{orderId:cashOrder.id,amount:'12000',reason:'重複退款'}),{code:'PAYMENT_STATE_CONFLICT'});
    await assert.rejects(call('approveRefund',{id:refund.id,expectedVersion:1}),{code:'DUAL_APPROVAL_REQUIRED'});
    refund=await call('approveRefund',{id:refund.id,expectedVersion:1},undefined,managerAuth);
    refund=await call('startRefund',{id:refund.id,expectedVersion:refund.version});assert.equal(refund.status,'processing');
    refund=await call('finishRefund',{id:refund.id,expectedVersion:refund.version,outcome:'unknown',externalRef:'',reason:'交付待核對'});
    await assert.rejects(call('cancelRefund',{id:refund.id,expectedVersion:refund.version,reason:'不可釋放'}),{code:'PAYMENT_STATE_CONFLICT'});
    await assert.rejects(call('requestRefund',{orderId:cashOrder.id,amount:'12000',reason:'仍保留額度'}),{code:'PAYMENT_STATE_CONFLICT'});
    refund=await call('finishRefund',{id:refund.id,expectedVersion:refund.version,outcome:'succeeded',externalRef:'',reason:'已核對現金交付'});
    assert.equal(refund.status,'succeeded');assert.equal((await store.report(auth,shift.id)).expectedCash,'210000');
    const old=await store.list(auth,'orders',{id:cashOrder.id});assert.equal(old.total,'22000');assert.equal(old.status,'completed');
  });
  await t.test('列印工作未知不得自動重送、補印另建且標記，開櫃不可補印',async()=>{
    const jobs=await store.list(auth,'printJobs');const receipt=jobs.find(j=>j.document_kind==='receipt');
    const sending=await call('claimPrint',{id:receipt.id,expectedVersion:1});
    const unknown=await call('finishPrint',{id:receipt.id,expectedVersion:sending.version,outcome:'unknown',reason:'送出後斷線'});
    await assert.rejects(call('claimPrint',{id:unknown.id,expectedVersion:unknown.version}),{code:'PAYMENT_STATE_CONFLICT'});
    await assert.rejects(call('finishPrint',{id:unknown.id,expectedVersion:unknown.version,outcome:'failed',reason:'不確定不可回到可重試'}),{code:'PAYMENT_STATE_CONFLICT'});
    const copy=await call('reprint',{id:unknown.id,reason:'店員已核對紙張'});assert.equal(copy.reprint_of,unknown.id);assert.equal(copy.snapshot.reprint,true);
    await assert.rejects(call('reprint',{id:jobs.find(j=>j.document_kind==='drawer').id,reason:'開櫃不可補印'}),{status:403});
  });
  await t.test('失敗回滾付款與帳本，關班差異及報表不雙計儲值',async()=>{
    await call('cashMovement',{shiftId:shift.id,direction:'out',amount:'10000',category:'零用金',reason:'採購雜支'});
    const report=await store.report(auth,shift.id);assert.equal(report.expectedCash,'200000');assert.equal(report.sales,'116000');assert.equal(report.topups,'100000');assert.equal(report.refunds,'12000');
    const closed=await call('closeShift',{id:shift.id,expectedVersion:1,countedCash:'199000',reason:'少一千待核對'});
    assert.equal(closed.expected_cash,'200000');assert.equal(closed.difference,'-1000');
    await assert.rejects(newOrder(),{code:'PAYMENT_STATE_CONFLICT'});
    const csv=await store.report(auth,shift.id,true);assert.match(csv,/VND/);assert.match(csv,/200000/);
    assert.equal((await store.report(auth,shift.id)).reconciled,false); // unresolved bank facts remain visible.
  });
  await t.test('HTTP 保護、冪等標頭、QR 撤碼與預設停用',async()=>{
    const staffAuth={authenticate:async()=>({id:ids.staff})};
    const transport=createAuthTransport({mode:'local-development',host:'127.0.0.1',trustedProxyIPs:[]});
    const server=createServer({pool,staffAuth,authTransport:transport,operations:store,enableOperations:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer test','x-pos-device':ids.device,'x-pos-key':fixture.key,'content-type':'application/json'};
    assert.equal((await fetch(base+'/api/v1/pos/context',{headers})).status,200);
    assert.equal((await fetch(base+'/api/v1/pos/context',{headers:{...headers,'x-pos-key':'bad'}})).status,403);
    assert.equal((await fetch(base+'/api/v1/pos/commands/openShift',{method:'POST',headers,body:JSON.stringify({openingCash:'0',responsibility:'測試'})})).status,400);
    assert.equal((await fetch(base+`/api/v1/pos/qr/${cashRequest.id}`,{headers})).status,409);
  });
});

test('營業日切點、CSV 公式防護、VietQR 檢查碼',()=>{
  assert.equal(businessDate(new Date('2026-11-05T18:00:00Z'),'Asia/Ho_Chi_Minh',120),'2026-11-05');
  assert.equal(businessDate(new Date('2026-11-05T20:00:00Z'),'Asia/Ho_Chi_Minh',120),'2026-11-06');
  assert.equal(csvCell(' =SUM(A1)'),'"\' =SUM(A1)"');
  const qr=bankQR({bankCode:'970436',accountNumber:'1234567890',accountName:'IUTRA'},'51000','TEST001');
  assert.match(qr,/540551000/);assert.match(qr,/6304[0-9A-F]{4}$/);
  assert.equal(qr,bankQR({bankCode:'970436',accountNumber:'1234567890',accountName:'IUTRA'},'51000','TEST001'));
});
