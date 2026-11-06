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
    window: { isSecureContext: secure, addEventListener() {} }, confirm: () => true, crypto: globalThis.crypto, structuredClone,
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

test('後台設定、取消及移除預設選項，並將設定送出儲存', async () => {
  const env = setup(); await signIn(env);
  const group = { id: 'ice', nameZh: '冰量', nameVi: 'Đá', minSelect: 1, maxSelect: 1, values: [
    { id: 'less', nameZh: '少冰', nameVi: 'Ít đá' }, { id: 'normal', nameZh: '正常冰', nameVi: 'Đá' }
  ] };
  env.state.catalog.products.push({ id: 'p', categoryId: 'tea', nameZh: '茶', nameVi: 'Tra', variants: [], toppings: [], optionGroups: [group] });
  const input = (k, checked) => env.get('#editor').listeners.input({ target: { dataset: { default: `0.0.${k}` }, checked } });
  input(0, true); input(1, true); input(0, false);
  assert.deepEqual(Array.from(group.defaultValueIds), ['normal']);
  assert.equal(env.state.dirty, true);
  const save = env.click('#save');
  const sent = JSON.parse(env.calls.at(-1).body);
  assert.deepEqual(sent.catalog.products[0].optionGroups[0].defaultValueIds, ['normal']);
  env.pending.shift()(response({ revision: '8', catalog: env.state.catalog })); await save;
  assert.match(env.get('#product-list').innerHTML, /data-default="0\.0\.1" checked/);
  env.get('#editor').listeners.click({ target: { closest: () => ({ dataset: { action: 'remove-option', i: '0', j: '0', k: '1' } }) } });
  assert.deepEqual(Array.from(group.defaultValueIds), []);
  assert.equal(group.values.length, 1);
});

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


test('後台編輯供應狀態與明確群組類型，糖冰上限固定為一項', async () => {
  const env = setup(); await signIn(env);
  const act = dataset => env.get('#editor').listeners.click({ target: { closest: () => ({ dataset }) } });
  const input = (bind, value, checked) => env.get('#editor').listeners.input({ target: { dataset: { bind }, value, checked } });
  act({ action: 'add-product' }); act({ action: 'add-topping', i: '0' }); act({ action: 'add-group', i: '0' });
  const product = env.state.catalog.products[0];
  assert.match(env.get('#product-list').innerHTML, /data-bind="p\.0\.active" checked/);
  input('p.0.active', '', false); input('v.0.0.soldOut', '', true); input('t.0.0.active', '', false);
  assert.equal(product.active, false); assert.equal(product.variants[0].soldOut, true); assert.equal(product.toppings[0].active, false);
  input('g.0.0.kind', 'sugar'); input('g.0.0.maxSelect', '9');
  assert.equal(product.optionGroups[0].kind, 'sugar'); assert.equal(product.optionGroups[0].maxSelect, 1);
  assert.match(env.get('#product-list').innerHTML, /value="sugar" selected/);
  assert.match(env.get('#product-list').innerHTML, /max="1"[^>]*data-bind="g\.0\.0\.maxSelect"/);
  input('g.0.0.kind', 'general'); input('g.0.0.maxSelect', '2');
  assert.equal(product.optionGroups[0].maxSelect, 2);
});

test('後台共用群組套用、排除、獨立覆寫與恢復繼承，不破壞原範本', async () => {
  const env = setup(); await signIn(env);
  const act = dataset => env.get('#editor').listeners.click({ target: { closest: () => ({ dataset }) } });
  const input = (dataset, checked, value) => env.get('#editor').listeners.input({ target: { dataset, checked, value } });
  act({ action: 'add-template' }); act({ action: 'add-product' });
  const group = env.state.catalog.optionGroups[0]; const product = env.state.catalog.products[0];
  input({ bind: 'r.0.nameZh' }, undefined, '共用冰量'); input({ bind: 'r.0.kind' }, undefined, 'ice');
  act({ action: 'add-option', template: '0' });
  input({ templateDefault: '0.1' }, true);
  assert.deepEqual(Array.from(group.defaultValueIds), [group.values[1].id]);
  input({ categoryGroup: `0.${group.id}` }, true);
  assert.deepEqual(Array.from(env.state.catalog.categories[0].optionGroupIds), [group.id]);
  assert.match(env.get('#product-list').innerHTML, /繼承分類/);
  input({ exclude: `0.${group.id}` }, true);
  assert.deepEqual(Array.from(product.excludedOptionGroupIds), [group.id]);
  act({ action: 'override-group', i: '0', group: group.id });
  assert.equal(product.optionGroups[0].id, group.id);
  assert.notEqual(product.optionGroups[0], group); assert.notEqual(product.optionGroups[0].values, group.values);
  assert.deepEqual(Array.from(product.excludedOptionGroupIds), []);
  input({ bind: 'g.0.0.nameZh' }, undefined, '獨立冰量');
  assert.equal(group.nameZh, '共用冰量');
  assert.match(env.get('#product-list').innerHTML, /單品已覆寫/);
  act({ action: 'remove-group', template: '0' });
  assert.equal(env.state.catalog.optionGroups.length, 1, '仍被分類套用的範本不能移除');
  assert.match(env.get('#message').textContent, /取消分類套用/);
  act({ action: 'remove-group', i: '0', j: '0' });
  assert.match(env.get('#product-list').innerHTML, /繼承分類/);
  input({ exclude: `0.${group.id}` }, true);
  input({ categoryGroup: `0.${group.id}` }, false);
  assert.deepEqual(Array.from(product.excludedOptionGroupIds), [], '取消分類套用也清除過期排除關係');
  act({ action: 'remove-group', template: '0' });
  assert.equal(env.state.catalog.optionGroups.length, 0);
});
