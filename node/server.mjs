// Node 中继：在 VPS 上运行 telegram_webproxy.js（第三种部署方式，前面接 Cloudflare Tunnel）
// 用法：SECRET=... BOOT=... [PROXY=direct] [PORT=8787] [HOST=127.0.0.1] node node/server.mjs
// cloudflare:sockets 由 node/hooks.mjs 解析到 node/sockets.mjs；WebSocket 升级通过 mkApp(rt) 的 rt.upgrade 提供。
import http from 'node:http';
import crypto from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tcpOpen } from './sockets.mjs';

register('./hooks.mjs', import.meta.url);
const { mkApp } = await import('../telegram_webproxy.js');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 4 * 1024 * 1024; // 单条消息上限（Worker 侧会拒绝 >2MB 的帧）
const MAX_BODY = 64 * 1024;

// ---- 最小 WebSocket 服务端（RFC 6455，只实现服务端需要的部分，不支持扩展/压缩）----
const frameOf = (op, data) => {
  const n = data.byteLength, h = n < 126 ? 2 : n < 65536 ? 4 : 10, f = Buffer.allocUnsafe(h + n);
  f[0] = 0x80 | op;
  if (n < 126) f[1] = n; else if (n < 65536) { f[1] = 126; f.writeUInt16BE(n, 2); } else { f[1] = 127; f.writeBigUInt64BE(BigInt(n), 2); }
  f.set(data, h); return f;
};

class Peer extends EventTarget {
  constructor() { super(); this.readyState = 0; this.binaryType = 'arraybuffer'; this.sock = null; this.buf = Buffer.alloc(0); this.parts = []; this.op = 0; this.size = 0; }
  accept() {}
  send(v) {
    if (this.readyState !== 1) return;
    const b = typeof v === 'string' ? Buffer.from(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    this.sock.write(frameOf(typeof v === 'string' ? 1 : 2, b));
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const r = Buffer.from(String(reason)).subarray(0, 123), p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code); r.copy(p, 2);
    this.sock.write(frameOf(8, p)); this.sock.end();
    setTimeout(() => this.sock.destroy(), 5000).unref();
  }
  emitClose(code, wasClean) {
    if (this.readyState === 3) return; this.readyState = 3;
    const e = new Event('close'); Object.assign(e, { code, reason: '', wasClean }); this.dispatchEvent(e);
  }
  bind(sock, head) {
    this.sock = sock; this.readyState = 1; sock.setNoDelay(true);
    sock.on('data', d => this.onBytes(d));
    sock.on('error', () => {});
    sock.on('close', () => this.emitClose(this.closeCode ?? 1006, this.closeCode !== undefined));
    if (head?.length) this.onBytes(head);
  }
  fail() { this.closeCode = 1002; try { this.sock.write(frameOf(8, Buffer.from([0x03, 0xea]))); } catch {} this.readyState = 2; this.sock.destroy(); }
  onBytes(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let n = b[1] & 0x7f, h = 2;
      if (b[0] & 0x70 || !masked) return this.fail();
      if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); h = 4; }
      else if (n === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return this.fail(); n = Number(big); h = 10; }
      if (n > MAX_MSG) return this.fail();
      if (b.length < h + 4 + n) return;
      const mask = b.subarray(h, h + 4), p = Buffer.from(b.subarray(h + 4, h + 4 + n));
      for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
      this.buf = b.subarray(h + 4 + n);
      if (op >= 8) {
        if (!fin || n > 125) return this.fail();
        if (op === 8) {
          this.closeCode = n >= 2 ? p.readUInt16BE(0) : 1005;
          if (this.readyState === 1) { this.readyState = 2; this.sock.write(frameOf(8, p.subarray(0, 2))); this.sock.end(); }
          return;
        }
        if (op === 9 && this.readyState === 1) this.sock.write(frameOf(10, p));
        continue;
      }
      if (op === 0 ? !this.op : this.op || (op !== 1 && op !== 2)) return this.fail();
      if (op) this.op = op;
      this.size += n; if (this.size > MAX_MSG) return this.fail();
      this.parts.push(p);
      if (!fin) continue;
      const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts), kind = this.op;
      this.parts = []; this.op = 0; this.size = 0;
      if (this.readyState !== 1) continue;
      const data = kind === 1 ? all.toString() : all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
}

// Node 侧运行时：升级时返回一个 Peer，server 在 upgrade 事件里把它绑到 socket 上
const nodeRt = connect => ({ connect, upgrade: proto => { const ws = new Peer(); return { ws, response: { status: 101, webSocket: ws, headers: new Headers({ 'Sec-WebSocket-Protocol': proto }) } }; } });

const toRequest = (req, body, proto) => {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const host = req.headers.host || 'localhost';
  return new Request(new URL(req.url, proto + '://' + host), { method: req.method, headers, body: body?.length ? body : undefined });
};
const readBody = req => new Promise((ok, bad) => {
  const parts = []; let n = 0;
  req.on('data', d => { n += d.length; if (n > MAX_BODY) { bad(Error('body')); req.destroy(); } else parts.push(d); });
  req.on('end', () => ok(Buffer.concat(parts))); req.on('error', bad);
});
const plain = (status) => 'HTTP/1.1 ' + status + ' ' + (http.STATUS_CODES[status] || '') + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

// proto：访客实际使用的协议，用于拼 URL（Origin 校验依赖它）；经 Cloudflare Tunnel 时是 https
// connect：可替换的 TCP 打开函数（测试用它指向假 DC），默认 node:net
export const start = async ({ port = 8787, host = '127.0.0.1', env, proto = 'https', connect = addr => tcpOpen(addr) } = {}) => {
  const app = mkApp(nodeRt(connect));
  const srv = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      const r = await app.fetch(toRequest(req, body, proto), env);
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, [...r.headers].flat());
      res.end(req.method === 'HEAD' ? undefined : out);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  const live = new Set();
  srv.on('upgrade', async (req, sock, head) => {
    sock.on('error', () => {}); live.add(sock); sock.on('close', () => live.delete(sock));
    try {
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers['sec-websocket-version'] !== '13') return sock.end(plain(400));
      const r = await app.fetch(toRequest(req, null, proto), env);
      if (r.status !== 101 || !r.webSocket) return sock.end(plain(r.status));
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept];
      const sp = r.headers.get('Sec-WebSocket-Protocol'); if (sp) lines.push('Sec-WebSocket-Protocol: ' + sp);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
      r.webSocket.bind(sock, head);
    } catch { sock.destroy(); }
  });
  srv.on('clientError', (_, sock) => sock.destroy());
  srv.keepAliveTimeout = 65000;
  await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(port, host, ok); });
  return { srv, port: srv.address().port, close: () => new Promise(ok => { srv.close(() => ok()); srv.closeAllConnections?.(); for (const s of live) s.destroy(); }) };
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = { SECRET: process.env.SECRET, BOOT: process.env.BOOT, PROXY: process.env.PROXY ?? 'direct' };
  if (!env.SECRET || !env.BOOT) { console.error('需要环境变量 SECRET 和 BOOT'); process.exit(1); }
  const s = await start({ port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1', env, proto: process.env.PROTO || 'https' });
  console.log('tgproxy relay listening on ' + (process.env.HOST || '127.0.0.1') + ':' + s.port);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
