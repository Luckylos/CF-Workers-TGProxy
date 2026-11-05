// 离线测试：node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { W, tcpOpen } from './load.mjs';

// 假代理：handler(sock, read) 完成握手后回显
const fake = async (handler) => {
  const seen = [];
  const srv = net.createServer(sock => {
    let buf = Buffer.alloc(0), wake = null;
    sock.on('data', d => { buf = Buffer.concat([buf, d]); wake?.(); });
    sock.on('error', () => {});
    const read = async n => { while (buf.length < n) await new Promise(ok => { wake = ok; }); const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };
    const readHead = async () => { for (;;) { const i = buf.indexOf('\r\n\r\n'); if (i >= 0) { const h = buf.subarray(0, i + 4).toString(); buf = buf.subarray(i + 4); return h; } await new Promise(ok => { wake = ok; }); } };
    const echo = () => { if (buf.length) sock.write(buf); buf = Buffer.alloc(0); sock.removeAllListeners('data'); sock.on('data', d => sock.write(d)); };
    handler({ sock, read, readHead, echo, seen }).catch(() => sock.destroy());
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { srv, seen, port: srv.address().port };
};
const socksServer = ({ needAuth, authOk = true }) => fake(async ({ sock, read, echo, seen }) => {
  const [, n] = await read(2); const methods = [...await read(n)]; seen.push({ methods });
  if (needAuth) {
    sock.write(Buffer.from([5, 2]));
    const [, ul] = await read(2); const user = (await read(ul)).toString(); const [pl] = await read(1); const pass = (await read(pl)).toString();
    seen.push({ user, pass });
    if (!authOk) { sock.end(Buffer.from([1, 1])); return; }
    sock.write(Buffer.from([1, 0]));
  } else sock.write(Buffer.from([5, 0]));
  const req = await read(10); seen.push({ ip: [...req.subarray(4, 8)].join('.'), port: req.readUInt16BE(8), cmd: req[1], atyp: req[3] });
  sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xaa])); // 0xaa: 回复后紧跟的隧道数据
  echo();
});
const httpServer = ({ status = 200 }) => fake(async ({ sock, readHead, echo, seen }) => {
  seen.push(await readHead());
  sock.write(`HTTP/1.1 ${status} X\r\nVia: t\r\n\r\n` + (status === 200 ? '\u00bb' : ''));
  if (status === 200) echo(); else sock.end();
});
const roundTrip = async (tcp) => { const rd = tcp.readPack ?? tcp.read; const first = await rd(); await tcp.write(new Uint8Array([1, 2, 3])); const back = await rd(); tcp.close(); return { first: [...first], back: [...back] }; };

test('parseProxy', () => {
  assert.equal(W.parseProxy(''), null);
  assert.equal(W.parseProxy(undefined), null);
  assert.deepEqual(W.parseProxy('socks5://u%40x:p%3A1@h.example:1081'), { kind: 'socks5', host: 'h.example', port: 1081, user: 'u@x', pass: 'p:1', auth: true });
  assert.deepEqual(W.parseProxy('http://h.example'), { kind: 'http', host: 'h.example', port: 80, user: '', pass: '', auth: false });
  assert.equal(W.parseProxy('socks5://[::1]').host, '::1');
  assert.equal(W.parseProxy('socks5://h').port, 1080);
  assert.deepEqual(W.parseProxy('http://u:%21p@h.example:21107#SG'), { kind: 'http', host: 'h.example', port: 21107, user: 'u', pass: '!p', auth: true });
  for (const bad of ['https://h:1', 'socks4://h:1', 'http://h/x', 'http://h?x=1', 'nope']) assert.throws(() => W.parseProxy(bad), bad);
});

test('mkCfg 带 PROXY，非法值抛错', () => {
  const base = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'b' };
  assert.equal(W.mkCfg(base).proxy, null);
  assert.equal(W.mkCfg({ ...base, PROXY: 'http://h:8080' }).proxy.port, 8080);
  assert.throws(() => W.mkCfg({ ...base, PROXY: 'ftp://h' }));
});

test('dcAddr 映射 DC1-5', () => {
  assert.deepEqual(W.dcAddr(4), { host: '149.154.171.5', port: 443 });
  assert.equal(W.dcAddr(0).host, '149.154.175.50');
  assert.throws(() => W.dcAddr(5));
});

test('SOCKS5 无认证 + 剩余数据 + 双向转发', async () => {
  const s = await socksServer({ needAuth: false });
  const tcp = await W.dialProxy({ proxy: W.parseProxy(`socks5://127.0.0.1:${s.port}`), target: 1 });
  assert.deepEqual(await roundTrip(tcp), { first: [0xaa], back: [1, 2, 3] });
  assert.deepEqual(s.seen.slice(0, 2), [{ methods: [0] }, { ip: '149.154.167.51', port: 443, cmd: 1, atyp: 1 }]);
  s.srv.close();
});

