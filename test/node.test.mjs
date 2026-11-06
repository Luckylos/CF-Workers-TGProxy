// Node 中继（node/server.mjs）端到端：HTTP、WebSocket 握手与帧、PROXY=direct 直连假 DC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { start } from '../node/server.mjs';
import { W } from './load.mjs';
import { tcpOpen } from '../node/sockets.mjs';

const ENV = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'test-boot-0123456789', PROXY: 'direct' };
const SECRET = Buffer.from(ENV.SECRET, 'hex');

// 假 DC：obfuscated2 的 DC 侧。收满 64 字节头后解出 Worker 发来的明文；连上后先发 PACKETS（abridged，每包 400 字节）
const PKT = n => { const b = crypto.randomBytes(n + 1); b[0] = n / 4; return b; };
const PACKETS = Buffer.concat([PKT(400), PKT(400), PKT(400)]);
const fakeDc = async () => {
  const st = { got: 0, conns: 0, tag: null, plain: Buffer.alloc(0) };
  const srv = net.createServer(s => {
    st.conns++; s.on('error', () => {}); let buf = Buffer.alloc(0), dec = null;
    s.on('data', d => {
      st.got += d.length;
      if (dec) { st.plain = Buffer.concat([st.plain, dec.update(d)]); return; }
      buf = Buffer.concat([buf, d]); if (buf.length < 64) return;
      const head = buf.subarray(0, 64), rev = Buffer.from(head.subarray(8, 56)).reverse();
      dec = crypto.createDecipheriv('aes-256-ctr', head.subarray(8, 40), head.subarray(40, 56));
      st.tag = dec.update(head).subarray(56, 60).toString('hex');
      st.plain = dec.update(buf.subarray(64));
      s.write(crypto.createCipheriv('aes-256-ctr', rev.subarray(0, 32), rev.subarray(32, 48)).update(PACKETS));
    });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { srv, st, port: srv.address().port };
};
// 客户端 obfuscated2 头：ef 模式、DC2
const clientHead = () => { for (;;) { const head = crypto.randomBytes(64); if (head[0] === 0xef || head.subarray(4, 8).every(v => v === 0)) continue;
  const key = crypto.createHash('sha256').update(Buffer.concat([head.subarray(8, 40), SECRET])).digest();
  const ks = crypto.createCipheriv('aes-256-ctr', key, head.subarray(40, 56)).update(Buffer.alloc(64));
  const plain = Buffer.alloc(8); plain.fill(0xef, 0, 4); plain.writeInt16LE(2, 4); for (let i = 0; i < 6; i++) head[56 + i] = plain[i] ^ ks[56 + i]; return head; } };
// 客户端两个方向的密钥：上行 sha256(head[8..40]+secret)，下行用反转后的 head[8..56]
const clientCiphers = head => { const rev = Buffer.from(head.subarray(8, 56)).reverse();
  const up = crypto.createCipheriv('aes-256-ctr', crypto.createHash('sha256').update(Buffer.concat([head.subarray(8, 40), SECRET])).digest(), head.subarray(40, 56)); up.update(Buffer.alloc(64));
  const dn = crypto.createDecipheriv('aes-256-ctr', crypto.createHash('sha256').update(Buffer.concat([rev.subarray(0, 32), SECRET])).digest(), rev.subarray(32, 48));
  return { up, dn }; };
const frame = (sid, type, body = Buffer.alloc(0)) => { const f = Buffer.alloc(8 + body.length); f[0] = type; f.writeUIntBE(sid, 1, 3); f.writeUInt32BE(body.length, 4); body.copy(f, 8); return f; };

test('parseProxy("direct") 与 dialProxy 直连 DC 地址', async () => {
  assert.deepEqual(W.parseProxy('direct'), { kind: 'direct' });
  assert.equal(W.mkCfg({ ...ENV }).proxy.kind, 'direct');
  const dc = { srv: net.createServer(s => { s.on('error', () => {}); s.pipe(s); }) }; await new Promise(ok => dc.srv.listen(0, '127.0.0.1', ok)); dc.port = dc.srv.address().port; let asked;
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
    const head = clientHead(), { up, dn } = clientCiphers(head), upPkt = PKT(400);
    let down = Buffer.alloc(0); const gotDown = new Promise(ok => { ws.onmessage = e => { const b = Buffer.from(e.data); if (b[0] === 2) { down = Buffer.concat([down, dn.update(b.subarray(8))]); if (down.length >= PACKETS.length) ok(); } }; });
    ws.send(frame(sid, 1));
    ws.send(frame(sid, 2, Buffer.concat([head, up.update(upPkt)])));
    await Promise.race([gotDown, new Promise((_, bad) => setTimeout(() => bad(Error('timeout down=' + down.length + ' dc=' + JSON.stringify({ got: dc.st.got, tag: dc.st.tag }))), 5000))]);
    assert.ok(down.equals(PACKETS), 'DC 下发的明文原样到达客户端');
    for (let k = 0; k < 50 && dc.st.plain.length < upPkt.length; k++) await new Promise(r => setTimeout(r, 20));
    assert.equal(dc.st.tag, 'efefefef', 'Worker 发给 DC 的头是 abridged');
    assert.ok(dc.st.plain.equals(upPkt), '客户端上行的包原样到达 DC');
    assert.equal(dc.st.conns, 1);
    assert.deepEqual(asked, [{ hostname: W.dcAddr(1).host, port: 443 }]);
    const closed = new Promise(ok => { ws.onclose = e => ok(e.code); }); ws.close(1000); assert.equal(await closed, 1000);
  } finally { await relay.close(); dc.srv.close(); }
});
