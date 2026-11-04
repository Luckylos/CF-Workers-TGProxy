// 回归测试：下行合包、mkHead 排除规则、lease 上限、session token 刷新
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { W } from './load.mjs';

const ENV = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'test-boot-0123456789' };
const HELLO = new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 1, 1]);
const kb = (n, v = 1) => new Uint8Array(n * 1024).fill(v);
const src = (items, delays = []) => { let i = 0, inFlight = 0, maxInFlight = 0; const read = () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); const k = i++, it = items[k];
  const done = (ok, bad) => { inFlight--; it instanceof Error ? bad(it) : ok(it ?? null); }; return new Promise((ok, bad) => delays[k] ? setTimeout(() => done(ok, bad), delays[k]) : queueMicrotask(() => done(ok, bad))); }; return { read, get max() { return maxInFlight; } }; };

test('mkPack：快速到达的小块合并到 dnPack，EOF 前先交出已合并数据', async () => {
  const s = src([...Array.from({ length: 40 }, () => kb(1)), null]);
  const rd = W.mkPack(s.read);
  // 放宽合包窗口，避免机器负载导致 1ms 窗口提前结束（窗口语义由下一个用例覆盖）
  const dnMs = W.CFG.dnMs; W.CFG.dnMs = 200;
  const sizes = []; try { for (let b; (b = await rd());) sizes.push(b.byteLength); } finally { W.CFG.dnMs = dnMs; }
  assert.deepEqual(sizes, [32 * 1024, 8 * 1024]);
  assert.equal(s.max, 1, '同一时刻只允许一个未完成的 read()');
});

test('mkPack：超出 dnPack 的块留到下一次，大块原样返回', async () => {
  const rd = W.mkPack(src([kb(20, 1), kb(20, 2), kb(40, 3), null]).read);
  const a = await rd(), b = await rd(), c = await rd();
  assert.deepEqual([a.byteLength, a[0], b.byteLength, b[0], c.byteLength, c[0]], [20480, 1, 20480, 2, 40960, 3]);
  assert.equal(await rd(), null);
});

test('mkPack：超过 dnMs 的块不等待，下一次读取复用同一个未完成的 read()', async () => {
  const s = src([kb(1, 1), kb(1, 2), null], [0, 40, 0]);
  const rd = W.mkPack(s.read);
  const a = await rd(); assert.deepEqual([a.byteLength, a[0]], [1024, 1]);
  const b = await rd(); assert.deepEqual([b.byteLength, b[0]], [1024, 2]);
  assert.equal(await rd(), null);
  assert.equal(s.max, 1);
});

test('mkPack：读取出错时先交出已合并数据，下一次再抛错', async () => {
  const rd = W.mkPack(src([kb(1), kb(1), Error('boom')]).read);
  assert.equal((await rd()).byteLength, 2048);
  await assert.rejects(rd(), /boom/);
});

test('mkHead：排除 ef 首字节、HEAD/POST/GET/OPTI、eeeeeeee/dddddddd、TLS 头、[4..8] 全零', () => {
  const bad = [[0xef], [...'HEAD'].map(c => c.charCodeAt(0)), [...'GET '].map(c => c.charCodeAt(0)), [0xee, 0xee, 0xee, 0xee], [0xdd, 0xdd, 0xdd, 0xdd], [0x16, 0x03, 0x01, 0x02], [1, 2, 3, 4, 0, 0, 0, 0]];
  const good = [0x42, 0x42, 0x42, 0x42, 1, 1, 1, 1];
  const seq = [...bad, good]; let calls = 0;
  const orig = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = (b) => { b.fill(7); b.set(seq[calls++]); return b; };
  try { const h = W.mkHead(0xee, 3, true); assert.equal(calls, seq.length); assert.deepEqual([...h.subarray(0, 8)], good); assert.deepEqual(W.headOf(h), { mode: 0xee, target: 3, media: true }); }
  finally { globalThis.crypto.getRandomValues = orig; }
});