test('SOCKS5 用户名密码认证', async () => {
  const s = await socksServer({ needAuth: true });
  const tcp = await W.dial({ proxy: W.parseProxy(`socks5://alice:s3cr%40t@127.0.0.1:${s.port}`), target: 4, media: true });
  assert.deepEqual(await roundTrip(tcp), { first: [0xaa], back: [1, 2, 3] });
  assert.deepEqual(s.seen, [{ methods: [0, 2] }, { user: 'alice', pass: 's3cr@t' }, { ip: '149.154.171.5', port: 443, cmd: 1, atyp: 1 }]);
  s.srv.close();
});

test('SOCKS5 认证失败时拒绝', async () => {
  const s = await socksServer({ needAuth: true, authOk: false });
  await assert.rejects(W.dialProxy({ proxy: W.parseProxy(`socks5://a:b@127.0.0.1:${s.port}`), target: 0 }));
  s.srv.close();
});

test('SOCKS5 服务器要求认证但未配置凭据时拒绝', async () => {
  const s = await socksServer({ needAuth: true });
  await assert.rejects(W.dialProxy({ proxy: W.parseProxy(`socks5://127.0.0.1:${s.port}`), target: 0 }));
  s.srv.close();
});

test('HTTP CONNECT + Basic 认证 + 剩余数据', async () => {
  const s = await httpServer({});
  const tcp = await W.dialProxy({ proxy: W.parseProxy(`http://bob:pw@127.0.0.1:${s.port}`), target: 2 });
  assert.deepEqual(await roundTrip(tcp), { first: [0xc2, 0xbb], back: [1, 2, 3] });
  const head = s.seen[0];
  assert.match(head, /^CONNECT 149\.154\.175\.100:443 HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: 149\.154\.175\.100:443\r\n/);
  assert.ok(head.includes(`Proxy-Authorization: Basic ${Buffer.from('bob:pw').toString('base64')}\r\n`));
  s.srv.close();
});

test('HTTP CONNECT 非 2xx（407）时拒绝', async () => {
  const s = await httpServer({ status: 407 });
  await assert.rejects(W.dialProxy({ proxy: W.parseProxy(`http://127.0.0.1:${s.port}`), target: 0 }));
  s.srv.close();
});

test('代理不响应时超时', async () => {
  const s = await fake(async () => {});
  const t0 = Date.now();
  await assert.rejects(W.dialProxy({ proxy: W.parseProxy(`socks5://127.0.0.1:${s.port}`), target: 0, ms: 200 }));
  assert.ok(Date.now() - t0 < 2000);
  s.srv.close();
});

test('代理连接不上时拒绝', async () => {
  const s = await fake(async () => {}); const port = s.port; await new Promise(ok => s.srv.close(ok));
  await assert.rejects(W.dialProxy({ proxy: W.parseProxy(`socks5://127.0.0.1:${port}`), target: 0 }));
});

test('signal 取消握手', async () => {
  const s = await fake(async () => {});
  const ac = new AbortController();
  const p = W.dialProxy({ proxy: W.parseProxy(`http://127.0.0.1:${s.port}`), target: 0, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p);
  s.srv.close();
});

// 握手后读 128KB：校验数据完整；握手时多读到的剩余数据（第一块）大小不定，之后每次 read() 不超过 CFG.dnPack
const bulk = async (open) => {
  const data = Buffer.alloc(128 * 1024); for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
  const s = await fake(async ({ sock, readHead }) => { await readHead(); sock.write('HTTP/1.1 200 OK\r\n\r\n'); sock.write(data); sock.end(); });
  const tcp = await W.dialProxy({ proxy: W.parseProxy(`http://127.0.0.1:${s.port}`), target: 2, ...(open ? { open } : {}) });
  const parts = []; for (let b; (b = await tcp.read());) parts.push(Buffer.from(b));
  s.srv.close();
  return { tcp, parts, ok: Buffer.concat(parts).equals(data) };
};

test('握手后改用 BYOB 读：数据完整，每块不超过 dnPack', async () => {
  const { tcp, parts, ok } = await bulk();
  assert.equal(tcp.mode, 'byob');
  assert.ok(ok);
  assert.ok(parts.slice(1).every(p => p.byteLength <= W.CFG.dnPack));
});

test('socket 不是字节流时回退到默认 reader', async () => {
  const { tcp, ok } = await bulk(addr => tcpOpen(addr, { bytes: false }));
  assert.equal(tcp.mode, 'default');
  assert.ok(ok);
});

