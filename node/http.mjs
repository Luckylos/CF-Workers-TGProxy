import http from 'node:http';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

// Ordinary responses and rejected upgrades share streaming, backpressure and cancellation.
export const respond = async (req, target, dispatch, upgrade) => {
  const ac = new AbortController();
  let res = upgrade ? null : target, reader;
  const abort = () => { if (res?.writableFinished) return; ac.abort(); void reader?.cancel().catch(() => {}); target.destroy(); };
  target.on('close', abort); target.on('error', abort); req.on('aborted', abort);
  if (upgrade) target.on('end', abort);
  try {
    const r = await dispatch(ac.signal);
    if (ac.signal.aborted) { await r.body?.cancel(); return; }
    if (upgrade && r.status === 101 && r.webSocket) { upgrade(r); return; }
    if (upgrade) {
      res = new http.ServerResponse(req);
      res.shouldKeepAlive = false;
      res.once('finish', () => target.end());
      res.on('error', abort);
      res.assignSocket(target);
    }
    reader = r.body?.getReader();
    res.writeHead(r.status, [...r.headers].flat());
    if (req.method !== 'HEAD' && reader) {
      res.flushHeaders();
      for (;;) {
        const { value, done } = await reader.read();
        if (ac.signal.aborted) throw ac.signal.reason;
        if (done) break;
        if (!res.write(value)) await once(res, 'drain', { signal: ac.signal });
      }
    }
    await finished(res.end(), { cleanup: true });
  } catch {
    if (res && !ac.signal.aborted && !res.headersSent) {
      res.writeHead(500);
      await finished(res.end(), { cleanup: true }).catch(() => res.destroy());
    } else (res || target).destroy();
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    target.off('close', abort); target.off('error', abort); req.off('aborted', abort);
    if (upgrade) { target.off('end', abort); res?.off('error', abort); }
  }
};