const call = (method, path, token, body) => W.route(new Request('https://h.example' + path, { method, body, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/octet-stream' }) } }), ENV);

test('session：仍有效的 session token 可以换新 token；伪造 token 不行', async () => {
  const boot = await W.mkBoot(ENV.BOOT), sess = await W.mkSess(ENV.BOOT);
  const r1 = await call('POST', '/api/v1/session', boot, HELLO);
  assert.equal(r1.status, 200); assert.ok(r1.headers.get('x-session-token'));
  const r2 = await call('POST', '/api/v1/session', sess, HELLO);
  assert.equal(r2.status, 200); const next = r2.headers.get('x-session-token'); assert.ok(next && next !== sess);
  assert.equal((await call('POST', '/api/v1/session', next, HELLO)).status, 200);
  assert.equal((await call('POST', '/api/v1/session', 'A'.repeat(43), HELLO)).status, 404);
});

test('lease：DELETE 与 ws 共用 4096 上限，已有 lease 仍可删除', async () => {
  const first = await W.mkSess(ENV.BOOT);
  assert.equal((await call('DELETE', '/api/v1/session', first)).status, 204);
  for (let i = 1; i < 4096; i++) assert.equal((await call('DELETE', '/api/v1/session', await W.mkSess(ENV.BOOT))).status, 204);
  assert.equal((await call('DELETE', '/api/v1/session', await W.mkSess(ENV.BOOT))).status, 503);
  assert.equal((await call('DELETE', '/api/v1/session', first)).status, 204);
});

// 在 vm 里运行桥接页面脚本（走 Android 桥），用假 fetch / WebSocket / 定时器观察 token 刷新
async function runPage({ respond }) {
  const { body } = W.mkPage('h.example', 'BOOTSTRAP');
  const code = [...body.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(m => m[1]).find(c => c.includes('tproxy-init'));
  const timers = new Map(); let tid = 0; const fetches = [], sockets = [], toAndroid = [];
  class WS { static OPEN = 1; constructor(url, proto) { this.url = url; this.proto = proto; this.readyState = 0; sockets.push(this); } send() {} close() {} }
  const android = { onmessage: null, postMessage: v => toAndroid.push(v) };
  const ctx = vm.createContext({ location: { hash: '#android=' + 'A'.repeat(43), pathname: '/' }, history: { replaceState() {} }, addEventListener() {}, parent: {}, TelegramWebProxy: android, WebSocket: WS, URL, Response,
    setTimeout: (f, ms) => { timers.set(++tid, { f, ms }); return tid; }, clearTimeout: id => timers.delete(id), queueMicrotask,
    fetch: async (url, o) => { fetches.push({ url, method: o.method, auth: o.headers.Authorization, len: o.body?.byteLength }); const r = respond(fetches.length, o);
      // 响应体要用页面所在 realm 的 ArrayBuffer，否则页面里的 instanceof ArrayBuffer 不成立
      return { status: r.status, headers: { get: k => r.headers?.[k] ?? null }, arrayBuffer: async () => ab(r.body ?? []) }; } });
  ctx.globalThis = ctx;
  const ab = bytes => { const b = vm.runInContext('new ArrayBuffer(' + bytes.length + ')', ctx); new Uint8Array(b).set(bytes); return b; };
  const flush = () => new Promise(r => setImmediate(r));
  const fire = async ms => { const e = [...timers].find(([, t]) => t.ms === ms); assert.ok(e, '没有 ' + ms + 'ms 的定时器'); timers.delete(e[0]); await e[1].f(); await flush(); };
  vm.runInContext(code, ctx);
  return { android, ab, flush, fire, timers, fetches, sockets };
}
const ok = (tok) => ({ status: 200, body: [0x11, 0, 0, 0, 0, 0, 0, 0], headers: { 'X-Carrier-Mode': 'websocket-lanes', 'X-Session-Token': tok } });

test('桥接页面：连上后 3 分钟用当前 session token 刷新，新 lane 用新 token', async () => {
  const p = await runPage({ respond: n => ok('T' + n) });
  p.android.onmessage({ data: p.ab([...HELLO]) }); await p.flush(); await p.flush();
  assert.deepEqual(p.fetches[0], { url: 'https://h.example/api/v1/session', method: 'POST', auth: 'Bearer BOOTSTRAP', len: 9 });
  await p.fire(180000);
  assert.deepEqual(p.fetches[1], { url: 'https://h.example/api/v1/session', method: 'POST', auth: 'Bearer T1', len: 9 });
  await p.fire(180000);
  assert.equal(p.fetches[2].auth, 'Bearer T2');
  p.android.onmessage({ data: p.ab([1, 0, 0, 5, 0, 0, 0, 0]) }); await p.flush();
  assert.equal(p.sockets.at(-1).proto, 'tproxy-lane-v1.T3.5');
});

test('桥接页面：刷新失败时 15 秒后重试，不断开页面；关闭后不再刷新', async () => {
  const p = await runPage({ respond: n => n === 2 ? { status: 404 } : ok('T' + n) });
  p.android.onmessage({ data: p.ab([...HELLO]) }); await p.flush(); await p.flush();
  await p.fire(180000);
  assert.equal(p.fetches.length, 2);
  await p.fire(15000);
  assert.equal(p.fetches[2].auth, 'Bearer T1', '失败后仍用旧 token 重试');
  p.android.onmessage({ data: JSON.stringify({ t: 'close' }) }); await p.flush();
  assert.equal([...p.timers.values()].filter(t => t.ms === 180000 || t.ms === 15000).length, 0);
});
