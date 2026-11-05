// 测试用加载器：把 cloudflare:sockets 换成 node:net 实现，并导出内部符号
import net from 'node:net';
import { Duplex } from 'node:stream';
import { readFile } from 'node:fs/promises';

// 和 workerd 一样，readable 是字节流（type: 'bytes'），支持 BYOB reader；bytes: false 时退回 Duplex.toWeb 的普通流
export const tcpOpen = ({ hostname, port }, { bytes = true } = {}) => {
  const s = net.connect({ host: hostname, port });
  const opened = new Promise((ok, bad) => { s.once('connect', ok); s.once('error', bad); });
  opened.catch(() => {});
  s.on('error', () => {});
  if (!bytes) { const { readable, writable } = Duplex.toWeb(s); return { opened, readable, writable, close() { s.destroy(); } }; }
  const writable = new WritableStream({
    write: chunk => new Promise((ok, bad) => s.write(chunk, err => err ? bad(err) : ok())),
    close: () => new Promise(ok => s.end(ok)),
    abort: () => { s.destroy(); },
  });
  s.pause();
  const readable = new ReadableStream({
    type: 'bytes',
    start(c) {
      s.on('data', d => { c.enqueue(new Uint8Array(d)); if (c.desiredSize <= 0) s.pause(); });
      s.once('end', () => { try { c.close(); c.byobRequest?.respond(0); } catch {} });
      s.once('error', err => { try { c.error(err); } catch {} });
    },
    pull() { s.resume(); },
    cancel() { s.destroy(); },
  }, { highWaterMark: 64 * 1024 });
  return { opened, readable, writable, close() { s.destroy(); } };
};
globalThis.__tcpOpen = addr => tcpOpen(addr);
let src = await readFile(new URL('../telegram_webproxy.js', import.meta.url), 'utf8');
src = src.replace(/^import \{ connect \} from 'cloudflare:sockets';$/m, 'const connect = globalThis.__tcpOpen;');
src += '\nexport { parseProxy, dcAddr, dialProxy, dial, mkCfg, mkPack, mkHead, headOf, route, mkSess, mkBoot, mkPage, CFG };\n';
export const W = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
