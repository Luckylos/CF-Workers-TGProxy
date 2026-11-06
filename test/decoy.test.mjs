// DECOY 伪装站：未签名的 / 和未知路径透传到伪装站，其他行为不变
import test from 'node:test';
import assert from 'node:assert/strict';
import { W } from './load.mjs';

const ENV = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'boot-secret-for-tests-0123456789' };
const D = 'https://decoy.example';

const withFetch = async (impl, fn) => {
  const orig = globalThis.fetch, calls = [];
  globalThis.fetch = async (u, o) => { calls.push({ u: String(u), o }); return impl(u, o); };
  try { await fn(calls); } finally { globalThis.fetch = orig; }
};
const req = (path, init = {}) => new Request('https://tg.example.com' + path, init);

test('parseDecoy 经 mkCfg：只接受 http(s) origin', () => {
  assert.equal(W.mkCfg(ENV).decoy, null);
  assert.equal(W.mkCfg({ ...ENV, DECOY: ' https://nginx.org/ # 备注' }).decoy, 'https://nginx.org');
  for (const bad of ['ftp://x.org', 'https://x.org/sub', 'https://u:p@x.org', 'https://x.org/?a=1', 'nope']) assert.throws(() => W.mkCfg({ ...ENV, DECOY: bad }), bad);
});

test('DECOY 非法时 /health 返回 500', async () => {
  const r = await W.route(req('/health'), { ...ENV, DECOY: 'ftp://x' }); assert.equal(r.status, 500);
});

test('未签名的 / 与未知路径透传到伪装站，只带白名单头', async () => {
  await withFetch(async () => new Response('<h1>decoy</h1>', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'a=1', 'server': 'nginx', 'content-encoding': 'gzip' } }), async calls => {
    const r = await W.route(req('/', { headers: { 'user-agent': 'UA', cookie: 'c=1', 'cf-connecting-ip': '1.2.3.4', 'accept-language': 'zh' } }), { ...ENV, DECOY: D });
    assert.equal(r.status, 200); assert.equal(await r.text(), '<h1>decoy</h1>');
    assert.equal(r.headers.get('content-type'), 'text/html');
    for (const k of ['set-cookie', 'server', 'content-encoding']) assert.equal(r.headers.get(k), null, k);
    assert.equal(calls[0].u, D + '/'); assert.equal(calls[0].o.redirect, 'manual');
    const sent = Object.fromEntries(calls[0].o.headers);
    assert.deepEqual(sent, { 'user-agent': 'UA', 'accept-language': 'zh' });

    const r2 = await W.route(req('/en/download.html?x=1'), { ...ENV, DECOY: D });
    assert.equal(r2.status, 200); assert.equal(calls[1].u, D + '/en/download.html?x=1');
  });
});

test('伪装站同源跳转改为相对路径，外站跳转原样', async () => {
  let loc = D + '/en/';
  await withFetch(async () => new Response(null, { status: 301, headers: { location: loc } }), async () => {
    let r = await W.route(req('/en'), { ...ENV, DECOY: D }); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/en/');
    loc = 'https://other.example/x'; r = await W.route(req('/en'), { ...ENV, DECOY: D }); assert.equal(r.headers.get('location'), loc);
  });
});

test('非 GET/HEAD、上游失败返回 404；未配置 DECOY 行为不变', async () => {
  await withFetch(async () => { throw Error('down'); }, async calls => {
    let r = await W.route(req('/x', { method: 'POST', body: 'a' }), { ...ENV, DECOY: D }); assert.equal(r.status, 404); assert.equal(calls.length, 0);
    r = await W.route(req('/x'), { ...ENV, DECOY: D }); assert.equal(r.status, 404); assert.equal(calls.length, 1);
    r = await W.route(req('/'), ENV); assert.equal(r.status, 200); assert.match(await r.text(), /<title>Connection<\/title>/);
    r = await W.route(req('/x'), ENV); assert.equal(r.status, 404);
    assert.equal(calls.length, 1);
  });
});

test('配置 DECOY 后 /health 与 API 不走伪装站', async () => {
  await withFetch(async () => new Response('decoy'), async calls => {
    const env = { ...ENV, DECOY: D };
    assert.equal((await W.route(req('/health'), env)).status, 200);
    assert.equal((await W.route(req('/api/v1/session', { method: 'POST' }), env)).status, 404);
    assert.equal((await W.route(req('/api/v1/ws'), env)).status, 404);
    assert.equal(calls.length, 0);
  });
});
