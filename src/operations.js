import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceError } from './catalog-store.js';
import { ValidationError, quoteOrder } from './pricing.js';
import { hashStaffPassword, verifyStaffPassword } from './staff-auth.js';
import { amount, bankQR, businessDate, canonical, csvCell, fail, fields, jsonSafe, sha256, text, uuid, version } from './pos-utils.js';

export const PERMISSIONS = Object.freeze(['pos','cash.manage','bank.confirm','bank.manage','members','members.manage','wallet.topup','wallet.charge','wallet.adjust','refund.request','refund.approve','refund.execute','reports','print','print.reprint','audit','export']);
const unavailable = () => new ServiceError(503,'TEMPORARILY_UNAVAILABLE','營運服務尚未啟用或暫時無法使用；請查詢原操作，不要重複收款');
const missing = () => fail(404,'NOT_FOUND','找不到此範圍的資料');
const stateConflict = message => fail(409,'PAYMENT_STATE_CONFLICT',message);
const requirePermission = (ctx, permission) => { if (!ctx.permissions.includes(permission)) fail(403,'FORBIDDEN','沒有此操作權限'); };
const checkVersion = (row,value) => { if(row.version!==version(value)) fail(409,'VERSION_CONFLICT','資料已變更，請重新讀取'); };
const row = result => result.rows[0] ?? missing();
const permissionFor = {
  openShift:'pos',closeShift:'pos',cashMovement:'cash.manage',createOrder:'pos',updateOrder:'pos',cancelOrder:'pos',requestPayment:'pos',cancelPayment:'pos',confirmCash:'pos',confirmBank:'bank.confirm',
  createMember:'members.manage',verifyMember:'wallet.charge',topup:'wallet.topup',chargeWallet:'wallet.charge',adjustWallet:'wallet.adjust',
  requestRefund:'refund.request',approveRefund:'refund.approve',startRefund:'refund.execute',finishRefund:'refund.execute',cancelRefund:'refund.request',
  reprint:'print.reprint',claimPrint:'print',finishPrint:'print',setBank:'bank.manage',setProduction:'pos',reviewException:'bank.confirm',creditFundedTopup:'bank.confirm'
};
// All objects resolve through a database-backed device grant; caller-supplied store IDs are never used.
export class OperationsStore {
  constructor(pool, { requestHashKey = process.env.POS_REQUEST_HMAC_KEY } = {}) { this.pool=pool; this.requestHashKey=requestHashKey; }
  async transaction(work) {
    if(!this.pool) throw unavailable();
    for(let attempt=0;attempt<3;attempt++) {
      let client;
      try {
        client=await this.pool.connect(); await client.query('BEGIN');
        const result=await work(client); await client.query('COMMIT'); return jsonSafe(result);
      } catch(error) {
        if(client) { try { await client.query('ROLLBACK'); } catch {} }
        if(['40P01','40001'].includes(error.code) && attempt<2) continue;
        if(error instanceof ServiceError || error instanceof ValidationError) throw error;
        if(error.code==='23505') fail(409,'DUPLICATE_RESOURCE','業務識別已存在，請查詢原紀錄');
        throw unavailable();
      } finally { client?.release(); }
    }
  }
  async authorize(db,auth,lock=false) {
    const deviceId=uuid(auth.deviceId), staffId=uuid(auth.user.id);
    if(typeof auth.deviceKey!=='string' || !/^[A-Za-z0-9_-]{32,128}$/.test(auth.deviceKey)) fail(403,'FORBIDDEN','設備憑證無效');
    if(lock) await db.query('SELECT iutra_pos.pos_lock_authorization($1,$2)',[deviceId,staffId]);
    const result=await db.query(`SELECT d.id AS device_id,d.name AS device_name,d.key_hash,s.id AS store_id,s.name AS store_name,s.timezone,s.day_cutoff,s.policy,g.permissions
      FROM iutra_pos.pos_devices d JOIN iutra_pos.pos_stores s ON s.id=d.store_id
      JOIN iutra_pos.pos_grants g ON g.device_id=d.id JOIN iutra_pos.staff_users u ON u.id=g.staff_id
      WHERE d.id=$1 AND g.staff_id=$2 AND d.active AND s.active AND u.active`, [deviceId,staffId]);
    const found=result.rows[0];
    if(!found || !timingSafeEqual(Buffer.from(sha256(auth.deviceKey),'hex'),Buffer.from(found.key_hash,'hex'))) fail(403,'FORBIDDEN','設備未啟用或帳號未獲授權');
    return {...found,staffId,deviceId,storeId:found.store_id,permissions:found.permissions,db};
  }
  async context(auth) {
    return this.transaction(async db=>{
      const ctx=await this.authorize(db,auth);
      return {store:{id:ctx.storeId,name:ctx.store_name,timezone:ctx.timezone},device:{id:ctx.deviceId,name:ctx.device_name},permissions:ctx.permissions,policy:ctx.policy,
        currentShift:(await db.query("SELECT * FROM iutra_pos.pos_shifts WHERE device_id=$1 AND status='open'",[ctx.deviceId])).rows[0]??null};
    });
  }
  async execute(auth,key,command,input,requestId=randomUUID()) {
    key=uuid(key); uuid(requestId);
    if(!Object.hasOwn(permissionFor,command)) fail(404,'NOT_FOUND','找不到操作');
    const hashInput=command==='chargeWallet'?{...input,verificationToken:'[verification required]'}:command==='setBank'?{...input,currentPassword:'[reauthentication required]'}:input;
    if(typeof this.requestHashKey!=='string' || this.requestHashKey.length<32) throw unavailable();
    const requestHash=createHmac('sha256',this.requestHashKey).update(canonical({command,input:hashInput})).digest('hex');
    return this.transaction(async db=>{
      const ctx=await this.authorize(db,auth,true); requirePermission(ctx,permissionFor[command]);
      const previous=(await db.query('SELECT command,request_hash,result FROM iutra_pos.pos_operations WHERE staff_id=$1 AND device_id=$2 AND key=$3',[ctx.staffId,ctx.deviceId,key])).rows[0];
      if(previous) {
        if(previous.command!==command || previous.request_hash!==requestHash) fail(409,'IDEMPOTENCY_CONFLICT','相同操作識別不可用於不同內容');
        return {key,command,result:previous.result};
      }
      const result=await this[command](ctx,input);
      // Verification tokens are returned only once; neither PIN nor token is stored in the operation journal.
      const saved=command==='verifyMember'?{verified:result.verified,memberId:result.memberId,message:result.message}:result;
      await db.query('INSERT INTO iutra_pos.pos_operations(id,store_id,device_id,staff_id,key,command,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[randomUUID(),ctx.storeId,ctx.deviceId,ctx.staffId,key,command,requestHash,JSON.stringify(jsonSafe(saved))]);
      await this.audit(ctx,command,result.id??result.order?.id??null,input.reason??'',{operationKey:key},requestId);
      return {key,command,result};
    });
  }
  async audit(ctx,action,id,reason,safeData,requestId=randomUUID()) {
    await ctx.db.query('INSERT INTO iutra_pos.pos_audit(id,store_id,device_id,actor_id,action,object_id,reason,safe_data,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[randomUUID(),ctx.storeId,ctx.deviceId,ctx.staffId,action,id,reason,JSON.stringify(safeData),requestId]);
  }
  async outbox(ctx,id,event,payload) {
    await ctx.db.query('INSERT INTO iutra_pos.pos_outbox(id,store_id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[randomUUID(),ctx.storeId,id,event,JSON.stringify(jsonSafe(payload))]);
  }
  async shift(ctx,id) {
    const found=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_shifts WHERE id=$1 AND store_id=$2 AND device_id=$3 FOR UPDATE',[uuid(id),ctx.storeId,ctx.deviceId]));
    if(found.status!=='open') stateConflict('班次已關閉，不能新增資金操作');
    return found;
  }
  async currentShift(ctx) {
    const found=row(await ctx.db.query("SELECT * FROM iutra_pos.pos_shifts WHERE device_id=$1 AND status='open' FOR UPDATE",[ctx.deviceId]));
    return found;
  }
  async order(ctx,id,{ownDevice=true}={}) {
    return row(await ctx.db.query(`SELECT * FROM iutra_pos.pos_orders WHERE id=$1 AND store_id=$2 ${ownDevice?'AND device_id=$3':''} FOR UPDATE`,ownDevice?[uuid(id),ctx.storeId,ctx.deviceId]:[uuid(id),ctx.storeId]));
  }
  async paymentRequest(ctx,id) {
    return row(await ctx.db.query('SELECT * FROM iutra_pos.pos_payment_requests WHERE id=$1 AND store_id=$2 AND device_id=$3 FOR UPDATE',[uuid(id),ctx.storeId,ctx.deviceId]));
  }
  async pending(ctx,request,method) {
    if(request.method!==method || request.status!=='pending') stateConflict('付款方式或狀態不符；請核對原操作');
    if(request.expires_at && new Date(request.expires_at)<=new Date()) stateConflict('付款請求已到期，需先取消並核對原請求');
    await this.shift(ctx,request.shift_id);
    if(request.order_id) {
      const order=await this.order(ctx,request.order_id);
      if(order.status!=='awaiting_payment' || order.version!==request.order_version || String(order.total)!==String(request.amount)) stateConflict('訂單已變更');
    }
  }
  async openShift(ctx,input) {
    fields(input,['openingCash','responsibility']); const opening=amount(input.openingCash),responsibility=text(input.responsibility,100);
    if((await ctx.db.query("SELECT id FROM iutra_pos.pos_shifts WHERE device_id=$1 AND status='open'",[ctx.deviceId])).rows.length) stateConflict('此設備已有開啟班次');
    return row(await ctx.db.query('INSERT INTO iutra_pos.pos_shifts(id,store_id,device_id,opened_by,responsibility,opening_cash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),ctx.storeId,ctx.deviceId,ctx.staffId,responsibility,String(opening)]));
  }
  async closeShift(ctx,input) {
    fields(input,['id','expectedVersion','countedCash','reason']); const shift=await this.shift(ctx,input.id); checkVersion(shift,input.expectedVersion);
    const counted=amount(input.countedCash),reason=text(input.reason);
    const unresolved=await ctx.db.query("SELECT id FROM iutra_pos.pos_payment_requests WHERE shift_id=$1 AND status IN ('pending','processing','unknown') UNION ALL SELECT id FROM iutra_pos.pos_orders WHERE shift_id=$1 AND status IN ('draft','awaiting_payment') UNION ALL SELECT id FROM iutra_pos.pos_refunds WHERE executed_shift_id=$1 AND status IN ('processing','unknown') LIMIT 1",[shift.id]);
    if(unresolved.rows.length) stateConflict('班次仍有未完成訂單、付款或退款，請先核對');
    const expected=await this.expectedCash(ctx,shift);
    return row(await ctx.db.query("UPDATE iutra_pos.pos_shifts SET status='closed',version=version+1,counted_cash=$1,expected_cash=$2,difference=$3,close_reason=$4,closed_by=$5,closed_at=now() WHERE id=$6 RETURNING *",[String(counted),String(expected),String(counted-expected),reason,ctx.staffId,shift.id]));
  }
  async expectedCash(ctx,shift) {
    const value=row(await ctx.db.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::text AS value FROM iutra_pos.pos_cash_movements WHERE shift_id=$1",[shift.id]));
    return BigInt(shift.opening_cash)+BigInt(value.value);
  }
  async cash(ctx,shiftId,direction,value,kind,sourceId,reason='',category='') {
    if(BigInt(value)===0n) return;
    await ctx.db.query('INSERT INTO iutra_pos.pos_cash_movements(id,store_id,device_id,shift_id,direction,amount,kind,source_id,actor_id,reason,category) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[randomUUID(),ctx.storeId,ctx.deviceId,shiftId,direction,String(value),kind,sourceId,ctx.staffId,reason,category]);
  }
  async cashMovement(ctx,input) {
    fields(input,['shiftId','direction','amount','category','reason']); await this.shift(ctx,input.shiftId);
    if(!['in','out'].includes(input.direction)) throw new ValidationError('收支方向不正確');
    const id=randomUUID(); await this.cash(ctx,input.shiftId,input.direction,amount(input.amount,{positive:true}),'other',id,text(input.reason),text(input.category,60));
    return {id};
  }
  async quote(ctx,input) {
    const published=row(await ctx.db.query('SELECT r.catalog FROM iutra_pos.catalog_state s JOIN iutra_pos.catalog_releases r ON r.release=s.current_release WHERE s.singleton=true FOR SHARE OF s'));
    if(published.catalog.isExample!==false || published.catalog.release!==input.menuRelease) fail(409,'MENU_RELEASE_CONFLICT','請載入目前已發布菜單，示範資料不可收款');
    return quoteOrder({menuRelease:input.menuRelease,items:input.items},published.catalog);
  }
  async createOrder(ctx,input) {
    fields(input,['clientOrderId','shiftId','menuRelease','items']); uuid(input.clientOrderId);
    const existing=(await ctx.db.query('SELECT * FROM iutra_pos.pos_orders WHERE client_order_id=$1 AND device_id=$2 FOR UPDATE',[input.clientOrderId,ctx.deviceId])).rows[0];
    if(existing) {
      if(canonical(existing.request)!==canonical({menuRelease:input.menuRelease,items:input.items}) || existing.shift_id!==input.shiftId) fail(409,'IDEMPOTENCY_CONFLICT','原點餐識別已有不同內容或班次的訂單，請查原訂單');
      return existing;
    }
    await this.shift(ctx,input.shiftId);
    const quote=await this.quote(ctx,input);
    const date=businessDate(new Date(),ctx.timezone,ctx.day_cutoff);
    return row(await ctx.db.query('INSERT INTO iutra_pos.pos_orders(id,store_id,device_id,shift_id,client_order_id,staff_id,business_date,menu_release,subtotal,total,quote,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING *',[randomUUID(),ctx.storeId,ctx.deviceId,input.shiftId,input.clientOrderId,ctx.staffId,date,input.menuRelease,quote.subtotal,quote.total,JSON.stringify(quote),canonical({menuRelease:input.menuRelease,items:input.items})]));
  }
  async updateOrder(ctx,input) {
    fields(input,['id','expectedVersion','menuRelease','items']); const order=await this.order(ctx,input.id); checkVersion(order,input.expectedVersion); await this.shift(ctx,order.shift_id);
    if(order.status!=='draft') stateConflict('僅未進入付款的草稿可修改');
    const quote=await this.quote(ctx,input);
    return row(await ctx.db.query('UPDATE iutra_pos.pos_orders SET version=version+1,menu_release=$1,subtotal=$2,total=$3,quote=$4::jsonb,request=$5::jsonb WHERE id=$6 RETURNING *',[input.menuRelease,quote.subtotal,quote.total,JSON.stringify(quote),canonical({menuRelease:input.menuRelease,items:input.items}),order.id]));
  }
  async cancelOrder(ctx,input) {
    fields(input,['id','expectedVersion','reason']); const order=await this.order(ctx,input.id); checkVersion(order,input.expectedVersion); text(input.reason);
    if(!['draft','awaiting_payment'].includes(order.status)) stateConflict('已付款或已取消訂單不可取消');
    const pending=(await ctx.db.query("SELECT * FROM iutra_pos.pos_payment_requests WHERE order_id=$1 AND status IN ('pending','processing','unknown') FOR UPDATE",[order.id])).rows;
    if(pending.some(p=>p.status!=='pending')) stateConflict('付款結果不明，請先查核');
    await ctx.db.query("UPDATE iutra_pos.pos_payment_requests SET status='cancelled' WHERE order_id=$1 AND status='pending'",[order.id]);
    return row(await ctx.db.query("UPDATE iutra_pos.pos_orders SET status='cancelled',version=version+1,reason=$1 WHERE id=$2 RETURNING *",[input.reason,order.id]));
  }
  walletPolicy(ctx) {
    if(ctx.policy.walletEnabled!==true || ctx.policy.memberVerification!=='pin' || !Number.isInteger(ctx.policy.verificationAttempts) || ctx.policy.verificationAttempts<1 || ctx.policy.verificationAttempts>10 || !Number.isInteger(ctx.policy.verificationLockMinutes) || ctx.policy.verificationLockMinutes<1 || ctx.policy.verificationLockMinutes>1440) fail(409,'POLICY_NOT_CONFIGURED','會員儲值政策與驗證鎖定規則尚未核准設定');
  }
  async requestPayment(ctx,input) {
    fields(input,['orderId','expectedVersion','method']); const order=await this.order(ctx,input.orderId); checkVersion(order,input.expectedVersion); await this.shift(ctx,order.shift_id);
    if(order.status!=='draft') stateConflict('訂單已有付款或已完成，請先查原操作');
    if(!['cash','bank','wallet'].includes(input.method)) throw new ValidationError('付款方式不正確，混合付款未啟用');
    if(input.method==='wallet') { requirePermission(ctx,'wallet.charge'); this.walletPolicy(ctx); }
    const request=await this.makeRequest(ctx,{order,method:input.method,shiftId:order.shift_id,amount:order.total});
    await ctx.db.query("UPDATE iutra_pos.pos_orders SET status='awaiting_payment',version=version+1 WHERE id=$1",[order.id]);
    return request;
  }
  async makeRequest(ctx,{order=null,topup=null,method,shiftId,amount:value}) {
    const id=randomUUID(); let bank=null,qr=null;
    if(method==='bank') {
      const found=(await ctx.db.query('SELECT * FROM iutra_pos.pos_banks WHERE store_id=$1 AND verified=true FOR SHARE',[ctx.storeId])).rows[0];
      if(!found) fail(409,'BANK_NOT_VERIFIED','尚未設定並核實收款帳戶');
      bank={bankCode:found.bank_code,accountNumber:found.account_number,accountName:found.account_name,version:found.version};
      qr=bankQR(bank,value,id.replaceAll('-','').slice(0,20));
    }
    const request=row(await ctx.db.query(`INSERT INTO iutra_pos.pos_payment_requests(id,store_id,device_id,shift_id,order_id,topup_id,order_version,purpose,method,amount,bank_snapshot,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,CASE WHEN $9='bank' THEN now()+interval '10 minutes' ELSE NULL END) RETURNING *`,[id,ctx.storeId,ctx.deviceId,shiftId,order?.id??null,topup?.id??null,order?order.version+1:null,order?'sales':'topup',method,String(value),bank?JSON.stringify(bank):null]));
    return {...request,bankSnapshot:bank,qrPayload:qr};
  }
  async cancelPayment(ctx,input) {
    fields(input,['id','reason']); const request=await this.paymentRequest(ctx,input.id); text(input.reason);
    if(request.status!=='pending') stateConflict('僅尚未執行的付款可取消，未知結果須先查核');
    if(request.topup_id && (await ctx.db.query("SELECT id FROM iutra_pos.pos_exceptions WHERE request_id=$1 AND kind='funded_pending_credit' AND status='open' LIMIT 1",[request.id])).rows.length) stateConflict('已觀察到儲值款項，須先補入帳，不可取消後重新收款');
    await ctx.db.query("UPDATE iutra_pos.pos_payment_requests SET status='cancelled' WHERE id=$1",[request.id]);
    if(request.order_id) await ctx.db.query("UPDATE iutra_pos.pos_orders SET status='draft',version=version+1 WHERE id=$1 AND status='awaiting_payment'",[request.order_id]);
    if(request.topup_id) await ctx.db.query("UPDATE iutra_pos.pos_topups SET status='cancelled' WHERE id=$1",[request.topup_id]);
    return {id:request.id,status:'cancelled'};
  }
  async confirmCash(ctx,input) {
    fields(input,['id','tendered']); const request=await this.paymentRequest(ctx,input.id); await this.pending(ctx,request,'cash');
    const tendered=amount(input.tendered),due=BigInt(request.amount);
    if(tendered<due) fail(422,'AMOUNT_MISMATCH','實收不可少於應付');
    return this.settle(ctx,request,{tendered:String(tendered),change:String(tendered-due)});
  }
  async confirmBank(ctx,input) {
    fields(input,['id','externalRef','amount','bookedAt','note']); const request=await this.paymentRequest(ctx,input.id);
    if(request.method!=='bank' || !request.bank_snapshot) throw new ValidationError('此請求不是銀行付款');
    const value=amount(input.amount),note=text(input.note,200,true),ref=text(input.externalRef,100,true);
    if(typeof input.bookedAt!=='string' || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(input.bookedAt) || !Number.isFinite(Date.parse(input.bookedAt)) || Date.parse(input.bookedAt)>Date.now()+60000) throw new ValidationError('實際入帳時間不正確，必須包含時區');
    let transaction=null,kind=null;
    if(!ref) kind='unmatched';
    else {
      const identity=`${request.bank_snapshot.bankCode}:${request.bank_snapshot.accountNumber}`;
      const inserted=await ctx.db.query('INSERT INTO iutra_pos.pos_bank_transactions(id,store_id,bank_identity,external_ref,amount,booked_at,observed_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bank_identity,external_ref) DO NOTHING RETURNING *',[randomUUID(),ctx.storeId,identity,ref,String(value),input.bookedAt,ctx.staffId]);
      transaction=inserted.rows[0];
      if(!transaction) kind='duplicate';
    }
    // Bank timestamps may truncate milliseconds to whole seconds; allow only 1 second.
    const origin=row(await ctx.db.query(request.topup_id?'SELECT created_at FROM iutra_pos.pos_topups WHERE id=$1':'SELECT created_at FROM iutra_pos.pos_orders WHERE id=$1',[request.topup_id??request.order_id]));
    if(!kind && Date.parse(input.bookedAt)<new Date(origin.created_at).getTime()-1000) kind='unmatched';
    // The locked request serializes observations. Preserve the first funded source for recovery.
    if(!kind && request.topup_id && (await ctx.db.query("SELECT id FROM iutra_pos.pos_exceptions WHERE request_id=$1 AND kind='funded_pending_credit' AND status='open' LIMIT 1",[request.id])).rows.length) kind='unmatched';
    const closed=(await ctx.db.query('SELECT status FROM iutra_pos.pos_shifts WHERE id=$1',[request.shift_id])).rows[0]?.status!=='open';
    if(!kind && (request.status!=='pending' || closed || new Date(request.expires_at)<=new Date() || Date.parse(input.bookedAt)>new Date(request.expires_at).getTime())) kind='late';
    if(!kind && value!==BigInt(request.amount)) kind=value<BigInt(request.amount)?'short':'over';
    if(!kind && request.topup_id) {
      const target=(await ctx.db.query('SELECT w.principal_balance,w.status,m.active FROM iutra_pos.pos_topups t JOIN iutra_pos.pos_wallets w ON w.id=t.wallet_id JOIN iutra_pos.pos_members m ON m.id=w.member_id WHERE t.id=$1 FOR UPDATE OF w,m',[request.topup_id])).rows[0];
      try { this.walletPolicy(ctx); } catch { kind='funded_pending_credit'; }
      if(!target || target.status!=='active' || !target.active || BigInt(target.principal_balance)+value>1000000000000n) kind='funded_pending_credit';
    }
    if(kind) {
      const exception=row(await ctx.db.query('INSERT INTO iutra_pos.pos_exceptions(id,store_id,request_id,bank_transaction_id,observed_amount,kind,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),ctx.storeId,request.id,transaction?.id??null,String(value),kind,note]));
      return {exception,status:'exception'};
    }
    await this.pending(ctx,request,'bank');
    return this.settle(ctx,request,{bankTransactionId:transaction.id});
  }
  async creditFundedTopup(ctx,input) {
    fields(input,['id','reason']); text(input.reason); requirePermission(ctx,'wallet.topup'); this.walletPolicy(ctx);
    const exception=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_exceptions WHERE id=$1 AND store_id=$2 FOR UPDATE',[uuid(input.id),ctx.storeId]));
    if(exception.kind!=='funded_pending_credit' || exception.status!=='open' || !exception.bank_transaction_id) stateConflict('僅可補入尚未處理的已到款儲值');
    const request=await this.paymentRequest(ctx,exception.request_id);
    if(request.method!=='bank' || request.purpose!=='topup' || !request.topup_id || request.status!=='pending') stateConflict('原儲值請求已變更，請核對原付款');
    await this.shift(ctx,request.shift_id);
    const bank=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_bank_transactions WHERE id=$1 AND store_id=$2',[exception.bank_transaction_id,ctx.storeId]));
    if(String(bank.amount)!==String(request.amount) || bank.bank_identity!==`${request.bank_snapshot.bankCode}:${request.bank_snapshot.accountNumber}`) stateConflict('原到款來源或金額不符');
    // The original observation established timely funding; recovery never receives money again.
    const result=await this.settle(ctx,request,{bankTransactionId:bank.id});
    await ctx.db.query("UPDATE iutra_pos.pos_exceptions SET status='reviewed',resolution=$1 WHERE id=$2",[input.reason,exception.id]);
    return result;
  }
  async wallet(ctx,id) {
    const wallet=row(await ctx.db.query('SELECT w.*,m.active AS member_active FROM iutra_pos.pos_wallets w JOIN iutra_pos.pos_members m ON m.id=w.member_id WHERE w.id=$1 AND w.store_id=$2 FOR UPDATE OF w,m',[uuid(id),ctx.storeId]));
    if(wallet.status!=='active' || !wallet.member_active) stateConflict('會員或錢包已停用');
    return wallet;
  }
  async walletEntry(ctx,wallet,delta,kind,{paymentId=null,refundId=null,topupId=null,shiftId,businessKey,reference='',reason=''}) {
    const balance=BigInt(wallet.principal_balance)+delta;
    if(balance<0n) fail(409,'INSUFFICIENT_BALANCE','儲值餘額不足，整筆扣款未完成');
    amount(String(balance));
    const id=randomUUID();
    await ctx.db.query('UPDATE iutra_pos.pos_wallets SET principal_balance=$1,version=version+1 WHERE id=$2',[String(balance),wallet.id]);
    await ctx.db.query('INSERT INTO iutra_pos.pos_wallet_entries(id,store_id,wallet_id,kind,delta,balance_after,business_key,payment_id,refund_id,topup_id,shift_id,device_id,actor_id,reference,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[id,ctx.storeId,wallet.id,kind,String(delta),String(balance),businessKey,paymentId,refundId,topupId,shiftId,ctx.deviceId,ctx.staffId,reference,reason]);
    await this.outbox(ctx,wallet.id,'wallet.changed',{walletId:wallet.id,entryId:id,balance:String(balance)});
    return {id,balance:String(balance)};
  }
  async settle(ctx,request,{tendered=null,change=null,bankTransactionId=null,wallet=null}={}) {
    // The payment, balance/ledger, cash fact, order and delivery jobs commit together.
    const payment=row(await ctx.db.query('INSERT INTO iutra_pos.pos_payments(id,store_id,request_id,purpose,method,amount,tendered,change_given,wallet_id,bank_transaction_id,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[randomUUID(),ctx.storeId,request.id,request.purpose,request.method,String(request.amount),tendered,change,wallet?.id??null,bankTransactionId,ctx.staffId]));
    if(request.topup_id) {
      this.walletPolicy(ctx);
      const topup=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_topups WHERE id=$1 FOR UPDATE',[request.topup_id]));
      if(topup.status!=='awaiting_funds') stateConflict('此儲值已處理');
      const target=await this.wallet(ctx,topup.wallet_id);
      await this.walletEntry(ctx,target,BigInt(request.amount),'topup',{paymentId:payment.id,topupId:topup.id,shiftId:request.shift_id,businessKey:`topup:${topup.id}`});
      await ctx.db.query("UPDATE iutra_pos.pos_topups SET status='credited' WHERE id=$1",[topup.id]);
    }
    if(wallet && BigInt(request.amount)>0n) await this.walletEntry(ctx,wallet,-BigInt(request.amount),'debit',{paymentId:payment.id,shiftId:request.shift_id,businessKey:`payment:${payment.id}`});
    if(request.method==='cash') await this.cash(ctx,request.shift_id,'in',request.amount,request.purpose,payment.id);
    await ctx.db.query("UPDATE iutra_pos.pos_payment_requests SET status='succeeded' WHERE id=$1",[request.id]);
    let order=null;
    if(request.order_id) {
      order=row(await ctx.db.query("UPDATE iutra_pos.pos_orders SET status='completed',version=version+1 WHERE id=$1 RETURNING *",[request.order_id]));
      await this.printJobs(ctx,order,payment);
      await this.outbox(ctx,order.id,'order.paid',{orderId:order.id,paymentId:payment.id,version:order.version});
    }
    return {payment,order,change};
  }
  async createMember(ctx,input) {
    fields(input,['memberCode','displayName','pin']); this.walletPolicy(ctx);
    if(typeof input.pin!=='string' || !/^\d{6,12}$/.test(input.pin)) throw new ValidationError('PIN 須為 6 至 12 位數字');
    const code=text(input.memberCode,64),name=text(input.displayName,100),id=randomUUID();
    await ctx.db.query('INSERT INTO iutra_pos.pos_members(id,store_id,member_code,display_name,pin_hash) VALUES($1,$2,$3,$4,$5)',[id,ctx.storeId,code,name,await hashStaffPassword(input.pin)]);
    const wallet=row(await ctx.db.query('INSERT INTO iutra_pos.pos_wallets(id,store_id,member_id) VALUES($1,$2,$3) RETURNING *',[randomUUID(),ctx.storeId,id]));
    return {id,memberCode:`***${code.slice(-4)}`,displayName:`${name.slice(0,1)}***`,wallet};
  }
  async verifyMember(ctx,input) {
    fields(input,['memberId','pin','purpose','paymentRequestId']); this.walletPolicy(ctx);
    if(input.purpose!=='payment' || typeof input.pin!=='string' || !/^\d{6,12}$/.test(input.pin)) throw new ValidationError('會員驗證資料不正確');
    const request=await this.paymentRequest(ctx,input.paymentRequestId); await this.pending(ctx,request,'wallet');
    const member=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_members WHERE id=$1 AND store_id=$2 FOR UPDATE',[uuid(input.memberId),ctx.storeId]));
    if(!member.active || (member.locked_until && new Date(member.locked_until)>new Date())) return {verified:false,memberId:member.id,message:'會員驗證失敗或暫時鎖定'};
    const ok=await verifyStaffPassword(input.pin,member.pin_hash);
    if(!ok) {
      const attempts=member.locked_until && new Date(member.locked_until)<=new Date()?1:member.failed_attempts+1;
      await ctx.db.query("UPDATE iutra_pos.pos_members SET failed_attempts=$1::integer,locked_until=CASE WHEN $1::integer >= $2::integer THEN now()+($3::integer * interval '1 minute') ELSE NULL END WHERE id=$4",[attempts,ctx.policy.verificationAttempts,ctx.policy.verificationLockMinutes,member.id]);
      return {verified:false,memberId:member.id,message:'會員驗證失敗或暫時鎖定'};
    }
    await ctx.db.query('UPDATE iutra_pos.pos_members SET failed_attempts=0,locked_until=NULL WHERE id=$1',[member.id]);
    const token=randomBytes(32).toString('base64url');
    await ctx.db.query("INSERT INTO iutra_pos.pos_verifications(id,store_id,member_id,request_id,staff_id,device_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes')",[randomUUID(),ctx.storeId,member.id,request.id,ctx.staffId,ctx.deviceId,sha256(token)]);
    return {verified:true,memberId:member.id,verificationToken:token};
  }
  async topup(ctx,input) {
    fields(input,['walletId','shiftId','amount','method']); this.walletPolicy(ctx); await this.shift(ctx,input.shiftId); await this.wallet(ctx,input.walletId);
    if(!['cash','bank'].includes(input.method)) throw new ValidationError('儲值來源限現金或銀行');
    const value=amount(input.amount,{positive:true});
    const topup=row(await ctx.db.query('INSERT INTO iutra_pos.pos_topups(id,store_id,device_id,shift_id,wallet_id,amount) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),ctx.storeId,ctx.deviceId,input.shiftId,input.walletId,String(value)]));
    return this.makeRequest(ctx,{topup,method:input.method,shiftId:input.shiftId,amount:value});
  }
  async chargeWallet(ctx,input) {
    fields(input,['id','walletId','verificationToken']); this.walletPolicy(ctx);
    const request=await this.paymentRequest(ctx,input.id); await this.pending(ctx,request,'wallet');
    if(typeof input.verificationToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(input.verificationToken)) fail(403,'VERIFICATION_REQUIRED','請先完成會員驗證');
    const verification=(await ctx.db.query('SELECT * FROM iutra_pos.pos_verifications WHERE token_hash=$1 AND request_id=$2 AND staff_id=$3 AND device_id=$4 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[sha256(input.verificationToken),request.id,ctx.staffId,ctx.deviceId])).rows[0];
    if(!verification) fail(403,'VERIFICATION_REQUIRED','會員驗證已過期或不屬於此付款');
    const wallet=await this.wallet(ctx,input.walletId);
    if(wallet.member_id!==verification.member_id) fail(403,'VERIFICATION_REQUIRED','驗證會員與錢包不符');
    if(BigInt(wallet.principal_balance)<BigInt(request.amount)) fail(409,'INSUFFICIENT_BALANCE','儲值餘額不足');
    const result=await this.settle(ctx,request,{wallet});
    await ctx.db.query('UPDATE iutra_pos.pos_verifications SET used_at=now() WHERE id=$1',[verification.id]);
    return result;
  }
  async adjustWallet(ctx,input) {
    fields(input,['walletId','delta','reference','reason']); this.walletPolicy(ctx);
    const delta=amount(input.delta,{signed:true,positive:true}),reference=text(input.reference,100),reason=text(input.reason);
    const shift=await this.currentShift(ctx),wallet=await this.wallet(ctx,input.walletId);
    // Explicit ledger reference, never a balance setter. No source-data import endpoint.
    return this.walletEntry(ctx,wallet,delta,'adjustment',{shiftId:shift.id,businessKey:`adjustment:${ctx.storeId}:${reference}`,reference,reason});
  }
  refundPolicy(ctx,value) {
    if(ctx.policy.refundEnabled!==true) fail(409,'POLICY_NOT_CONFIGURED','退款政策尚未核准設定');
    const max=amount(ctx.policy.refundMax);
    if(value>max) fail(403,'REFUND_LIMIT','退款超過已設定限額');
    if(!Number.isInteger(ctx.policy.refundWindowDays) || ctx.policy.refundWindowDays<1 || ctx.policy.refundWindowDays>3650) fail(409,'POLICY_NOT_CONFIGURED','退款期限尚未設定');
  }
  async requestRefund(ctx,input) {
    fields(input,['orderId','amount','reason']); const value=amount(input.amount,{positive:true}); this.refundPolicy(ctx,value); text(input.reason);
    const order=await this.order(ctx,input.orderId,{ownDevice:false});
    if(order.status!=='completed') stateConflict('僅已付款訂單可申請退款');
    if(Date.now()-new Date(order.created_at).getTime()>ctx.policy.refundWindowDays*86400000) fail(403,'REFUND_LIMIT','已超過退款期限');
    if(ctx.policy.partialRefunds!==true && value!==BigInt(order.total)) fail(403,'PARTIAL_REFUND_DISABLED','部分退款尚未啟用');
    const payment=row(await ctx.db.query('SELECT p.* FROM iutra_pos.pos_payments p JOIN iutra_pos.pos_payment_requests r ON r.id=p.request_id WHERE r.order_id=$1',[order.id]));
    await this.checkRefundCapacity(ctx,payment,value);
    return row(await ctx.db.query('INSERT INTO iutra_pos.pos_refunds(id,store_id,order_id,payment_id,amount,method,requested_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),ctx.storeId,order.id,payment.id,String(value),payment.method,ctx.staffId,input.reason]));
  }
  async checkRefundCapacity(ctx,payment,value,exclude=null) {
    const used=row(await ctx.db.query("SELECT COALESCE(SUM(amount),0)::text AS amount FROM iutra_pos.pos_refunds WHERE payment_id=$1 AND status IN ('requested','approved','processing','unknown','succeeded') AND ($2::uuid IS NULL OR id<>$2)",[payment.id,exclude]));
    if(BigInt(used.amount)+value>BigInt(payment.amount)) stateConflict('累計退款及保留額超過原收款');
  }
  async refund(ctx,id) {
    // The original order serializes refund capacity across devices; payments are immutable.
    // Fixed lock order: original order before refund/wallet.
    const info=row(await ctx.db.query('SELECT order_id FROM iutra_pos.pos_refunds WHERE id=$1 AND store_id=$2',[uuid(id),ctx.storeId]));
    await this.order(ctx,info.order_id,{ownDevice:false});
    return row(await ctx.db.query('SELECT * FROM iutra_pos.pos_refunds WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,ctx.storeId]));
  }
  async approveRefund(ctx,input) {
    fields(input,['id','expectedVersion']); const refund=await this.refund(ctx,input.id); checkVersion(refund,input.expectedVersion); this.refundPolicy(ctx,BigInt(refund.amount));
    if(refund.status!=='requested') stateConflict('退款狀態不允許核准');
    if(ctx.policy.dualApproval!==false && refund.requested_by===ctx.staffId) fail(403,'DUAL_APPROVAL_REQUIRED','此政策要求另一位核准帳號');
    return row(await ctx.db.query("UPDATE iutra_pos.pos_refunds SET status='approved',approved_by=$1,version=version+1 WHERE id=$2 RETURNING *",[ctx.staffId,refund.id]));
  }
  async startRefund(ctx,input) {
    fields(input,['id','expectedVersion']); const refund=await this.refund(ctx,input.id); checkVersion(refund,input.expectedVersion); this.refundPolicy(ctx,BigInt(refund.amount));
    if(refund.status!=='approved') stateConflict('退款尚未核准或已經執行，請先查原結果');
    const shift=await this.currentShift(ctx);
    const payment=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_payments WHERE id=$1',[refund.payment_id]));
    await this.checkRefundCapacity(ctx,payment,BigInt(refund.amount),refund.id);
    const started=row(await ctx.db.query("UPDATE iutra_pos.pos_refunds SET status='processing',version=version+1,executed_by=$1,executed_shift_id=$2 WHERE id=$3 RETURNING *",[ctx.staffId,shift.id,refund.id]));
    if(refund.method==='wallet') {
      this.walletPolicy(ctx); const wallet=await this.wallet(ctx,payment.wallet_id);
      await this.walletEntry(ctx,wallet,BigInt(refund.amount),'refund',{refundId:refund.id,paymentId:payment.id,shiftId:shift.id,businessKey:`refund:${refund.id}`});
      return this.completeRefund(ctx,started,'succeeded','','已回入原錢包');
    }
    return started;
  }
  async completeRefund(ctx,refund,outcome,externalRef,reason) {
    if(outcome==='succeeded' && refund.method==='cash') {
      const shift=await this.shift(ctx,refund.executed_shift_id);
      await this.cash(ctx,shift.id,'out',refund.amount,'refund',refund.id,reason);
    }
    const updated=row(await ctx.db.query("UPDATE iutra_pos.pos_refunds SET status=$1,version=version+1,external_ref=$2,completed_at=CASE WHEN $1='succeeded' THEN now() ELSE NULL END WHERE id=$3 RETURNING *",[outcome,externalRef||null,refund.id]));
    if(outcome==='succeeded') await this.outbox(ctx,refund.id,'refund.completed',{refundId:refund.id,orderId:refund.order_id,amount:String(refund.amount)});
    return updated;
  }
  async finishRefund(ctx,input) {
    fields(input,['id','expectedVersion','outcome','externalRef','reason']); const refund=await this.refund(ctx,input.id); checkVersion(refund,input.expectedVersion);
    if(!['processing','unknown'].includes(refund.status) || refund.method==='wallet') stateConflict('退款狀態不允許人工完成');
    if(!['succeeded','failed','unknown'].includes(input.outcome)) throw new ValidationError('退款結果不正確');
    const reason=text(input.reason),ref=text(input.externalRef,100,true);
    // Cash execution must remain in its original device/shift, not reattributed to a later till.
    const shift=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_shifts WHERE id=$1 AND device_id=$2 AND store_id=$3 FOR UPDATE',[refund.executed_shift_id,ctx.deviceId,ctx.storeId]));
    if(shift.status!=='open') stateConflict('執行班次已關閉，須先人工核對');
    if(input.outcome==='succeeded' && refund.method==='bank' && !ref) throw new ValidationError('銀行退款須填實際交易識別');
    return this.completeRefund(ctx,refund,input.outcome,ref,reason);
  }
  async cancelRefund(ctx,input) {
    fields(input,['id','expectedVersion','reason']); const refund=await this.refund(ctx,input.id); checkVersion(refund,input.expectedVersion); text(input.reason);
    if(!['requested','approved'].includes(refund.status)) stateConflict('執行中或結果未知的退款不能取消或釋放額度');
    return row(await ctx.db.query("UPDATE iutra_pos.pos_refunds SET status='cancelled',version=version+1 WHERE id=$1 RETURNING *",[refund.id]));
  }
  async printJobs(ctx,order,payment) {
    const insert=async(kind,cupKey,snapshot)=>ctx.db.query('INSERT INTO iutra_pos.pos_print_jobs(id,store_id,device_id,order_id,document_kind,cup_key,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[randomUUID(),ctx.storeId,ctx.deviceId,order.id,kind,cupKey,JSON.stringify(snapshot)]);
    const publicItems=order.quote.items.map(({internalNote,...item})=>item);
    const receipt={storeName:ctx.store_name,orderId:order.id,pickupNumber:order.id.slice(-6).toUpperCase(),items:publicItems,total:String(order.total),method:payment.method,reprint:false};
    await insert('receipt','receipt',receipt);
    for(const [index,item] of publicItems.entries()) for(let cup=1;cup<=item.quantity;cup++) await insert('label',`${index+1}:${cup}`,{...item,orderId:order.id,pickupNumber:receipt.pickupNumber,line:index+1,cup,quantity:1,reprint:false});
    if(payment.method==='cash') await insert('drawer','drawer',{orderId:order.id,paymentId:payment.id});
  }
  async printJob(ctx,id) {
    return row(await ctx.db.query('SELECT * FROM iutra_pos.pos_print_jobs WHERE id=$1 AND store_id=$2 AND device_id=$3 FOR UPDATE',[uuid(id),ctx.storeId,ctx.deviceId]));
  }
  async claimPrint(ctx,input) {
    fields(input,['id','expectedVersion']); const job=await this.printJob(ctx,input.id); checkVersion(job,input.expectedVersion);
    if(!['queued','failed'].includes(job.status)) stateConflict('已送出或未知的列印工作須先核對，不可自動重送');
    return row(await ctx.db.query("UPDATE iutra_pos.pos_print_jobs SET status='sending',version=version+1 WHERE id=$1 RETURNING *",[job.id]));
  }
  async finishPrint(ctx,input) {
    fields(input,['id','expectedVersion','outcome','reason']); const job=await this.printJob(ctx,input.id); checkVersion(job,input.expectedVersion);
    if(!['sending','unknown'].includes(job.status)) stateConflict('列印工作尚未送出或已完成');
    if(!['printed','failed','unknown'].includes(input.outcome)) throw new ValidationError('列印結果不正確');
    if(job.status==='unknown' && input.outcome==='failed') stateConflict('未知工作不可改為可重試失敗；請核對後新增有原因的補印');
    text(input.reason);
    return row(await ctx.db.query('UPDATE iutra_pos.pos_print_jobs SET status=$1,reason=$2,version=version+1 WHERE id=$3 RETURNING *',[input.outcome,input.reason,job.id]));
  }
  async reprint(ctx,input) {
    fields(input,['id','reason']); const job=await this.printJob(ctx,input.id); text(input.reason);
    if(job.document_kind==='drawer') fail(403,'FORBIDDEN','開櫃不可透過補印重新執行');
    if(['queued','sending'].includes(job.status)) stateConflict('原工作尚未完成，請先核對');
    return row(await ctx.db.query('INSERT INTO iutra_pos.pos_print_jobs(id,store_id,device_id,order_id,document_kind,cup_key,reprint_of,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *',[randomUUID(),ctx.storeId,ctx.deviceId,job.order_id,job.document_kind,job.cup_key,job.id,input.reason,JSON.stringify({...job.snapshot,reprint:true,reprintOf:job.id})]));
  }
  async setBank(ctx,input) {
    fields(input,['bankCode','accountNumber','accountName','verified','reason','expectedVersion','currentPassword']); text(input.reason);
    if(typeof input.currentPassword!=='string' || Buffer.byteLength(input.currentPassword)>1024) throw new ValidationError('請重新輸入登入密碼');
    const staff=row(await ctx.db.query('SELECT password_hash FROM iutra_pos.staff_users WHERE id=$1 AND active=true',[ctx.staffId]));
    if(!await verifyStaffPassword(input.currentPassword,staff.password_hash)) fail(403,'REAUTHENTICATION_REQUIRED','重新驗證失敗');
    if(typeof input.bankCode!=='string' || !/^\d{6}$/.test(input.bankCode) || typeof input.accountNumber!=='string' || !/^\d{6,34}$/.test(input.accountNumber) || typeof input.verified!=='boolean') throw new ValidationError('銀行 BIN 須六碼，帳號須為 6 至 34 位數字');
    text(input.accountName,100);
    if(!Number.isInteger(input.expectedVersion) || input.expectedVersion<0) throw new ValidationError('銀行版本不正確');
    const current=(await ctx.db.query('SELECT * FROM iutra_pos.pos_banks WHERE store_id=$1 FOR UPDATE',[ctx.storeId])).rows[0];
    if((current?.version??0)!==input.expectedVersion) fail(409,'VERSION_CONFLICT','銀行設定已變更，請重新讀取');
    const updated=(await ctx.db.query('INSERT INTO iutra_pos.pos_banks(store_id,bank_code,account_number,account_name,verified,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id) DO UPDATE SET bank_code=EXCLUDED.bank_code,account_number=EXCLUDED.account_number,account_name=EXCLUDED.account_name,verified=EXCLUDED.verified,version=pos_banks.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() WHERE $7 > 0 AND pos_banks.version=$7 RETURNING *',[ctx.storeId,input.bankCode,input.accountNumber,input.accountName,input.verified,ctx.staffId,input.expectedVersion])).rows[0];
    if(!updated) fail(409,'VERSION_CONFLICT','銀行設定已變更，請重新讀取');
    await this.audit(ctx,'bank.version',ctx.storeId,input.reason,{previousVersion:current?.version??0,version:updated.version,accountSuffix:input.accountNumber.slice(-4),verified:input.verified});
    return updated;
  }
  async setProduction(ctx,input) {
    fields(input,['orderId','expectedVersion','status']); const order=await this.order(ctx,input.orderId); checkVersion(order,input.expectedVersion);
    const next={not_started:['preparing','stopped','wasted'],preparing:['ready','stopped','wasted'],ready:['handed_over','stopped','wasted'],handed_over:[],stopped:['wasted'],wasted:[]};
    if(order.status!=='completed' || !next[order.production_status].includes(input.status)) stateConflict('製作狀態不允許此轉移');
    return row(await ctx.db.query('UPDATE iutra_pos.pos_orders SET production_status=$1,version=version+1 WHERE id=$2 RETURNING *',[input.status,order.id]));
  }
  async reviewException(ctx,input) {
    fields(input,['id','resolution']); text(input.resolution,500);
    const exception=row(await ctx.db.query('SELECT * FROM iutra_pos.pos_exceptions WHERE id=$1 AND store_id=$2 FOR UPDATE',[uuid(input.id),ctx.storeId]));
    if(exception.kind==='funded_pending_credit') stateConflict('此筆已有到款，請使用原款補入儲值，不可只標記已核對');
    return row(await ctx.db.query("UPDATE iutra_pos.pos_exceptions SET status='reviewed',resolution=$1 WHERE id=$2 AND store_id=$3 AND status='open' RETURNING *",[input.resolution,uuid(input.id),ctx.storeId]));
  }
  async operation(auth,key) {
    return this.transaction(async db=>{const ctx=await this.authorize(db,auth); const found=row(await db.query('SELECT key,command,result FROM iutra_pos.pos_operations WHERE key=$1 AND staff_id=$2 AND device_id=$3',[uuid(key),ctx.staffId,ctx.deviceId])); requirePermission(ctx,permissionFor[found.command]); return found;});
  }
  async list(auth,collection,{id=null,limit=50,before=null,query=''}={}) {
    const collections={
      orders:['pos_orders','pos'],shifts:['pos_shifts','pos'],payments:['pos_payments','reports'],paymentRequests:['pos_payment_requests','pos'],
      members:['pos_members','members'],wallets:['pos_wallets','members'],entries:['pos_wallet_entries','members'],refunds:['pos_refunds','refund.request'],
      exceptions:['pos_exceptions','bank.confirm'],printJobs:['pos_print_jobs','print'],audit:['pos_audit','audit'],cashMovements:['pos_cash_movements','reports'],banks:['pos_banks','bank.manage']
    };
    if(!Object.hasOwn(collections,collection)) missing();
    if(!Number.isInteger(limit)||limit<1||limit>200) throw new ValidationError('筆數須為 1 至 200');
    if(typeof query!=='string' || query.length>100) throw new ValidationError('查詢過長');
    return this.transaction(async db=>{
      const ctx=await this.authorize(db,auth); const [table,permission]=collections[collection]; requirePermission(ctx,permission);
      const columns=collection==='members'?"id,store_id,'***' || right(member_code,4) AS member_code,left(display_name,1) || '***' AS display_name,active,created_at":'*';
      const params=[ctx.storeId]; let where='store_id=$1';
      // Till activity and print jobs are scoped to the currently credentialed device.
      if(['orders','shifts','paymentRequests','printJobs','cashMovements'].includes(collection)) { params.push(ctx.deviceId); where+=` AND device_id=$${params.length}`; }
      if(id) {params.push(uuid(id));where+=` AND ${collection==='banks'?'store_id':'id'}=$${params.length}`;}
      if(before) {params.push(uuid(before));where+=` AND id<$${params.length}`;}
      if(collection==='members' && query) {params.push(query);where+=` AND member_code=$${params.length}`;}
      params.push(id?1:limit);
      const rows=(await db.query(`SELECT ${columns} FROM iutra_pos.${table} WHERE ${where} ORDER BY ${collection==='banks'?'store_id':'id'} DESC LIMIT $${params.length}`,params)).rows;
      if(id) return rows[0]??missing();
      return rows;
    });
  }
  async report(auth,id,asCSV=false) {
    return this.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const ctx=await this.authorize(db,auth); requirePermission(ctx,asCSV?'export':'reports');
      const shift=row(await db.query('SELECT * FROM iutra_pos.pos_shifts WHERE id=$1 AND store_id=$2',[uuid(id),ctx.storeId]));
      const sums=(await db.query('SELECT p.purpose,p.method,SUM(p.amount)::text AS amount FROM iutra_pos.pos_payments p JOIN iutra_pos.pos_payment_requests r ON r.id=p.request_id WHERE r.shift_id=$1 GROUP BY p.purpose,p.method',[shift.id])).rows;
      const refunds=(await db.query("SELECT method,SUM(amount)::text AS amount FROM iutra_pos.pos_refunds WHERE executed_shift_id=$1 AND status='succeeded' GROUP BY method",[shift.id])).rows;
      const sales=sums.filter(s=>s.purpose==='sales').reduce((n,s)=>n+BigInt(s.amount),0n),topups=sums.filter(s=>s.purpose==='topup').reduce((n,s)=>n+BigInt(s.amount),0n);
      const expected=await this.expectedCash(ctx,shift);
      const unresolved=row(await db.query("SELECT COUNT(*)::integer AS count FROM iutra_pos.pos_exceptions e JOIN iutra_pos.pos_payment_requests r ON r.id=e.request_id WHERE r.shift_id=$1 AND e.status='open'",[shift.id]));
      const result={shiftId:shift.id,status:shift.status,timezone:ctx.timezone,openedAt:shift.opened_at,closedAt:shift.closed_at,currency:'VND',sales:String(sales),topups:String(topups),refunds:String(refunds.reduce((n,r)=>n+BigInt(r.amount),0n)),expectedCash:String(expected),countedCash:shift.counted_cash===null?null:String(shift.counted_cash),difference:shift.difference===null?null:String(shift.difference),payments:sums,refundsByMethod:refunds,unresolvedExceptions:unresolved.count,reconciled:false,reviewStatus:'not_signed_off'};
      if(!asCSV) return result;
      await this.audit(ctx,'export.shift',shift.id,'班次報表匯出',{currency:'VND',timezone:ctx.timezone});
      const rows=[['欄位','值'],...Object.entries(result).filter(([,v])=>v===null||typeof v!=='object')];
      return '﻿'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
    });
  }
}
