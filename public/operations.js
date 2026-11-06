// This module also exports the request journal for fault-injection tests without a DOM.
export const PENDING_KEY = 'iutra.pos.pending.v1';
export const CART_KEY = 'iutra.pos.cart';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFINITIVE = new Set([400, 409, 422]);
// Match credential field names, not substrings such as the "pin" in toppings.
const SECRET = /^(?:pin|pin_hash|password|password_hash|currentPassword|token|token_hash|verificationToken|deviceKey|device_key|key_hash|authorization|secret)$/i;
const COMMANDS = new Set(['openShift','closeShift','cashMovement','createOrder','cancelOrder','requestPayment','cancelPayment','confirmCash','confirmBank','topup','chargeWallet','createMember','adjustWallet','requestRefund','approveRefund','startRefund','finishRefund','cancelRefund','reprint','claimPrint','finishPrint','setBank','setProduction','reviewException','creditFundedTopup']);
export function newUUID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export class RequestError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
export async function httpRequest(path, { method = 'GET', body, token = '', deviceId = '', deviceKey = '', key, raw = false, fetcher = globalThis.fetch, deadline = 10000 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RequestError('連線已逾時，結果尚未確認。')); }, deadline); });
  try {
    return await Promise.race([timeout, (async () => {
    const pos = path.startsWith('/api/v1/pos/');
    if (pos && (!token || !UUID.test(deviceId) || !deviceKey)) throw new RequestError('請登入並提供有效的設備識別與密鑰。');
    const response = await fetcher(path, {
      method, signal: controller.signal, cache: 'no-store', credentials: 'omit',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(pos ? { 'X-POS-Device': deviceId, 'X-POS-Key': deviceKey } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });
    if (raw && response.ok) return await response.blob();
    let envelope;
    try { envelope = await response.json(); } catch {
      throw new RequestError('伺服器回應無法讀取，請查詢原操作結果。', response.ok ? 0 : response.status);
    }
    if (!response.ok) throw new RequestError(envelope.error?.message || `操作未完成（HTTP ${response.status}），請核對原紀錄。`, response.status);
    return Object.hasOwn(envelope, 'data') ? envelope.data : envelope;
    })()]);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(error.name === 'AbortError' ? '連線已逾時，結果尚未確認。' : '無法連線，結果尚未確認。');
  } finally { clearTimeout(timer); }
}
function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET.test(k)).map(([k,v]) => [k, withoutSecrets(v)]));
  return value;
}
export function assertBinding(pending, identity) {
  if (!identity?.userId || pending.userId !== identity.userId || pending.deviceId.toLowerCase() !== identity.deviceId?.toLowerCase()) throw new RequestError('尚有原操作待確認，必須使用原員工帳號與原設備重新登入。');
}
export class PendingOperations {
  constructor({ storage, send, uuid = newUUID, now = () => new Date().toISOString() }) {
    this.storage = storage; this.send = send; this.uuid = uuid; this.now = now; this.pending = null; this.memoryBody = null; this.busy = false; this.storageError = '';
    try {
      const saved = storage.getItem(PENDING_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (p.schema !== 1 || !UUID.test(p.key) || !COMMANDS.has(p.command) || !p.userId || !UUID.test(p.deviceId) || !p.body || typeof p.body !== 'object' || Array.isArray(p.body) || JSON.stringify(withoutSecrets(p.body)) !== JSON.stringify(p.body)) throw new Error();
        this.pending = p;
        // Restore public intent only; secrets must be entered again before resuming the original key.
        if (!p.requiresSecret) this.memoryBody = JSON.stringify(p.body);
      }
    } catch { this.storageError = '無法安全讀取待確認紀錄。請由管理者核對此分頁的原操作，暫停新增交易。'; }
  }
  get blocked() { return Boolean(this.pending || this.storageError || this.busy); }
  get canRetry() { return Boolean(this.pending && this.memoryBody); }
  clear() {
    this.storage.removeItem(PENDING_KEY);
    this.pending = null; this.memoryBody = null;
  }
  async start(command, body, identity) {
    if (this.blocked) throw new RequestError('請先查詢或重試待確認的原操作。');
    if (!COMMANDS.has(command) || !identity?.userId || !UUID.test(identity.deviceId)) throw new RequestError('操作或身分資料不正確。');
    const serialized = JSON.stringify(body), safeBody = withoutSecrets(JSON.parse(serialized));
    const pending = { schema: 1, key: this.uuid(), command, body: safeBody, userId: identity.userId, deviceId: identity.deviceId.toLowerCase(), createdAt: this.now(), requiresSecret: JSON.stringify(safeBody) !== serialized };
    if(typeof identity.displayPair==='string' && identity.displayPair.length<=200)pending.displayPair=identity.displayPair;
    // setItem must complete before the first byte of a financial request is sent.
    try { this.storage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { throw new RequestError('無法保存待確認紀錄，操作尚未送出。請確認瀏覽器允許分頁儲存。'); }
    this.pending = pending; this.memoryBody = serialized;
    return this.retry(identity);
  }
  async retry(identity) {
    if (this.storageError || !this.pending) throw new RequestError(this.storageError || '沒有待確認操作。');
    assertBinding(this.pending, identity);
    if (this.busy) throw new RequestError('原操作正在處理，請稍候。');
    if (!this.memoryBody) throw new RequestError('此操作包含未保存的驗證資料，請先查詢原操作，或重新驗證後以原識別繼續，請勿再次收款。');
    this.busy = true;
    try {
      const p = this.pending;
      const result = await this.send(`/api/v1/pos/commands/${p.command}`, { method: 'POST', body: this.memoryBody, key: p.key });
      this.checkResult(result);
      this.clear(); return result;
    } catch (error) {
      if (DEFINITIVE.has(error.status)) this.clear();
      throw error;
    } finally { this.busy = false; }
  }
  async resumeSecret(body, identity) {
    if (!this.pending?.requiresSecret || this.busy) throw new RequestError('目前不需要重新驗證。');
    assertBinding(this.pending, identity);
    if (JSON.stringify(withoutSecrets(body)) !== JSON.stringify(this.pending.body)) throw new RequestError('恢復內容與原操作不符，不能變更對象或金額。');
    this.memoryBody = JSON.stringify(body);
    return this.retry(identity);
  }
  checkResult(result) {
    if (!result || result.key !== this.pending.key || result.command !== this.pending.command || !Object.hasOwn(result, 'result')) throw new RequestError('回應未能確認原操作識別，請查詢原操作。');
  }
  async query(identity) {
    if (this.storageError || !this.pending) throw new RequestError(this.storageError || '沒有待確認操作。');
    assertBinding(this.pending, identity);
    if (this.busy) throw new RequestError('原操作正在處理，請稍候。');
    this.busy = true;
    try {
      const result = await this.send(`/api/v1/pos/operations/${this.pending.key}`);
      this.checkResult(result); this.clear(); return result;
    } finally { this.busy = false; } // 404/401/5xx do not establish that the command never ran.
  }
}
export async function collectionPage(send, collection, existing = [], append = false) {
  const before=append?existing.at(-1)?.id:null;
  const page=await send(`/api/v1/pos/${collection}?limit=50${before?`&before=${encodeURIComponent(before)}`:''}`);
  if(!Array.isArray(page))throw new RequestError('紀錄回應格式不正確。');
  const rows=append?[...existing,...page.filter(row=>!existing.some(old=>old.id===row.id))]:page;
  return {rows,hasMore:collection!=='banks' && page.length===50};
}
export function importCart(raw) {
  const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!input || typeof input.menuRelease !== 'string' || !input.menuRelease || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new RequestError('購物車沒有有效品項，請返回點餐頁重新選擇。');
  const items = input.items.map(item => {
    if (!item || typeof item.productId !== 'string' || typeof item.variantId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100 || !Array.isArray(item.toppings)) throw new RequestError('購物車品項格式不正確，請返回點餐頁檢查。');
    return {
      productId: item.productId, variantId: item.variantId, quantity: item.quantity,
      toppings: item.toppings.map(t => ({ id: t.id, portions: t.portions })),
      options: (item.options || []).map(o => ({ groupId: o.groupId, valueIds: [...o.valueIds] })),
      customerNote: String(item.customerNote || ''), internalNote: String(item.internalNote || '')
    };
  });
  if(input.clientOrderId!==undefined && !UUID.test(input.clientOrderId))throw new RequestError('購物車訂單識別不正確，請返回點餐頁重新載入。');
  return { menuRelease: input.menuRelease, items, ...(input.clientOrderId?{clientOrderId:input.clientOrderId}:{}) }; // Client prices, totals and arbitrary properties are discarded.
}
const MONEY = /^-?\d+$/;
export function money(value) {
  if (value === null || value === undefined || !MONEY.test(String(value))) return '—';
  return `${BigInt(value).toLocaleString('vi-VN')} ₫`;
}

const LABELS = {
  id:'識別碼',status:'狀態',version:'版本',order_id:'訂單',orderId:'訂單',payment_request_id:'付款請求',method:'付款方式',purpose:'用途',amount:'金額',amount_vnd:'金額',total_vnd:'訂單金額',total:'合計',balance:'餘額',balance_vnd:'可用餘額',opening_cash:'備用金',opening_cash_vnd:'備用金',counted_cash:'實點現金',expected_cash:'預期現金',difference:'差異',responsibility:'班次責任人',created_at:'建立時間',updated_at:'更新時間',opened_at:'開班時間',closed_at:'關班時間',member_code:'會員代碼',display_name:'顯示名稱',member_id:'會員',wallet_id:'錢包',shift_id:'班次',reason:'原因',reference:'憑證識別',external_ref:'銀行交易識別',booked_at:'入帳時間',note:'備註',delta:'調整金額',direction:'流向',category:'分類',production_status:'製作狀態',payment_status:'付款狀態',change:'找零',tendered:'實收',name:'名稱',bankCode:'銀行代碼',bank_code:'銀行代碼',accountNumber:'收款帳號',account_number:'收款帳號',accountName:'收款戶名',account_name:'收款戶名',verified:'已核對帳戶',currency:'幣別',bankSnapshot:'收款帳戶快照',bank_snapshot:'收款帳戶快照',qrPayload:'付款資料字串',qr_payload:'付款資料字串',payment:'收款',order:'訂單',refund:'退款',printJob:'列印工作',wallet:'錢包',openingCash:'備用金',cashSales:'現金銷售',cashTopups:'現金儲值',cashRefunds:'現金退款',cashIn:'其他現金流入',cashOut:'其他現金流出',expectedCash:'預期現金',countedCash:'實點現金',cashDifference:'現金差異',bankSales:'銀行銷售',walletSales:'儲值消費',sales:'銷售',salesTotal:'銷售合計',refunds:'退款',topups:'儲值收款',bankPayments:'銀行收款',walletPayments:'儲值消費',exceptions:'待核對異常',payments:'收款',cashMovements:'現金收支',entries:'錢包流水',totals:'合計',store:'門市',device:'設備',shift:'班次',report:'班次報表',refund_total:'已退金額',reserved_refund:'保留退款',attempts:'嘗試次數',printer_name:'印表機',kind:'類型',outcome:'處理結果',original_job_id:'原列印工作',client_order_id:'點餐識別',paymentRequest:'付款請求',payment_request:'付款請求'
};
Object.assign(LABELS,{principal_balance:'可用本金餘額',bonus_balance:'贈金餘額',change_given:'找零',expires_at:'到期時間',shiftId:'班次識別',timezone:'門市時區',openedAt:'開班時間',closedAt:'關班時間',unresolvedExceptions:'未核對異常筆數',reconciled:'已完成核對',refundsByMethod:'退款分類',store_id:'門市識別',device_id:'設備識別',request_id:'原付款請求',executed_shift_id:'退款執行班次',sales:'飲品銷售',topups:'儲值收款'});
Object.assign(LABELS,{subtotal:'商品小計',business_date:'營業日',confirmed_at:'收款確認時間',principal_balance:'可用本金',bonus_balance:'贈金',balance_after:'本次異動後餘額',change_given:'找零',document_kind:'文件種類',cup_key:'杯序',reprint_of:'原列印工作',unresolvedExceptions:'未結核帳異常',reconciled:'中央對帳已簽認',reviewStatus:'覆核狀態',bank_identity:'收款帳戶識別',observed_amount:'觀察到帳金額',observed_at:'觀察時間',executed_shift_id:'退款執行班次',payment_id:'原收款',openedAt:'開班時間',closedAt:'關班時間',shiftId:'班次',timezone:'門市時區'});
const VALUES = {funded_pending_credit:'已到款待入儲值',reviewed:'已記錄核對',short:'少款',over:'溢款',duplicate:'重複來源',unmatched:'待配對',late:'逾期到款',credited:'已入儲值',awaiting_funds:'等待到款',frozen:'已凍結',not_signed_off:'尚未簽認',completed:'訂單已付款完成',draft:'待收款',not_started:'尚未製作',sales:'銷售',cash:'現金',bank:'銀行',wallet:'儲值',pending:'待處理',requested:'已申請',awaiting_payment:'待付款',processing:'處理中',unknown:'結果未知',succeeded:'已成功',failed:'已失敗',cancelled:'已取消',canceled:'已取消',paid:'已付款',unpaid:'未付款',open:'進行中',closed:'已關班',approved:'已核准',created:'已建立',printed:'已印出',printing:'列印中',queued:'排隊中',preparing:'製作中',ready:'待取餐',handed_over:'已交付',stopped:'已停止',wasted:'已報廢',sale:'銷售',topup:'儲值',payment:'付款',in:'流入',out:'流出',active:'啟用',true:'是',false:'否'};
const TITLES = {creditFundedTopup:'將原到款補入儲值',reviewException:'記錄核帳結果',openShift:'開班',closeShift:'關班',cashMovement:'記錄現金收支',createOrder:'建立訂單',cancelOrder:'取消訂單',requestPayment:'建立付款請求',cancelPayment:'取消付款請求',confirmCash:'確認現金收款',confirmBank:'核對銀行入帳',topup:'建立儲值收款請求',chargeWallet:'以已驗證錢包扣款',createMember:'建立會員',adjustWallet:'新增錢包調整',requestRefund:'申請退款',approveRefund:'核准退款',startRefund:'開始執行退款',finishRefund:'記錄退款結果',cancelRefund:'取消退款',reprint:'申請補印',claimPrint:'領取列印工作',finishPrint:'記錄實際列印結果',setBank:'儲存銀行設定',setProduction:'更新製作狀態'};
const COLLECTIONS = {
  orders:['已儲存訂單','pos'],shifts:['班次紀錄','pos'],paymentRequests:['付款請求','pos'],payments:['收款紀錄','reports'],members:['會員','members'],wallets:['錢包','members'],entries:['錢包流水','members'],refunds:['退款','refund.request'],exceptions:['核帳異常','bank.confirm'],printJobs:['列印佇列','print'],audit:['稽核紀錄','audit'],cashMovements:['現金收支','reports'],banks:['收款銀行','bank.manage']
};
const PANELS = [
  ['shift','班次與現金','pos','先確認責任人與備用金；關班前核對實點、預期現金及未決紀錄。'],
  ['orders','訂單與收款','pos','先儲存訂單，再建立單一付款請求。更換方式前必須取消舊請求。'],
  ['members','會員與儲值','members|wallet.topup|wallet.charge|wallet.adjust|members.manage','找到會員不代表通過付款驗證。儲值須先確認收款才會增加餘額。'],
  ['refunds','退款與異常','refund.request|refund.approve|refund.execute|bank.confirm','核准、實際付款與完成紀錄分開處理。結果未知時先核對，不可再次退款。'],
  ['print','列印中心','print|print.reprint','此頁記錄工作與人工結果，不直接控制印表機。未知結果請先查看實際紙張。'],
  ['bank','收款銀行','bank.manage','請先與實際銀行帳戶核對，再啟用供新付款請求使用。'],
  ['reports','報表與稽核','reports|audit|export','儲值收款與之後的消費分開核對；銀行及錢包收款不計入現金實點。']
];
// Form definitions contain only reviewed fields, never a free-form JSON command console.
const F = (name,label,type='text',options={}) => ({name,label,type,...options});
const amount = (name='amount',label='金額（VND）') => F(name,label,'money');
const reason = () => F('reason','原因','textarea');
const method = () => F('method','付款方式','select',{choices:[['cash','現金'],['bank','銀行'],['wallet','儲值']]});
const COMMAND_FORMS = [
  {key:'openShift',panel:'shift',permission:'pos',fields:[amount('openingCash','備用金（VND）'),F('responsibility','本班責任人')],need:'noShift'},
  {key:'closeShift',panel:'shift',permission:'pos',target:'currentShift',version:true,fields:[amount('countedCash','實點現金（VND）'),reason()],need:'shift',help:'請先查閱班次報表。差異原因會與關班結果一併保存。'},
  {key:'cashMovement',panel:'shift',permission:'cash.manage',fields:[F('direction','現金流向','select',{choices:[['in','流入'],['out','流出']]}),amount(),F('category','收支分類'),reason()],need:'shift'},
  {key:'cancelOrder',panel:'orders',permission:'pos',target:'orders',version:true,fields:[reason()]},
  {key:'requestPayment',panel:'orders',permission:'pos',target:'orders',targetName:'orderId',version:true,fields:[method()],need:'payment'},
  {key:'cancelPayment',panel:'orders',permission:'pos',target:'paymentRequests',fields:[reason()]},
  {key:'confirmCash',panel:'orders',permission:'pos',target:'paymentRequests',fields:[amount('tendered','實收鈔票金額（VND）')],need:'cash',help:'應付金額來自已鎖定的付款請求；實收不足不能完成，找零以伺服器結果為準。'},
  {key:'confirmBank',panel:'orders',permission:'bank.confirm',target:'paymentRequests',fields:[F('externalRef','銀行唯一交易識別'),amount('amount','實際入帳金額（VND）'),F('bookedAt','銀行入帳時間（設備本地時間）','datetime-local'),F('note','核對備註','textarea')],need:'bank',help:'先查看店家銀行到帳紀錄，核對戶名、帳號、金額、時間及識別。顧客截圖不代表到帳。'},
  {key:'setProduction',panel:'orders',permission:'pos',target:'orders',targetName:'orderId',version:true,fields:[F('status','製作狀態','select',{choices:[['preparing','製作中'],['ready','待取餐'],['handed_over','已交付'],['stopped','停止製作'],['wasted','報廢']]})]},
  {key:'createMember',panel:'members',permission:'members.manage',fields:[F('memberCode','會員代碼'),F('displayName','顯示名稱'),F('pin','會員 PIN','password',{secret:true})],policy:'pin',help:'僅在門市已明確啟用 PIN 驗證政策時開放建立會員。PIN 不會保存至分頁儲存。'},
  {key:'topup',panel:'members',permission:'wallet.topup',fields:[amount(),F('method','儲值付款方式','select',{choices:[['cash','現金'],['bank','銀行']]})],policy:'wallet',need:'walletShift',help:'建立後請到「訂單與收款」選取此儲值付款請求，確認現金或銀行到帳。'},
  {key:'chargeWallet',panel:'members',permission:'wallet.charge',target:'paymentRequests',fields:[],policy:'pinWallet',need:'verification',help:'先選取錢包與會員，對目前付款請求進行 PIN 驗證，再扣款。憑證只留在本頁。'},
  {key:'adjustWallet',panel:'members',permission:'wallet.adjust',fields:[F('delta','調整金額（正數增加／負數減少，VND）','signedMoney'),F('reference','來源憑證識別'),reason()],policy:'wallet',need:'wallet'},
  {key:'requestRefund',panel:'refunds',permission:'refund.request',target:'orders',targetName:'orderId',fields:[amount('amount','申請退款金額（VND）'),reason()],policy:'refund',help:'可退額與部分退款依門市政策及原交易核算，伺服器會拒絕超額或重複申請。'},
  {key:'approveRefund',panel:'refunds',permission:'refund.approve',target:'refunds',version:true,fields:[],policy:'refund'},
  {key:'startRefund',panel:'refunds',permission:'refund.execute',target:'refunds',version:true,fields:[],policy:'refund',help:'此步驟只開始執行。核對原付款管道並實際交付退款後，再記錄結果。'},
  {key:'finishRefund',panel:'refunds',permission:'refund.execute',target:'refunds',version:true,fields:[F('outcome','實際退款結果','select',{choices:[['unknown','結果未知，保留額度'],['succeeded','已確認退款成功'],['failed','已核實未付款／失敗']]}),F('externalRef','外部交易識別','text',{required:false}),reason()],policy:'refund'},
  {key:'cancelRefund',panel:'refunds',permission:'refund.request|refund.execute',target:'refunds',version:true,fields:[reason()],policy:'refund',help:'只可取消尚未執行的退款；處理中或結果未知須先核實資金事實。'},
  {key:'creditFundedTopup',panel:'refunds',permission:'bank.confirm',target:'exceptions',fields:[reason()],policy:'wallet',help:'僅將原已到帳且金額相符的款項補入原錢包。須另有儲值權限、原設備及原開啟班次；不重新收款。'},
  {key:'reviewException',panel:'refunds',permission:'bank.confirm',target:'exceptions',fields:[F('resolution','核對結果','textarea')],help:'記錄核對結果；此動作不新增收款或退款。已到款待儲值須使用原款補入。'},
  {key:'claimPrint',panel:'print',permission:'print',target:'printJobs',version:true,fields:[]},
  {key:'finishPrint',panel:'print',permission:'print',target:'printJobs',version:true,fields:[F('outcome','實際紙張結果','select',{choices:[['unknown','結果未知，需核對紙張'],['printed','已確認印出'],['failed','已確認未印出／失敗']]}),reason()]},
  {key:'reprint',panel:'print',permission:'print.reprint',target:'printJobs',fields:[reason()],help:'補印會建立新工作並保留原因，不代表已實際印出。'},
  {key:'setBank',panel:'bank',permission:'bank.manage',fields:[F('bankCode','銀行代碼'),F('accountNumber','收款帳號'),F('accountName','收款戶名'),F('verified','已核對實際收款戶與帳號','checkbox',{required:false}),F('expectedVersion','目前銀行設定版本','integer'),F('currentPassword','重新輸入員工登入密碼','password',{secret:true}),reason()],help:'版本須以目前門市設定為準；未取得版本時請向管理者核對，不推測版本。QR 格式仍需實機驗證。'}
];

export function mountOperations(document, window) {
  const $ = s => document.querySelector(s);
  const state = { token:'',user:null,deviceId:'',deviceKey:'',context:null,fresh:false,busy:false,lists:{},hasMore:{},readReady:{},selected:{},cart:null,cartRaw:null,displayPair:null,verification:null,active:'shift',forms:[],pickers:[],result:null,qrUrls:[],qrTimers:[],catalog:null };
  let checkoutChannel;
  try { checkoutChannel=new window.BroadcastChannel('iutra-pos-checkout'); } catch {}
  const node = (tag,text,cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  const say = (text,error=false) => { $('#message').textContent=text; $('#message').classList.toggle('error',error); };
  const identity = () => ({userId:state.user?.id,deviceId:state.deviceId,displayPair:state.displayPair});
  function publicCheckout(phase, {order,request,qrDataUrl}={}) {
    if(!checkoutChannel || !state.displayPair || !order?.id)return;
    const bank=request?.bankSnapshot || request?.bank_snapshot;
    const bankSnapshot=bank?{bankCode:bank.bankCode,accountNumber:bank.accountNumber,accountName:bank.accountName,version:bank.version}:undefined;
    checkoutChannel.postMessage({type:'checkout',pair:state.displayPair,phase,orderId:order.id,clientOrderId:order.client_order_id,items:(order.quote?.items || []).map(item=>({name:item.nameZh,variant:item.variant,quantity:item.quantity,unitPrice:item.unitPrice,lineTotal:item.lineTotal,customerNote:item.customerNote || '',options:(item.options || []).map(g=>({name:g.nameZh,values:g.values.map(v=>v.nameZh)})),toppings:(item.toppings || []).map(t=>({name:t.nameZh,portions:t.portions}))})),expiresAt:request?.expires_at,method:request?.method,total:String(order.total ?? order.quote?.total ?? request?.amount ?? ''),pickupNumber:order.pickup_number || order.pickupNumber, ...(phase==='payment' && request?.method==='bank'?{bankSnapshot,qrPayload:request.qrPayload || request.qr_payload,...(qrDataUrl?{qrDataUrl}:{})}: {})});
  }
  const api = (path,options={}) => httpRequest(path,{...options,token:state.token,deviceId:state.deviceId,deviceKey:state.deviceKey});
  let storage;
  try { storage=window.sessionStorage; } catch { storage={getItem(){throw new Error();}}; }
  const journal = new PendingOperations({storage,send:api});
  state.displayPair=journal.pending?.displayPair || null;
  let checkoutBinding=null;
  try {
    checkoutBinding=JSON.parse(storage.getItem('iutra.pos.workcheckout') || 'null');
    if(!UUID.test(checkoutBinding?.clientOrderId) || typeof checkoutBinding?.displayPair!=='string')checkoutBinding=null;
    state.displayPair ||= checkoutBinding?.displayPair || null;
  } catch { /* Pending journal still governs all financial recovery. */ }
  let recoveringCheckout=false;
  if(checkoutChannel)checkoutChannel.onmessage=async({data})=>{
    const binding=checkoutBinding;
    if(!binding || data?.pair!==binding.displayPair || data.clientOrderId!==binding.clientOrderId)return;
    if(data.type==='checkout-ack' && data.orderId===binding.orderId && ['completed','standby'].includes(data.phase)) {
      try { storage.removeItem('iutra.pos.workcheckout'); checkoutBinding=null; } catch {}
      return;
    }
    if(data.type!=='checkout-request' || !UUID.test(binding.orderId) || !state.token || state.busy || recoveringCheckout)return;
    recoveringCheckout=true;
    try {
      const order=await api(`/api/v1/pos/orders/${encodeURIComponent(binding.orderId)}`);
      if(checkoutBinding!==binding || order.client_order_id!==binding.clientOrderId)return;
      if(order.status==='completed' || order.status==='cancelled')publicCheckout(order.status==='completed'?'completed':'standby',{order});
    } catch { /* Keep the binding; the main page retries after reconnection/login. */ }
    finally { recoveringCheckout=false; }
  };
  function releaseQRs() { for(const url of state.qrUrls)URL.revokeObjectURL(url);state.qrUrls=[];for(const timer of state.qrTimers)clearTimeout(timer);state.qrTimers=[]; }
  function addQR(row,parent) {
    if(row?.method!=='bank' || row.status!=='pending')return;
    const area=node('div'),button=node('button','取得此付款請求的 QR'),image=node('img');button.type='button';button.dataset.read='';
    image.alt='目前付款請求的收款 QR，請核對下方銀行快照';image.className='payment-qr';image.hidden=true;
    const expires=Date.parse(row.expires_at);
    const expire=()=>{image.hidden=true;image.removeAttribute('src');button.hidden=true;area.replaceChildren(node('p','付款碼已到期，請核對原付款；請勿再次付款。'));};
    if(!Number.isFinite(expires) || expires<=Date.now()){parent.append(node('p','付款碼已到期，請先核對原付款。'));return;}
    state.qrTimers.push(setTimeout(expire,Math.min(expires-Date.now(),2147483647)));
    area.append(button,image,node('p','QR 僅供付款，顯示或掃描皆不代表已入帳。請核對銀行快照與有效期限。','help'));parent.append(area);
    button.addEventListener('click',()=>perform(async()=>{
      const blob=await api(`/api/v1/pos/qr/${encodeURIComponent(row.id)}`,{raw:true});
      if(!parent.isConnected || selected('paymentRequests')?.id!==row.id || selected('paymentRequests')?.status!=='pending' || (row.expires_at && new Date(row.expires_at)<=new Date()))return;
      const qrDataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new RequestError('付款 QR 無法讀取。'));reader.readAsDataURL(blob);});
      if(!/^data:image\/png;base64,/.test(qrDataUrl))throw new RequestError('付款 QR 回應格式不正確，請核對銀行資訊。');
      if(!parent.isConnected || selected('paymentRequests')?.id!==row.id || selected('paymentRequests')?.status!=='pending' || (row.expires_at && new Date(row.expires_at)<=new Date()))return;
      const url=URL.createObjectURL(blob);state.qrUrls.push(url);image.src=url;image.hidden=false;button.hidden=true;
      const order=selected('orders');if(row.order_id===order?.id)publicCheckout('payment',{order,request:row,qrDataUrl});
    }));
  }
  const has = permission => Boolean(state.context) && permission.split('|').some(p=>state.context.permissions?.includes(p));
  const policy = () => ({walletEnabled:false,memberVerification:null,refundEnabled:false,partialRefunds:false,refundMax:'0',dualApproval:true,...state.context?.policy});
  const selected = collection => collection==='currentShift' ? state.context?.currentShift : state.selected[collection];
  const display = value => value===null || value===undefined ? '—' : VALUES[String(value)] || String(value);
  const version = row => { if(row?.version===undefined || row.version===null) throw new RequestError('未取得目前版本，請重新載入紀錄後操作。'); return row.version; };
  function safeDetails(value,parent,depth=0) {
    if (!value || typeof value!=='object' || depth>3) return;
    const dl=node('dl');
    for(const [key,v] of Object.entries(value)) {
      if(SECRET.test(key) || ['quote','items','request','payload','permissions','policy','qrPayload','qr_payload','store_id','device_id','opened_by','closed_by','staff_id','confirmed_by','updated_by','actor_id','client_order_id','menu_release'].includes(key) || v===undefined || v===null) continue;
      if(Array.isArray(v) && ['payments','refundsByMethod'].includes(key)) {
        const section=node('div');section.append(node('h3',key==='payments'?'收款分類':'退款分類'));
        for(const item of v) {const entry=node('div',undefined,'record-detail');safeDetails(item,entry,depth+1);section.append(entry);}parent.append(section);continue;
      }
      if(typeof v==='object') {
        if(!['bankSnapshot','bank_snapshot','order','payment','refund','wallet','printJob','paymentRequest','payment_request','totals','shift','store','device','report'].includes(key)) continue;
        const section=node('div'); section.append(node('h3',LABELS[key] || key)); safeDetails(v,section,depth+1); parent.append(section); continue;
      }
      const label=LABELS[key] || key;
      dl.append(node('dt',label),node('dd',/amount|balance|cash|total|change|tendered|delta|refundMax|^(sales|topups|refunds|difference)$/i.test(key) && MONEY.test(String(v)) ? money(v) : display(v)));
    }
    if(dl.children.length) parent.append(dl);
    if(value.quote?.items) {
      parent.append(node('h3','伺服器核價明細'));
      const list=node('ul',undefined,'quote-items');
      for(const item of value.quote.items) {
        const li=node('li',`${item.nameZh || item.nameVi || item.productId} · ${item.variant || item.variantId} × ${item.quantity}　${money(item.lineTotal)}`);
        const descriptions=[...(item.toppings||[]).map(t=>`${t.nameZh||t.id} ${t.portions}${t.unit||'份'}`),...(item.options||[]).flatMap(o=>(o.values||[]).map(v=>v.nameZh||v.nameVi||v.id)),item.customerNote,item.internalNote].filter(Boolean);
        if(descriptions.length) li.append(node('p',descriptions.join('、'),'help')); list.append(li);
      }
      parent.append(list,node('p',`應付 ${money(value.quote.total)}`));
    }
    const qr=value.qrPayload || value.qr_payload;
    if(qr) {
      parent.append(node('p','請在付款請求紀錄中取得 QR，並核對收款帳號與金額。掃碼後仍須核對店家銀行到帳紀錄。','help'));
    }
  }
  function resultView(result) {
    state.result=result;
    document.querySelectorAll('.receipt-result').forEach(n=>n.remove());
    const area=node('section',undefined,'receipt-result');
    area.setAttribute('aria-label','最近操作結果');
    area.append(node('h3',`${TITLES[result.command] || '原操作'}：伺服器已回覆`));
    const details=node('div',undefined,'record-detail'); safeDetails(result.result,details); area.append(details);
    if(!details.children.length) area.append(node('p','原操作已保存，請查看相關紀錄確認業務狀態。'));
    if(result.command==='startRefund') area.append(node('p','退款已進入執行流程，尚未表示顧客已收到退款。','danger-note'));
    if(['reprint','claimPrint'].includes(result.command)) area.append(node('p','此操作未確認實際紙張，請在列印中心記錄結果。','danger-note'));
    $('#panels').prepend(area);
  }
  function errorView(error) {
    if(journal.pending)publicCheckout('exception',{order:selected('orders')});
    if(error.status===401) {
      state.token='';state.fresh=false;state.verification=null;
      $('#workplace').hidden=true;$('#access').hidden=false;$('#identity').textContent='登入已失效';$('#logout').hidden=true;
      $('#password').value='';$('#device-key').value='';state.deviceKey='';
      say('登入已失效。原操作已保留，請使用同一員工帳號與同一設備重新登入後查詢或重試。',true);
    } else say(error.message || '操作未完成，請核對紀錄。',true);
  }
  function bound() { try{assertBinding(journal.pending,identity());return true;}catch{return false;} }
  function updateControls() {
    const authenticated=Boolean(state.token && state.context);
    $('#login-form').querySelectorAll('input,button').forEach(n=>{n.disabled=state.busy;});
    $('#logout').disabled=state.busy;
    $('#refresh').disabled=state.busy || !authenticated;
    $('#pending-panel').hidden=!journal.pending && !journal.storageError;
    if(journal.pending) {
      const p=journal.pending;
      $('#pending-description').textContent=`${TITLES[p.command]}，建立於 ${p.createdAt}。操作識別：${p.key}`;
      $('#pending-binding').textContent=`原員工識別 ${p.userId}；原設備 ${p.deviceId}。${p.requiresSecret && !journal.canRetry?'驗證資料未保存；請先查詢，或重新驗證後以原識別繼續。':''}`;
    } else if(journal.storageError) $('#pending-description').textContent=journal.storageError;
    $('#query-pending').disabled=state.busy || !authenticated || !journal.pending || !bound();
    $('#retry-pending').disabled=state.busy || !authenticated || !journal.canRetry || !bound();
    const recover = $('#recover-secret');
    recover.hidden = !(journal.pending?.requiresSecret && ['chargeWallet','createMember','setBank'].includes(journal.pending.command));
    recover.querySelectorAll('input,button').forEach(n=>{n.disabled=state.busy || !authenticated || !bound();});
    $('#recover-secret-label').textContent = journal.pending?.command === 'setBank' ? '重新輸入員工密碼' : '重新輸入原會員 PIN';
    for(const {spec,form,fieldset,hint} of state.forms) {
      form.hidden=!has(spec.permission);
      const unavailable=unavailableReason(spec);
      fieldset.disabled=state.busy || journal.blocked || !state.fresh || Boolean(unavailable);
      form.querySelector('button[type=submit]').disabled=fieldset.disabled;
      hint.textContent=unavailable || (journal.blocked?'先確認頁面頂部的原操作結果。':!state.fresh?'門市狀態尚未更新，請重新整理紀錄。':'');
      hint.hidden=!hint.textContent;
    }
    $('#verify-form')?.querySelectorAll('input,button').forEach(n=>{n.disabled=state.busy || journal.blocked || !state.fresh || !verificationAvailable();});
    const create=$('#create-order'); if(create) create.disabled=state.busy || journal.blocked || !state.fresh || !state.context?.currentShift || !state.cart;
    document.querySelectorAll('[data-read]').forEach(n=>{n.disabled=state.busy || !authenticated;});
    for(const picker of state.pickers)picker.select.disabled=state.busy;
    // Freeze the reviewed cart while its original createOrder is unresolved.
    $('#cart-review')?.querySelectorAll('input').forEach(n=>{n.disabled=state.busy || journal.blocked;});
  }
  function paymentActive(row) { return row && !['cancelled','canceled','failed','succeeded','paid','expired'].includes(row.status); }
  function unavailableReason(spec) {
    const p=policy(), row=spec.target?selected(spec.target):null;
    if(!has(spec.permission)) return '此帳號沒有操作權限。';
    if(['wallet','pinWallet'].includes(spec.policy) && !p.walletEnabled) return '門市尚未啟用儲值金流，暫不可操作。';
    if(['pin','pinWallet'].includes(spec.policy) && p.memberVerification!=='pin') return '門市尚未明確啟用會員 PIN 驗證政策。';
    if(spec.policy==='refund' && !p.refundEnabled) return '門市尚未啟用退款政策。';
    if(spec.key==='creditFundedTopup' && (!has('wallet.topup') || row?.kind!=='funded_pending_credit' || row?.status!=='open' || !state.context?.currentShift))return '請選取未處理的已到款待儲值紀錄，並確認原班次及儲值權限。';
    if(spec.key==='setBank' && !state.readReady.banks)return '尚未取得目前銀行設定版本，請先重新載入銀行紀錄。';
    if(spec.target && !row) return '請先選取要處理的紀錄。';
    if(spec.version && (row?.version===undefined || row.version===null)) return '紀錄缺少版本，請重新載入；不可猜測版本。';
    if(spec.need==='noShift' && state.context?.currentShift) return '目前已有開啟班次，請先完成交班。';
    if(['shift','walletShift'].includes(spec.need) && !state.context?.currentShift) return '請先開班。';
    if(['wallet','walletShift'].includes(spec.need) && !selected('wallets')) return '請先選取錢包。';
    if(spec.need==='cash' && (row?.method!=='cash' || !paymentActive(row))) return '請選取尚未完成的現金付款請求。';
    if(spec.need==='bank' && row?.method!=='bank') return '請選取銀行付款請求；已取消或完成的請求仍可登記實際到款異常。';
    if(spec.need==='payment') {
      if(!state.readReady.paymentRequests) return '付款請求紀錄尚未載入，請重新載入後核對原請求。';
      if(row?.status!=='draft' || row?.payment_status==='paid') return '此訂單目前不可建立新付款，請核對訂單狀態。';
      if((state.lists.paymentRequests||[]).some(r=>r.order_id===row?.id && paymentActive(r))) return '此訂單已有未完成的付款請求，請先核對或取消原請求。';
    }
    if(spec.need==='verification' && !verificationAvailable(true)) return '請選擇儲值付款請求與所屬會員錢包，並先完成 PIN 驗證。';
    return '';
  }
  async function contextRefresh() {
    state.fresh=false;
    const context=await api('/api/v1/pos/context');
    if(!context?.store || !context.device || context.device.id?.toLowerCase()!==state.deviceId.toLowerCase() || !Array.isArray(context.permissions)) throw new RequestError('門市／設備資訊無法核對，請重新登入。');
    state.context=context;
    try { state.catalog=await api('/api/v1/catalog/published'); } catch { state.catalog=null; }
    state.fresh=true;
    $('#store-name').textContent=context.store.name;
    $('#device-name').textContent=`${context.device.name} · ${context.store.timezone || '時區未提供'}`;
    $('#shift-state').textContent=context.currentShift?`本班責任人：${context.currentShift.responsibility || '未提供'}（${context.currentShift.status || 'open'}）`:'尚未開班';
    $('#identity').textContent=`${state.user.displayName || state.user.loginName} · ${context.store.name}`;
  }
  async function perform(action) {
    if(state.busy) return;
    state.busy=true;updateControls();
    try { await action(); } catch(error) { errorView(error); } finally{state.busy=false;updateControls();}
  }
  async function afterSuccess(result) {
    const resultData=result.result;
    const resultOrder=resultData?.order || (['createOrder','cancelOrder'].includes(result.command)?resultData:selected('orders'));
    if(result.command==='createOrder' && resultOrder?.id) {
      if(checkoutBinding?.clientOrderId===resultOrder.client_order_id) {
        checkoutBinding.orderId=resultOrder.id;
        try { storage.setItem('iutra.pos.workcheckout',JSON.stringify(checkoutBinding)); } catch { /* Server order and pending journal remain authoritative. */ }
      }
      publicCheckout(resultOrder.status==='completed'?'completed':resultOrder.status==='cancelled'?'standby':'confirm',{order:resultOrder});
    }
    if(result.command==='requestPayment' && resultData?.order_id===resultOrder?.id)publicCheckout('payment',{order:resultOrder,request:resultData});
    if(['confirmCash','confirmBank','chargeWallet'].includes(result.command) && resultData?.order?.status==='completed')publicCheckout('completed',{order:resultData.order,request:resultData.payment});
    if(result.command==='cancelOrder' && resultOrder?.status==='cancelled')publicCheckout('standby',{order:resultOrder});
    if(result.command==='cancelPayment' && resultOrder?.id && selected('paymentRequests')?.order_id===resultOrder.id && resultData?.id===selected('paymentRequests')?.id)publicCheckout('confirm',{order:resultOrder});
    // Keep the durable handoff until the main page acknowledges the terminal state.
    // A successful payment response alone does not establish that its broadcast arrived.
    state.verification=null;
    resultView(result);
    say('伺服器已保存操作，正在重新核對門市狀態。');
    try {
      await contextRefresh();
      buildWorkspace();
      resultView(result);
      await refreshLists();
      const data=result.result;
      const payment=data?.paymentRequest || data?.payment_request || (['requestPayment','topup'].includes(result.command)?data:null);
      if(payment?.id) {
        state.selected.paymentRequests=payment;
        for(const p of state.pickers.filter(p=>p.collection==='paymentRequests')) refreshPicker(p);
      }
      if(result.command==='createOrder') {
        const order=data?.order || data;
        if(order?.id) { state.selected.orders=order; for(const p of state.pickers.filter(p=>p.collection==='orders')) refreshPicker(p); }
        if(state.cartRaw && storage.getItem(CART_KEY)===state.cartRaw) storage.removeItem(CART_KEY);
        state.cart=null;state.cartRaw=null;renderCart();
      }
      say(`${TITLES[result.command] || '原操作'}已由伺服器回覆。請核對顯示的業務狀態與紀錄。`);
    } catch(error) {
      if(error.status===401) throw error;
      state.fresh=false;
      say('原操作已成功保存，但門市狀態更新失敗。請重新整理紀錄後再繼續操作。',true);
    }
  }
  async function submitCommand(spec,form) {
    const problem=unavailableReason(spec);if(problem)throw new RequestError(problem);
    if(!state.fresh)throw new RequestError('請先重新整理門市狀態。');
    const body={};
    for(const field of spec.fields) {
      const input=form.elements.namedItem(field.name);
      let value=field.type==='checkbox'?input.checked:field.secret?input.value:input.value.trim();
      if(field.required===false && value==='') { if(field.name==='externalRef')body[field.name]=''; continue; }
      if(['money','signedMoney'].includes(field.type)) {
        if(!/^-?\d+$/.test(value) || (field.type==='money' && BigInt(value)<0n))throw new RequestError(`${field.label}請輸入整數，不含千分位。`);
        value=BigInt(value).toString();
      }
      if(field.type==='integer') { if(!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))throw new RequestError('版本須為有效整數。'); value=Number(value); }
      if(field.type==='datetime-local') { const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new RequestError('請填寫有效的入帳時間。');value=date.toISOString(); }
      body[field.name]=value;
    }
    const row=spec.target?selected(spec.target):null;
    if(row) {body[spec.targetName || 'id']=row.id;if(spec.version)body.expectedVersion=version(row);}
    if(spec.key==='cashMovement' || spec.key==='topup')body.shiftId=state.context.currentShift.id;
    if(['topup','adjustWallet','chargeWallet'].includes(spec.key))body.walletId=selected('wallets').id;
    if(spec.key==='chargeWallet')body.verificationToken=state.verification.token;
    if(spec.key==='setBank')body.expectedVersion=state.lists.banks?.[0]?.version ?? 0;
    if(spec.key==='requestPayment' && body.method==='wallet' && (!policy().walletEnabled || !has('wallet.charge')))throw new RequestError('儲值付款尚未啟用或此帳號無扣款權限。');
    // Single confirmation is bound to a visible, reviewed target before generating an intent UUID.
    if(['confirmCash','confirmBank','chargeWallet','finishRefund','closeShift','adjustWallet','setBank','creditFundedTopup'].includes(spec.key) && !window.confirm(`確認「${TITLES[spec.key]}」？${row?`\n紀錄：${row.id}`:''}\n請先核對畫面中的金額、對象及實際結果。`))return;
    let operation;
    try { operation=journal.start(spec.key,body,identity()); }
    finally { for(const field of spec.fields.filter(f=>f.secret))form.elements.namedItem(field.name).value=''; }
    updateControls();
    await afterSuccess(await operation);
  }
  function addForm(spec,parent) {
    if(!has(spec.permission))return;
    const form=node('form',undefined,'command-form');form.id=`form-${spec.key}`;form.autocomplete='off';
    const fieldset=node('fieldset');fieldset.append(node('h3',TITLES[spec.key]));
    if(spec.help)fieldset.append(node('p',spec.help,'help'));
    const fields=node('div',undefined,'fields');
    for(const f of spec.fields) {
      const label=node('label',f.label,f.type==='checkbox'?'checkbox':undefined);
      let input;
      if(f.type==='select') {
        input=node('select');
        for(const [value,text] of f.choices) {
          if(spec.key==='requestPayment' && value==='wallet' && (!policy().walletEnabled || !has('wallet.charge')))continue;
          const option=node('option',text);option.value=value;input.append(option);
        }
      } else if(f.type==='textarea')input=node('textarea');
      else {input=node('input');input.type=['money','signedMoney','integer'].includes(f.type)?'text':f.type;if(['money','integer'].includes(f.type))input.inputMode='numeric';}
      input.name=f.name;input.required=f.required!==false;input.id=`${spec.key}-${f.name}`;
      if(f.type!=='select')input.maxLength=f.type==='textarea'?1000:200;
      if(f.secret)input.autocomplete='off';
      if(spec.key==='setBank' && f.name==='expectedVersion') {
        const v=state.context.policy?.bankVersion ?? state.context.policy?.bank?.version ?? state.context.bank?.version;
        if(v!==undefined && v!==null)input.value=v;
      }
      label.append(input);fields.append(label);
    }
    fieldset.append(fields);form.append(fieldset);
    const hint=node('p',undefined,'unavailable');hint.id=`hint-${spec.key}`;form.append(hint);
    const submit=node('button',TITLES[spec.key],'primary');submit.type='submit';submit.setAttribute('aria-describedby',hint.id);form.append(submit);
    form.addEventListener('submit',event=>{event.preventDefault();perform(()=>submitCommand(spec,form));});
    parent.append(form);state.forms.push({spec,form,fieldset,hint});
  }
  function refreshPicker(picker) {
    const {collection,select,detail}=picker, rows=state.lists[collection]||[], current=state.selected[collection];
    select.replaceChildren();const empty=node('option',rows.length?'請選取紀錄':'目前沒有可用紀錄');empty.value='';select.append(empty);
    const values=current && !rows.some(r=>r.id===current.id)?[current,...rows]:rows;
    for(const row of values) {
      const name=row.display_name || row.member_code || row.responsibility || row.id;
      const total=row.total ?? row.total_vnd ?? row.amount ?? row.amount_vnd ?? row.principal_balance ?? row.balance_vnd;
      const option=node('option',`${name} · ${display(row.status || row.method || '')}${total!==undefined?` · ${money(total)}`:''}`);option.value=row.id;select.append(option);
    }
    select.value=current?.id || '';detail.replaceChildren();if(current){safeDetails(current,detail);if(collection==='paymentRequests')addQR(current,detail);}
  }
  function addNextPage(collection,parent) {
    if(collection==='banks')return;
    const button=node('button','載入更多紀錄');button.type='button';button.dataset.read='';button.dataset.nextPage=collection;
    button.hidden=!state.hasMore[collection];
    button.addEventListener('click',()=>perform(()=>loadCollection(collection,true)));
    parent.append(button);
  }
  function addPicker(collection,parent,label) {
    if(!has(COLLECTIONS[collection][1]))return;
    const wrap=node('div',undefined,'record-picker'), l=node('label',label || COLLECTIONS[collection][0]), select=node('select');
    select.setAttribute('aria-label',label || COLLECTIONS[collection][0]);l.append(select);wrap.append(l);
    const reload=node('button','重新載入');reload.type='button';reload.dataset.read='';wrap.append(reload);
    const detail=node('div',undefined,'record-detail');parent.append(wrap);addNextPage(collection,parent);parent.append(detail);
    const picker={collection,select,detail};state.pickers.push(picker);refreshPicker(picker);
    reload.addEventListener('click',()=>perform(()=>loadCollection(collection)));
    select.addEventListener('change',()=>perform(async()=>{
      state.verification=null;
      if(!select.value)delete state.selected[collection];
      else {
        const row=await api(`/api/v1/pos/${collection}/${encodeURIComponent(select.value)}`);
        state.selected[collection]=row;
      }
      for(const p of state.pickers.filter(p=>p.collection===collection))refreshPicker(p);
    }));
  }
  async function loadCollection(collection, append=false) {
    state.readReady[collection]=false;
    const page=await collectionPage(api,collection,state.lists[collection]||[],append);
    const rows=page.rows;
    state.lists[collection]=rows;state.hasMore[collection]=page.hasMore;
    for(const button of document.querySelectorAll(`[data-next-page="${collection}"]`))button.hidden=!page.hasMore;
    const current=state.selected[collection];
    if(current) {
      const row=await api(`/api/v1/pos/${collection}/${encodeURIComponent(current.id)}`);
      state.selected[collection]=row;
    } else if(collection==='orders' && UUID.test(checkoutBinding?.orderId)) {
      const boundOrder=await api(`/api/v1/pos/orders/${encodeURIComponent(checkoutBinding.orderId)}`);
      if(boundOrder.client_order_id!==checkoutBinding.clientOrderId)throw new RequestError('原結帳訂單識別不符，請核對原紀錄。');
      state.selected.orders=boundOrder;
    }
    state.readReady[collection]=true;
    if(collection==='banks') {
      const current=rows[0],form=$('#form-setBank');
      if(form) {
        form.elements.namedItem('expectedVersion').value=current?.version ?? 0;
        form.elements.namedItem('expectedVersion').readOnly=true;
        for(const [name,column] of [['bankCode','bank_code'],['accountNumber','account_number'],['accountName','account_name']])form.elements.namedItem(name).value=current?.[column] || '';
        form.elements.namedItem('verified').checked=current?.verified===true;
      }
      const detail=$('#bank-detail');if(detail){detail.replaceChildren();safeDetails(current,detail);if(!current)detail.append(node('p','尚未設定收款銀行。'));}
    }
    if(collection==='orders' && checkoutBinding && !state.selected.orders)state.selected.orders=rows.find(r=>r.client_order_id===checkoutBinding.clientOrderId) || null;
    for(const picker of state.pickers.filter(p=>p.collection===collection))refreshPicker(picker);
    for(const table of document.querySelectorAll(`[data-table="${collection}"]`))renderTable(collection,table);
  }
  async function refreshLists() {
    const collections=[...new Set([...state.pickers.map(p=>p.collection),...Array.from(document.querySelectorAll('[data-table]'),n=>n.dataset.table),...(has('bank.manage')?['banks']:[])])];
    const results=await Promise.allSettled(collections.map(c=>loadCollection(c)));
    const auth=results.find(r=>r.status==='rejected' && r.reason.status===401);if(auth)throw auth.reason;
    const failures=results.flatMap((r,i)=>r.status==='rejected'?[COLLECTIONS[collections[i]][0]]:[]);
    if(failures.length)throw new RequestError(`部分紀錄無法讀取：${failures.join('、')}。請使用各區「重新載入」再次核對。`);
  }
  function renderTable(collection,container) {
    container.replaceChildren();const rows=state.lists[collection]||[];
    if(!rows.length){container.append(node('p','目前沒有紀錄。','empty'));return;}
    const columns=['id','status','method','purpose','amount','amount_vnd','balance_vnd','delta','direction','category','reason','external_ref','created_at'].filter(k=>rows.some(r=>r[k]!==undefined));
    const table=node('table'),caption=node('caption',`${COLLECTIONS[collection][0]}（已載入 ${rows.length} 筆，依識別碼排序）`),thead=node('thead'),head=node('tr'),body=node('tbody');
    for(const key of columns){const th=node('th',LABELS[key] || key);th.scope='col';head.append(th);}thead.append(head);
    for(const row of rows){const tr=node('tr');for(const key of columns)tr.append(node('td',/amount|balance|delta/.test(key)?money(row[key]):display(row[key])));body.append(tr);}
    table.append(caption,thead,body);container.append(table);
  }
  function addTable(collection,parent) {
    if(!has(COLLECTIONS[collection][1]))return;
    const details=node('details');details.append(node('summary',COLLECTIONS[collection][0]));
    const reload=node('button','重新載入紀錄');reload.type='button';reload.dataset.read='';details.append(reload);
    reload.addEventListener('click',()=>perform(()=>loadCollection(collection)));addNextPage(collection,details);
    const container=node('div',undefined,'table-wrap');container.dataset.table=collection;details.append(container);parent.append(details);renderTable(collection,container);
  }
  function surface(parent,title,text) {const area=node('section',undefined,'surface');area.append(node('h3',title));if(text)area.append(node('p',text));parent.append(area);return area;}
  function renderCart() {
    const container=$('#cart-review');if(!container)return;container.replaceChildren();
    if(!state.cart) {container.append(node('p','沒有待匯入的購物車。請在點餐頁完成選品後轉至此處。','empty'));return;}
    container.append(node('p',`菜單版本：${state.cart.menuRelease}。金額由伺服器重新核價；以下品項只可調整杯數與備註，商品規格請返回點餐頁修改。`,'help'));
    for(const [i,item] of state.cart.items.entries()) {
      const product=state.catalog?.release===state.cart.menuRelease?state.catalog.products.find(p=>p.id===item.productId):null;
      const variant=product?.variants.find(v=>v.id===item.variantId);
      const row=node('div',undefined,'cart-item');row.append(node('strong',`品項 ${i+1}：${product?.nameZh || item.productId}／${variant?.label || item.variantId}`));
      row.append(node('p',`配料：${item.toppings.map(t=>`${product?.toppings.find(v=>v.id===t.id)?.nameZh || t.id} × ${t.portions}`).join('、')||'無'}；選項：${item.options.map(o=>{const group=product?.optionGroups?.find(g=>g.id===o.groupId);return `${group?.nameZh || o.groupId}：${o.valueIds.map(id=>group?.values.find(v=>v.id===id)?.nameZh || id).join('、')}`;}).join('；')||'無'}`));
      const fields=node('div',undefined,'fields');
      for(const [key,label] of [['quantity','杯數'],['customerNote','顧客備註'],['internalNote','內部備註']]) {
        const l=node('label',label),input=node('input');input.type=key==='quantity'?'number':'text';input.value=item[key];
        if(key==='quantity'){input.min='1';input.max='100';input.step='1';}else input.maxLength=500;
        input.required=key==='quantity';input.dataset.cartIndex=i;input.dataset.cartField=key;
        input.addEventListener('input',()=>{item[key]=key==='quantity'?Number(input.value):input.value;});l.append(input);fields.append(l);
      }
      row.append(fields);container.append(row);
    }
  }
  function addCart(parent) {
    const area=surface(parent,'從點餐頁建立訂單','核對品項後建立正式保存的訂單。購物車金額不作為收款依據。');
    const form=node('form'),review=node('div');review.id='cart-review';form.append(review);
    const actions=node('div',undefined,'actions'),reload=node('button','讀取點餐頁購物車');reload.type='button';reload.dataset.read='';
    const submit=node('button','建立已儲存訂單','primary');submit.id='create-order';submit.type='submit';actions.append(reload,submit);form.append(actions);area.append(form);
    function readCart(){state.cartRaw=storage.getItem(CART_KEY);state.cart=state.cartRaw?importCart(state.cartRaw):null;if(state.cartRaw){const pair=JSON.parse(state.cartRaw).displayPair;if(typeof pair==='string' && pair.length<=200)state.displayPair=pair;}renderCart();}
    reload.addEventListener('click',()=>perform(async()=>{if(journal.blocked)throw new RequestError('請先確認原操作。');readCart();}));
    if(!state.cart){try{readCart();}catch(error){say(error.message,true);}}
    renderCart();
    form.addEventListener('submit',event=>{event.preventDefault();perform(async()=>{
      if(!state.context.currentShift || !state.cart || !state.fresh)throw new RequestError('請先開班、載入購物車並核對門市狀態。');
      const cart=importCart(state.cart);
      const clientOrderId=cart.clientOrderId || newUUID();
      if(state.displayPair) {
        checkoutBinding={clientOrderId,displayPair:state.displayPair};
        storage.setItem('iutra.pos.workcheckout',JSON.stringify(checkoutBinding));
      }
      const promise=journal.start('createOrder',{...cart,clientOrderId,shiftId:state.context.currentShift.id},identity());updateControls();await afterSuccess(await promise);
    });});
  }
  function verificationAvailable(requireToken=false) {
    const request=selected('paymentRequests'),wallet=selected('wallets'),member=selected('members');
    const base=has('wallet.charge') && policy().walletEnabled && policy().memberVerification==='pin' && request?.method==='wallet' && paymentActive(request) && member && wallet && wallet.member_id===member.id;
    return Boolean(base && (!requireToken || (state.verification && state.verification.requestId===request.id && state.verification.walletId===wallet.id && state.verification.memberId===member.id)));
  }
  function addVerification(parent) {
    if(!has('wallet.charge'))return;
    const form=node('form',undefined,'command-form');form.id='verify-form';form.autocomplete='off';
    form.append(node('h3','驗證會員 PIN'),node('p','驗證僅適用目前選取的儲值付款請求與會員錢包；PIN 與驗證憑證不寫入分頁儲存。','help'));
    const label=node('label','會員 PIN'),input=node('input');input.type='password';input.required=true;input.autocomplete='off';input.name='pin';label.append(input);
    const button=node('button','驗證目前付款的會員 PIN');button.type='submit';form.append(label,button);
    if(!policy().walletEnabled || policy().memberVerification!=='pin')form.append(node('p','儲值或會員 PIN 政策尚未啟用。','unavailable'));
    form.addEventListener('submit',event=>{event.preventDefault();perform(async()=>{
      if(!verificationAvailable() || journal.blocked || !state.fresh)throw new RequestError('請先選擇有效儲值付款請求與所屬會員錢包，並核對門市政策。');
      const request=selected('paymentRequests'),wallet=selected('wallets'),member=selected('members'),pin=input.value;input.value='';state.verification=null;
      const response=await api('/api/v1/pos/commands/verifyMember',{method:'POST',key:newUUID(),body:{memberId:member.id,pin,purpose:'payment',paymentRequestId:request.id}});
      const result=response?.result ?? response;
      await contextRefresh();
      buildWorkspace();
      if(result?.verified!==true || !result?.verificationToken)throw new RequestError(result?.message || '會員驗證未取得有效憑證。');
      state.verification={token:result.verificationToken,requestId:request.id,walletId:wallet.id,memberId:member.id};
      say('會員 PIN 已驗證，請核對目前付款請求及錢包後扣款。');
    });});parent.append(form);
  }
  function addReports(parent) {
    const area=surface(parent,'班次報表','先選取班次，再取得該班的核對結果。時間依門市時區解讀。');
    addPicker('shifts',area,'要查閱的班次');
    const actions=node('div',undefined,'actions'),report=node('div',undefined,'record-detail');report.id='shift-report';
    if(has('reports')) {
      const button=node('button','查閱班次報表');button.type='button';button.dataset.read='';actions.append(button);
      button.addEventListener('click',()=>perform(async()=>{
        const shift=selected('shifts') || state.context.currentShift;if(!shift)throw new RequestError('請先選擇班次。');
        const result=await api(`/api/v1/pos/reports/${encodeURIComponent(shift.id)}`);report.replaceChildren();safeDetails(result,report);if(!report.children.length)report.append(node('p','報表尚未提供合計資料。'));
      }));
    }
    if(has('export')) {
      const button=node('button','下載班次 CSV');button.type='button';button.dataset.read='';actions.append(button);
      button.addEventListener('click',()=>perform(async()=>{
        const shift=selected('shifts') || state.context.currentShift;if(!shift)throw new RequestError('請先選擇班次。');
        const blob=await api(`/api/v1/pos/exports/${encodeURIComponent(shift.id)}`,{raw:true}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=`iutra-shift-${shift.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);say('班次 CSV 已下載。');
      }));
    }
    area.append(actions,report);
  }
  function activate(id) {
    state.active=id;
    for(const p of document.querySelectorAll('[data-panel]'))p.hidden=p.dataset.panel!==id;
    for(const n of $('#workflow-nav').querySelectorAll('button')){if(n.dataset.destination===id)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');}
  }
  function buildWorkspace() {
    releaseQRs();$('#panels').replaceChildren();$('#workflow-nav').replaceChildren();state.forms=[];state.pickers=[];
    const available=PANELS.filter(p=>has(p[2]));
    for(const [id,title,,intro] of available) {
      const nav=node('button',title);nav.type='button';nav.dataset.destination=id;nav.addEventListener('click',()=>activate(id));$('#workflow-nav').append(nav);
      const panel=node('section');panel.dataset.panel=id;panel.setAttribute('aria-labelledby',`heading-${id}`);
      const heading=node('div',undefined,'panel-heading'),text=node('div'),h=node('h2',title);h.id=`heading-${id}`;text.append(h,node('p',intro));heading.append(text);panel.append(heading);$('#panels').append(panel);
      if(id==='shift') {
        const area=surface(panel,'目前班次');const detail=node('div',undefined,'record-detail');safeDetails(state.context.currentShift,detail);if(!state.context.currentShift)detail.append(node('p','目前設備尚未開班。'));area.append(detail);
        for(const spec of COMMAND_FORMS.filter(s=>s.panel===id))addForm(spec,area);
        if(has('reports|export'))addReports(panel);addTable('cashMovements',panel);
      }
      if(id==='orders') {
        addCart(panel);const split=node('div',undefined,'split');panel.append(split);
        const orders=surface(split,'訂單核對');addPicker('orders',orders);
        for(const spec of COMMAND_FORMS.filter(s=>s.panel===id && s.target==='orders'))addForm(spec,orders);
        const payment=surface(split,'付款請求與確認','選取付款請求後，依其付款方式確認。儲值收款請求也在此處處理。');addPicker('paymentRequests',payment);
        for(const spec of COMMAND_FORMS.filter(s=>s.panel===id && s.target==='paymentRequests'))addForm(spec,payment);
        addTable('payments',panel);
      }
      if(id==='members') {
        const split=node('div',undefined,'split');panel.append(split);const member=surface(split,'會員與錢包');addPicker('members',member);addPicker('wallets',member);
        for(const spec of COMMAND_FORMS.filter(s=>s.panel===id && s.key!=='chargeWallet'))addForm(spec,member);
        const charge=surface(split,'儲值付款','選擇會員所屬錢包與目前的儲值付款請求，完成驗證後扣款。');addPicker('paymentRequests',charge);addVerification(charge);
        for(const spec of COMMAND_FORMS.filter(s=>s.key==='chargeWallet'))addForm(spec,charge);addTable('entries',panel);
      }
      if(id==='refunds') {
        const p=policy();panel.append(node('p',`退款：${p.refundEnabled?'已啟用':'未啟用'}；部分退款：${p.partialRefunds?'已啟用':'未啟用'}；上限：${money(p.refundMax)}；雙人覆核：${p.dualApproval?'需要':'依伺服器政策'}`,'help'));
        const split=node('div',undefined,'split');panel.append(split);const request=surface(split,'原訂單與申請');addPicker('orders',request);
        const processing=surface(split,'退款核准與執行');addPicker('refunds',processing);
        const exceptions=surface(panel,'銀行核帳異常');addPicker('exceptions',exceptions);
        for(const spec of COMMAND_FORMS.filter(s=>s.panel===id))addForm(spec,spec.target==='exceptions'?exceptions:spec.key==='requestRefund'?request:processing);addTable('exceptions',panel);
      }
      if(id==='print') {const area=surface(panel,'工作佇列');addPicker('printJobs',area);for(const spec of COMMAND_FORMS.filter(s=>s.panel===id))addForm(spec,area);}
      if(id==='bank') {const area=surface(panel,'門市收款帳戶','銀行設定只供具管理權限的員工修改；既有請求保留原銀行快照。');const detail=node('div',undefined,'record-detail');detail.id='bank-detail';safeDetails(state.lists.banks?.[0],detail);area.append(detail);const reload=node('button','重新載入銀行設定');reload.type='button';reload.dataset.read='';reload.addEventListener('click',()=>perform(()=>loadCollection('banks')));area.append(reload);for(const spec of COMMAND_FORMS.filter(s=>s.panel===id))addForm(spec,area);}
      if(id==='reports') {if(has('reports|export'))addReports(panel);const area=surface(panel,'交易與稽核紀錄');for(const c of ['payments','entries','cashMovements','exceptions','audit'])addTable(c,area);}
    }
    if(!available.length)$('#panels').append(node('p','此帳號尚無門市操作權限，請由管理者配置。','empty'));
    activate(available.some(p=>p[0]===state.active)?state.active:available[0]?.[0]);updateControls();
  }
  $('#login-form').addEventListener('submit',event=>{event.preventDefault();perform(async()=>{
    if(state.token)return;
    const deviceId=$('#device-id').value.trim().toLowerCase(),deviceKey=$('#device-key').value,loginName=$('#login-name').value.trim();
    if(!UUID.test(deviceId))throw new RequestError('設備識別碼須為有效 UUID。');
    if(journal.storageError)throw new RequestError(journal.storageError);
    if(journal.pending && journal.pending.deviceId.toLowerCase()!==deviceId)throw new RequestError('請使用原待確認操作的設備登入。');
    let session;
    try {
      if(window.location.protocol!=='https:') {
        const config=await httpRequest('/api/v1/auth/config');
        if(config.allowInsecureHttp!==true)throw new RequestError('伺服器尚未允許 HTTP 登入，請使用 HTTPS 或請管理者設定區網測試模式。');
      }
      const password=$('#password').value;$('#password').value='';
      session=await httpRequest('/api/v1/sessions',{method:'POST',body:{loginName,password}});
      if(!session?.user?.id || !session.token)throw new RequestError('登入回應缺少員工身分。');
      if(journal.pending)assertBinding(journal.pending,{userId:session.user.id,deviceId});
      state.token=session.token;state.user=session.user;state.deviceId=deviceId;state.deviceKey=deviceKey;
      await contextRefresh();
      $('#access').hidden=true;$('#workplace').hidden=false;$('#logout').hidden=false;
      buildWorkspace();
      try {await refreshLists();}catch(error){if(error.status===401)throw error;say(error.message,true);return;}
      say(journal.pending?'已登入，請先確認原操作結果。':'已連接門市設備，請先確認班次與責任人。');
    } catch(error) {
      if(session?.token) {try{await httpRequest('/api/v1/sessions/current',{method:'DELETE',token:session.token});}catch{}}
      state.token='';state.user=null;state.context=null;state.fresh=false;state.deviceKey='';$('#workplace').hidden=true;$('#access').hidden=false;$('#logout').hidden=true;throw error;
    } finally {$('#password').value='';$('#device-key').value='';}
  });});
  $('#logout').addEventListener('click',()=>perform(async()=>{
    const token=state.token;state.token='';state.context=null;state.fresh=false;state.verification=null;state.deviceKey='';state.user=null;state.lists={};state.selected={};state.result=null;
    $('#panels').replaceChildren();state.forms=[];state.pickers=[];$('#access').hidden=false;$('#workplace').hidden=true;$('#logout').hidden=true;$('#identity').textContent='已登出';$('#password').value='';$('#device-key').value='';
    try{await httpRequest('/api/v1/sessions/current',{method:'DELETE',token});say(journal.pending?'已登出，原操作待確認紀錄仍保留，請使用原帳號及設備接續。':'已登出。');}catch{say('本頁已登出；伺服器登出未能確認，登入憑證會於到期後失效。',true);}
  }));
  $('#refresh').addEventListener('click',()=>perform(async()=>{state.verification=null;await contextRefresh();buildWorkspace();if(state.result)resultView(state.result);await refreshLists();say('門市狀態與紀錄已更新。');}));
  $('#query-pending').addEventListener('click',()=>perform(async()=>{const result=await journal.query(identity());await afterSuccess(result);}));
  $('#retry-pending').addEventListener('click',()=>perform(async()=>{const result=await journal.retry(identity());await afterSuccess(result);}));
  $('#recover-secret').addEventListener('submit',event=>{
    event.preventDefault(); const secret=$('#recovery-secret').value; $('#recovery-secret').value='';
    void perform(async()=>{
      const pending=journal.pending; if(!pending)throw new RequestError('沒有待確認原操作。');
      assertBinding(pending,identity());
      try { const committed=await journal.query(identity()); await afterSuccess(committed); return; } catch(error) { if(error.status!==404)throw error; }
      const body={...pending.body};
      if(pending.command==='chargeWallet') {
        const wallet=await api(`/api/v1/pos/wallets/${body.walletId}`);
        const response=await api('/api/v1/pos/commands/verifyMember',{method:'POST',key:newUUID(),body:{memberId:wallet.member_id,pin:secret,purpose:'payment',paymentRequestId:body.id}});
        if(!response.result?.verified || !response.result.verificationToken)throw new RequestError(response.result?.message || '會員驗證失敗。');
        body.verificationToken=response.result.verificationToken;
      } else if(pending.command==='createMember') body.pin=secret;
      else if(pending.command==='setBank') body.currentPassword=secret;
      else throw new RequestError('此操作不允許自動補回驗證資料。');
      await afterSuccess(await journal.resumeSecret(body,identity()));
    });
  });
  window.addEventListener('offline',()=>say('目前離線，無法確認交易結果。請恢復連線後查詢原操作，勿另行收款。',true));
  updateControls();return {state,journal};
}
if(typeof document!=='undefined' && typeof window!=='undefined')mountOperations(document,window);
