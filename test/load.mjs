// 测试用加载器：把 cloudflare:sockets 换成 node:net 实现，并导出内部符号
import net from 'node:net';
import { Duplex } from 'node:stream';
import { readFile } from 'node:fs/promises';

globalThis.__tcpOpen = ({ hostname, port }) => {
  const s = net.connect({ host: hostname, port });
  const opened = new Promise((ok, bad) => { s.once('connect', ok); s.once('error', bad); });
  opened.catch(() => {});
  s.on('error', () => {});
  const { readable, writable } = Duplex.toWeb(s);
  return { opened, readable, writable, close() { s.destroy(); } };
};
let src = await readFile(new URL('../telegram_webproxy.js', import.meta.url), 'utf8');
src = src.replace(/^import \{ connect \} from 'cloudflare:sockets';$/m, 'const connect = globalThis.__tcpOpen;');
src += '\nexport { parseProxy, dcAddr, dialProxy, dial, mkCfg, mkPack, mkHead, headOf, route, mkSess, mkBoot, mkPage, CFG };\n';
export const W = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
