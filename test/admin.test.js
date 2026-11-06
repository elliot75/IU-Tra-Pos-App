import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => status < 400 ? { data } : { error: { message: 'expired' } } });
const session = (id = 'manager') => ({ token: `${id}-token`, user: { id, loginName: id, displayName: id, canManageCatalog: true } });
const draft = () => ({ revision: '7', catalog: { categories: [{ id: 'tea', nameZh: '茶', nameVi: 'Tra' }], products: [] } });
function setup(secure = true) {
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, { value: '', hidden: false, listeners: {}, classList: { toggle() {} }, addEventListener(type, handler) { this.listeners[type] = handler; } });
    return elements.get(key);
  };
  const calls = []; const pending = [];
  const context = vm.createContext({
    document: { querySelector: get, querySelectorAll: () => ['#login-name', '#password', '#login-submit', '#logout'].map(get) },
    window: { isSecureContext: secure, addEventListener() {} }, confirm: () => true,
    fetch: (path, options) => { calls.push({ path, ...options }); return new Promise(resolve => pending.push(resolve)); }
  });
  vm.runInContext(`${source}\nglobalThis.testing = { state, dirty };`, context);
  return { get, calls, pending, state: context.testing.state, dirty: context.testing.dirty,
    click: selector => get(selector).listeners.click(),
    login: () => get('#access-form').listeners.submit({ preventDefault() {} }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function signIn(env) {
  env.get('#login-name').value = 'manager';
  const task = env.login(); env.pending.shift()(response(session())); await tick();
  env.pending.shift()(response(draft())); await task;
}

test('區網 HTTP 經伺服器允許後可登入，未啟用時不傳送密碼', async () => {
  for (const allowed of [false, true]) {
    const env = setup(false); const task = env.login();
    assert.equal(env.calls[0].path, '/api/v1/auth/config');
    assert.equal(env.calls[0].body, undefined);
    env.pending.shift()(response({ allowInsecureHttp: allowed })); await tick();
    if (allowed) {
      assert.equal(env.calls[1].path, '/api/v1/sessions');
      env.pending.shift()(response(session())); await tick();
      env.pending.shift()(response(draft()));
    }
    await task;
    assert.equal(Boolean(env.state.token), allowed);
    assert.equal(env.calls.length, allowed ? 3 : 1);
  }
});

test('儲存時停用衝突操作，登出後晚到回應不能恢復資料或解鎖新操作', async () => {
  const env = setup(); await signIn(env);
  env.dirty(); const save = env.click('#save');
  assert.equal(env.get('#logout').disabled, true);
  assert.equal(env.get('#editor').inert, true);
  await env.click('#save'); assert.equal(env.pending.length, 1);
  // Invoke directly to simulate a logout already queued before controls disabled.
  const logout = env.click('#logout');
  assert.equal(env.state.catalog, null); assert.equal(env.get('#editor').hidden, true);
  env.pending.shift()(response(draft())); await save;
  assert.equal(env.state.catalog, null); assert.equal(env.state.busy, true);
  env.pending.shift()(response({ loggedOut: true })); await logout;
  assert.equal(env.state.token, ''); assert.equal(env.get('#editor').hidden, true);
});

test('401 保留未儲存草稿，同帳號重新登入不重載且使用原 revision 重試', async () => {
  const env = setup(); await signIn(env);
  env.state.catalog.categories[0].nameZh = '未儲存'; env.dirty();
  const original = env.state.catalog; const save = env.click('#save');
  env.pending.shift()(response(null, 401)); await save;
  assert.equal(env.state.catalog, original); assert.equal(env.state.dirty, true);
  assert.equal(env.get('#login-submit').hidden, false); assert.equal(env.get('#editor').hidden, true);
  assert.equal(env.state.busy, false); assert.equal(env.get('#login-name').readOnly, true);
  const count = env.calls.length; const login = env.login();
  env.pending.shift()(response(session())); await login;
  assert.equal(env.calls.length, count + 1); assert.equal(env.state.catalog, original);
  assert.equal(env.state.dirty, true); assert.equal(env.get('#editor').hidden, false);
  const retry = env.click('#save'); const sent = JSON.parse(env.calls.at(-1).body);
  assert.equal(sent.expectedRevision, '7'); assert.equal(sent.catalog.categories[0].nameZh, '未儲存');
  env.pending.shift()(response({ revision: '8', catalog: sent.catalog })); await retry;
  assert.equal(env.state.revision, '8'); assert.equal(env.state.dirty, false);
});

test('重新登入失敗或身份不符不會遺失草稿，也不會授予草稿存取', async () => {
  const env = setup(); await signIn(env); env.dirty(); const original = env.state.catalog;
  const save = env.click('#save'); env.pending.shift()(response(null, 401)); await save;
  const failed = env.login(); env.pending.shift()(response(null, 401)); await failed;
  assert.equal(env.state.catalog, original); assert.equal(env.state.dirty, true);
  const mismatch = env.login(); env.pending.shift()(response(session('other'))); await tick();
  assert.equal(env.calls.at(-1).method, 'DELETE');
  assert.equal(env.calls.at(-1).headers.authorization, 'Bearer other-token');
  env.pending.shift()(response({ loggedOut: true })); await mismatch;
  assert.equal(env.state.token, ''); assert.equal(env.state.catalog, original);
  assert.equal(env.get('#editor').hidden, true); assert.equal(env.state.busy, false);
});

test('發布過期可重新登入，晚到發布回應不能覆蓋登出訊息', async () => {
  const env = setup(); await signIn(env);
  const publish = env.click('#publish'); env.pending.shift()(response(null, 401)); await publish;
  assert.equal(env.get('#login-submit').hidden, false); assert.equal(env.state.revision, '7');
  const login = env.login(); env.pending.shift()(response(session())); await login;
  const late = env.click('#publish'); const logout = env.click('#logout');
  const finishPublish = env.pending.shift(); env.pending.shift()(response({ loggedOut: true })); await logout;
  const message = env.get('#message').textContent; finishPublish(response({})); await late;
  assert.equal(env.get('#message').textContent, message); assert.equal(env.state.catalog, null);
});
