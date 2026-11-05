// Node 中继（node/server.mjs）端到端：HTTP、WebSocket 握手与帧、PROXY=direct 直连假 DC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { start } from '../node/server.mjs';
import { W, tcpOpen } from './load.mjs';

const ENV = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'test-boot-0123456789', PROXY: 'direct' };
const SECRET = Buffer.from(ENV.SECRET, 'hex');

// 假 DC：记录收到的字节数并回显
const fakeDc = async () => {
  const st = { got: 0, conns: 0 };
  const srv = net.createServer(s => { st.conns++; s.on('error', () => {}); s.on('data', d => { st.got += d.length; s.write(d); }); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { srv, st, port: srv.address().port };
};
// 客户端 obfuscated2 头：ef 模式、DC2
const clientHead = () => { for (;;) { const head = crypto.randomBytes(64); if (head[0] === 0xef || head.subarray(4, 8).every(v => v === 0)) continue;
  const key = crypto.createHash('sha256').update(Buffer.concat([head.subarray(8, 40), SECRET])).digest();
  const ks = crypto.createCipheriv('aes-256-ctr', key, head.subarray(40, 56)).update(Buffer.alloc(64));
  const plain = Buffer.alloc(8); plain.fill(0xef, 0, 4); plain.writeInt16LE(2, 4); for (let i = 0; i < 6; i++) head[56 + i] = plain[i] ^ ks[56 + i]; return head; } };
const frame = (sid, type, body = Buffer.alloc(0)) => { const f = Buffer.alloc(8 + body.length); f[0] = type; f.writeUIntBE(sid, 1, 3); f.writeUInt32BE(body.length, 4); body.copy(f, 8); return f; };

test('parseProxy("direct") 与 dialProxy 直连 DC 地址', async () => {
  assert.deepEqual(W.parseProxy('direct'), { kind: 'direct' });
  assert.equal(W.mkCfg({ ...ENV }).proxy.kind, 'direct');
  const dc = await fakeDc(); let asked;
  const tcp = await W.dialProxy({ proxy: { kind: 'direct' }, target: 1, open: a => { asked = a; return tcpOpen({ hostname: '127.0.0.1', port: dc.port }); } });
  assert.deepEqual(asked, { hostname: W.dcAddr(1).host, port: 443 });
  await tcp.write(new Uint8Array([9, 8, 7]));
  assert.deepEqual([...await tcp.read()], [9, 8, 7]);
  tcp.close(); dc.srv.close();
});

test('Node 中继：/health、错误握手、完整 lane 经 direct 到假 DC', async () => {
  const dc = await fakeDc(); const asked = [];
  const relay = await start({ port: 0, env: ENV, proto: 'http', connect: a => { asked.push(a); return tcpOpen({ hostname: '127.0.0.1', port: dc.port }); } });
  const base = 'http://127.0.0.1:' + relay.port;
  try {
    const h = await fetch(base + '/health'); assert.equal(h.status, 200); assert.deepEqual(await h.json(), { ok: true });

    // 子协议不对：Worker 拒绝，WebSocket 不建立
    await assert.rejects(new Promise((ok, bad) => { const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws', 'bad'); ws.onopen = ok; ws.onerror = () => bad(Error('rejected')); }));

    const s = await fetch(base + '/api/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + ENV.BOOT, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 1, 1]) });
    assert.equal(s.status, 200); const token = s.headers.get('X-Session-Token'); assert.ok(token);

    const sid = 5, ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/ws', 'tproxy-lane-v1.' + token + '.' + sid);
    ws.binaryType = 'arraybuffer';
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(Error('ws')); });
    assert.equal(ws.protocol, 'tproxy-lane-v1.' + token + '.' + sid);
    // Worker 按 abridged 包边界转发，随机数据的尾部可能留在缓冲里；DC 回显的每个字节都应回到客户端
    let down = 0; const gotDown = new Promise(ok => { ws.onmessage = e => { const b = Buffer.from(e.data); if (b[0] === 2) { down += b.length - 8; if (dc.st.got > 64 && down === dc.st.got) ok(); } }; });
    ws.send(frame(sid, 1));
    ws.send(frame(sid, 2, Buffer.concat([clientHead(), crypto.randomBytes(3000)]))); // 头 64 字节 + 3000 字节数据，分片大于 126 走 16 位长度
    await Promise.race([gotDown, new Promise((_, bad) => setTimeout(() => bad(Error('timeout down=' + down + ' dc=' + JSON.stringify(dc.st) + ' asked=' + JSON.stringify(asked))), 5000))]);
    assert.ok(dc.st.got > 64 && dc.st.got <= 64 + 3000);
    assert.equal(dc.st.conns, 1);
    assert.deepEqual(asked, [{ hostname: W.dcAddr(1).host, port: 443 }]);
    const closed = new Promise(ok => { ws.onclose = e => ok(e.code); }); ws.close(1000); assert.equal(await closed, 1000);
  } finally { await relay.close(); dc.srv.close(); }
});
