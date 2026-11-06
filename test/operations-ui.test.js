import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingOperations, PENDING_KEY, httpRequest, importCart, money, newUUID, collectionPage } from '../public/operations.js';

const deviceId='11111111-1111-4111-8111-111111111111';
const otherDevice='22222222-2222-4222-8222-222222222222';
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const identity={userId:'staff-one',deviceId};
const storage=()=>{
  const values=new Map();
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
};
const fault=status=>Object.assign(new Error('uncertain'),{status});
const complete=(command,result={id:'saved'})=>({key,command,result});
const response=(data,status=200)=>({ok:status<400,status,json:async()=>status<400?{data}:{error:{message:'rejected'}}});

for(const status of [0,401,403,404,408,429,500,502,503]) {
  test(`retain uncertain command on HTTP ${status}, then replay exact original key/body`,async()=>{
    const store=storage(),calls=[];let fail=true;
    const journal=new PendingOperations({storage:store,uuid:()=>key,send:async(path,options)=>{
      assert.ok(store.getItem(PENDING_KEY),'journal exists before send');calls.push({path,...options});
      if(fail)throw fault(status);return complete('confirmCash');
    }});
    const body={id:'request-one',tendered:'100000'};
    await assert.rejects(journal.start('confirmCash',body,identity));body.tendered='200000';
    assert.equal(journal.blocked,true);assert.equal(journal.pending.userId,identity.userId);
    await assert.rejects(journal.start('requestPayment',{method:'bank'},identity),/先查詢/);
    fail=false;await journal.retry(identity);
    assert.equal(calls[0].key,key);assert.equal(calls[1].key,key);
    assert.equal(calls[0].body,calls[1].body);assert.equal(JSON.parse(calls[1].body).tendered,'100000');
    assert.equal(journal.blocked,false);assert.equal(store.getItem(PENDING_KEY),null);
  });
}
for(const status of [400,409,422]) {
  test(`clear only definitive validation response ${status}`,async()=>{
    const store=storage(),journal=new PendingOperations({storage:store,uuid:()=>key,send:async()=>{throw fault(status);}});
    await assert.rejects(journal.start('requestPayment',{orderId:'one',expectedVersion:1,method:'cash'},identity));
    assert.equal(journal.pending,null);assert.equal(store.getItem(PENDING_KEY),null);
  });
}
test('restore after reload; reject a different employee or device without any request',async()=>{
  const store=storage();
  const first=new PendingOperations({storage:store,uuid:()=>key,send:async()=>{throw fault(401);}});
  await assert.rejects(first.start('confirmCash',{id:'request',tendered:'50000'},identity));
  let calls=0;
  const restored=new PendingOperations({storage:store,send:async()=>{calls++;return complete('confirmCash');}});
  for(const wrong of [{userId:'staff-two',deviceId},{userId:identity.userId,deviceId:otherDevice}]) {
    await assert.rejects(restored.retry(wrong),/原員工帳號與原設備/);
    await assert.rejects(restored.query(wrong),/原員工帳號與原設備/);
  }
  assert.equal(calls,0);assert.equal(restored.pending.key,key);
  await restored.retry(identity);assert.equal(calls,1);assert.equal(restored.pending,null);
});
test('query not-found and authorization failures never discard an unresolved command',async()=>{
  const store=storage();let status=0;
  const journal=new PendingOperations({storage:store,uuid:()=>key,send:async()=>{throw fault(status);}});
  await assert.rejects(journal.start('requestPayment',{orderId:'one',expectedVersion:1,method:'cash'},identity));
  for(status of [404,401,403,500]) {await assert.rejects(journal.query(identity));assert.ok(journal.pending);}
});
test('query verifies operation identity before clearing, then returns committed result',async()=>{
  const store=storage();let result=null;
  const journal=new PendingOperations({storage:store,uuid:()=>key,send:async()=>result || Promise.reject(fault(0))});
  await assert.rejects(journal.start('confirmCash',{id:'request',tendered:'50000'},identity));
  result={...complete('confirmCash'),key:otherDevice};
  await assert.rejects(journal.query(identity),/識別/);assert.ok(journal.pending);
  result=complete('confirmCash',{payment:{amount:'50000'},change:'0'});
  assert.deepEqual(await journal.query(identity),result);assert.equal(journal.pending,null);
});
test('PIN, verification token and password stay in memory; secret-bearing reload requires a query or fresh verification',async()=>{
  for(const [command,body,secretName] of [
    ['chargeWallet',{id:'request',walletId:'wallet',verificationToken:'token-secret'},'verificationToken'],
    ['createMember',{memberCode:'member',displayName:'name',pin:'123456'},'pin'],
    ['setBank',{bankCode:'970436',accountNumber:'12345678',accountName:'Store',verified:true,reason:'checked',expectedVersion:1,currentPassword:'password-secret'},'currentPassword']
  ]) {
    const store=storage(),sent=[];
    const journal=new PendingOperations({storage:store,uuid:()=>key,send:async(path,options)=>{sent.push(options);throw fault(0);}});
    await assert.rejects(journal.start(command,body,identity));
    const saved=JSON.parse(store.getItem(PENDING_KEY));
    assert.equal(saved.body[secretName],undefined);assert.equal(saved.requiresSecret,true);
    assert.equal(JSON.parse(sent[0].body)[secretName],body[secretName]);
    await assert.rejects(journal.retry(identity));assert.equal(sent[0].body,sent[1].body);
    let queries=0;
    const restored=new PendingOperations({storage:store,send:async(path)=>{queries++;assert.match(path,/\/operations\//);return complete(command);}});
    assert.equal(restored.canRetry,false);await assert.rejects(restored.retry(identity),/重新驗證/);assert.equal(queries,0);
    await restored.query(identity);assert.equal(queries,1);
  }
});
test('storage unavailable blocks sending and malformed stored data blocks new commands',async()=>{
  let calls=0;
  const full={getItem:()=>null,setItem(){throw new Error('quota');},removeItem(){}};
  const journal=new PendingOperations({storage:full,uuid:()=>key,send:async()=>{calls++;}});
  await assert.rejects(journal.start('openShift',{openingCash:'0',responsibility:'staff'},identity),/操作尚未送出/);assert.equal(calls,0);
  const store=storage();store.setItem(PENDING_KEY,'{broken');
  const corrupt=new PendingOperations({storage:store,send:async()=>{calls++;}});
  assert.equal(corrupt.blocked,true);await assert.rejects(corrupt.start('openShift',{},identity));assert.equal(calls,0);
});
test('concurrent double-click cannot send another intent or replay while original request is in flight',async()=>{
  let resolve;let calls=0;const store=storage();
  const journal=new PendingOperations({storage:store,uuid:()=>key,send:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const first=journal.start('confirmCash',{id:'request',tendered:'50000'},identity);
  await assert.rejects(journal.retry(identity),/正在處理/);
  await assert.rejects(journal.query(identity),/正在處理/);
  await assert.rejects(journal.start('requestPayment',{method:'bank'},identity));
  assert.equal(calls,1);resolve(complete('confirmCash'));await first;
});
test('POS requests always include employee and device authentication and fixed request key',async()=>{
  let sent;
  const result=await httpRequest('/api/v1/pos/commands/confirmCash',{method:'POST',body:'{"id":"request","tendered":"50000"}',key,token:'session',deviceId,deviceKey:'device-secret',fetcher:async(path,options)=>{sent={path,...options};return response(complete('confirmCash'));}});
  assert.equal(sent.headers.Authorization,'Bearer session');assert.equal(sent.headers['X-POS-Device'],deviceId);assert.equal(sent.headers['X-POS-Key'],'device-secret');assert.equal(sent.headers['Idempotency-Key'],key);
  assert.equal(sent.credentials,'omit');assert.equal(sent.cache,'no-store');assert.equal(result.key,key);
  await assert.rejects(httpRequest('/api/v1/pos/orders',{fetcher:()=>{throw new Error('must not send');}}),/請登入/);
});
test('deadline aborts requests and malformed successful responses retain pending request',async()=>{
  await assert.rejects(httpRequest('/api/v1/auth/config',{deadline:5,fetcher:(path,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'}))))}),/逾時/);
  const store=storage(),journal=new PendingOperations({storage:store,uuid:()=>key,send:async()=>({unexpected:true})});
  await assert.rejects(journal.start('openShift',{openingCash:'0',responsibility:'staff'},identity),/原操作識別/);
  assert.ok(journal.pending);
});
test('cart import accepts raw item selection only, ignores supplied prices and metadata',()=>{
  const cart=importCart({menuRelease:'release-one',displayPair:'display-pair',items:[{productId:'tea',variantId:'large',quantity:2,toppings:[{id:'pearl',portions:1,price:'1'}],options:[{groupId:'ice',valueIds:['less']}],customerNote:'少冰',internalNote:'staff',unitPrice:'1',total:'2'}],total:'2'});
  assert.deepEqual(cart,{menuRelease:'release-one',items:[{productId:'tea',variantId:'large',quantity:2,toppings:[{id:'pearl',portions:1}],options:[{groupId:'ice',valueIds:['less']}],customerNote:'少冰',internalNote:'staff'}]});
  assert.throws(()=>importCart({menuRelease:'one',items:[]}));
  assert.throws(()=>importCart({menuRelease:'one',items:[{productId:'tea',variantId:'large',quantity:0,toppings:[]}]}));
});
test('secret recovery preserves original intent, employee, device and operation key',async()=>{
  for(const [command,body,secret] of [
    ['chargeWallet',{id:'request',walletId:'wallet',verificationToken:'original'},'verificationToken'],
    ['createMember',{memberCode:'member',displayName:'name',pin:'123456'},'pin'],
    ['setBank',{bankCode:'970436',accountNumber:'12345678',currentPassword:'original'},'currentPassword']
  ]) {
    const saved=storage();
    const first=new PendingOperations({storage:saved,uuid:()=>key,send:async()=>{throw fault(503);}});
    await assert.rejects(first.start(command,body,identity));
    const calls=[],restored=new PendingOperations({storage:saved,send:async(path,options)=>{calls.push({path,...options});return complete(command);}});
    const recovered={...JSON.parse(saved.getItem(PENDING_KEY)).body,[secret]:'new-verification'};
    await assert.rejects(restored.resumeSecret(recovered,{...identity,deviceId:otherDevice}),/原員工帳號與原設備/);
    await assert.rejects(restored.resumeSecret({...recovered,amount:'999999'},identity),/不能變更對象或金額/);
    assert.equal(calls.length,0);assert.equal(restored.canRetry,false);
    await restored.resumeSecret(recovered,identity);
    assert.equal(calls.length,1);assert.equal(calls[0].key,key);assert.equal(JSON.parse(calls[0].body)[secret],'new-verification');assert.equal(saved.getItem(PENDING_KEY),null);
  }
});
test('deadline settles even if transport or body ignores abort; late response cannot clear the journal',async()=>{
  for(const stage of ['headers','body']) {
    let finish;
    const fetcher=stage==='headers'?()=>new Promise(resolve=>{finish=resolve;}):async()=>({ok:true,json:()=>new Promise(resolve=>{finish=resolve;})});
    const saved=storage(),journal=new PendingOperations({storage:saved,uuid:()=>key,send:()=>httpRequest('/api/v1/auth/config',{deadline:5,fetcher})});
    await assert.rejects(journal.start('confirmCash',{id:'request',tendered:'50000'},identity),/逾時/);
    assert.equal(journal.busy,false);assert.equal(journal.pending.key,key);
    finish(stage==='headers'?response(complete('confirmCash')):{data:complete('confirmCash')});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(journal.pending.key,key);
  }
});
test('order recovery retains toppings and the exact request across reload',async()=>{
  const saved=storage(),body={clientOrderId:key,shiftId:otherDevice,menuRelease:'release',items:[{productId:'tea',variantId:'large',quantity:1,toppings:[{id:'pearl',portions:2}],options:[]}]};
  const first=new PendingOperations({storage:saved,uuid:()=>key,send:async()=>{throw fault(0);}});
  await assert.rejects(first.start('createOrder',body,identity));
  const restored=new PendingOperations({storage:saved,send:async(path,options)=>{assert.deepEqual(JSON.parse(options.body),body);assert.equal(options.key,key);return complete('createOrder');}});
  assert.equal(restored.pending.requiresSecret,false);assert.equal(restored.canRetry,true);
  await restored.retry(identity);assert.equal(restored.blocked,false);
});
test('permission loss after commit retains the key and cannot create a second cash movement',async()=>{
  const saved=storage(),committed=new Map();let allowed=true,loseResponse=true;
  const send=async(path,options)=>{
    if(!allowed)throw fault(403);
    if(!committed.has(options.key))committed.set(options.key,complete('cashMovement'));
    if(loseResponse){loseResponse=false;throw fault(0);}return committed.get(options.key);
  };
  const journal=new PendingOperations({storage:saved,uuid:()=>key,send}),body={shiftId:otherDevice,direction:'in',amount:'5000',category:'cash',reason:'physical receipt'};
  await assert.rejects(journal.start('cashMovement',body,identity));allowed=false;
  await assert.rejects(journal.retry(identity));assert.equal(journal.pending.key,key);
  await assert.rejects(journal.start('cashMovement',body,identity));allowed=true;
  const restored=new PendingOperations({storage:saved,send});await restored.retry(identity);
  assert.equal(committed.size,1);assert.equal(restored.blocked,false);
});
test('collection pagination reaches records beyond fifty and preserves loaded targets',async()=>{
  const rows=Array.from({length:123},(_,i)=>({id:String(123-i).padStart(8,'0')+'-1111-4111-8111-111111111111'}));
  const send=async path=>{const url=new URL(path,'http://local');const before=url.searchParams.get('before');return rows.filter(row=>!before||row.id<before).slice(0,50);};
  let page=await collectionPage(send,'wallets');assert.equal(page.hasMore,true);
  page=await collectionPage(send,'wallets',page.rows,true);assert.equal(page.rows.length,100);
  page=await collectionPage(send,'wallets',page.rows,true);assert.equal(page.hasMore,false);assert.deepEqual(page.rows,rows);
  assert.equal((await collectionPage(send,'wallets',page.rows,false)).rows.length,50);
});
test('VND formatting preserves large integer precision and UUID generation works without randomUUID',()=>{
  assert.equal(money('9007199254740993'),'9.007.199.254.740.993 ₫');assert.equal(money('oops'),'—');
  assert.match(newUUID(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
