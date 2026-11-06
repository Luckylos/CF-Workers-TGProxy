// Local HTTP boundaries: buffering, lost upgrade responses, timeouts and leaked upstreams.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { respond } from '../node/http.mjs';
import { start } from '../node/server.mjs';

const ENV = { SECRET: '0123456789abcdef0123456789abcdef', BOOT: 'test-boot-0123456789', PROXY: 'direct' };
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const within = async (promise, ms = 1500) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, bad) => { timer = setTimeout(() => bad(Error('deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
};
const fixture = async (t, handler) => {
  const upstream = http.createServer(handler);
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => { upstream.close(ok); upstream.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const relay = await start({ port: 0, env: { ...ENV, DECOY: origin }, proto: 'http' });
  t.after(() => relay.close());
  return { origin, port: relay.port };
};
const request = (t, port, options = {}) => {
  const opened = deferred();
  const req = http.request({ host: '127.0.0.1', port, path: '/other', ...options }, res => { res.on('error', () => {}); opened.resolve(res); });
  req.on('error', () => {});
  t.after(() => req.destroy()); req.end();
  return { req, response: opened.promise };
};
const text = res => new Promise((ok, bad) => {
  let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.once('end', () => ok(body)); res.once('error', bad);
});
const upgradeHeaders = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };

describe('Node HTTP response adapter', { concurrency: true }, () => {
  for (const fail of [false, true]) {
    test(`adapter keeps lifecycle listeners through final flush (failure=${fail})`, async () => {
      const finalizing = deferred();
      const res = new Writable({ final(cb) { finalizing.resolve(cb); } });
      res.writeHead = () => { res.headersSent = true; };
      const req = Object.assign(new EventEmitter(), { method: 'HEAD' });
      let settled = false;
      const pending = respond(req, res, () => new Response(null)).then(() => { settled = true; });
      const complete = await finalizing.promise; await turn();
      try { assert.equal(settled, false, 'adapter returned while final flush was pending'); }
      finally { complete(fail ? Error('late flush failure') : undefined); await pending; }
      assert.equal(res.listenerCount('error'), 0); assert.equal(req.listenerCount('aborted'), 0);
    });
  }

  test('first body chunk arrives before upstream completes', async t => {
    const sent = deferred();
    const relay = await fixture(t, (_, res) => { res.write('first'); sent.resolve(res); });
    const client = request(t, relay.port);
    const upstream = await sent.promise;
    const res = await within(client.response);
    const first = await within(new Promise(ok => res.once('data', ok)));
    assert.equal(first.toString(), 'first');
    const rest = text(res); upstream.end('last');
    assert.equal(await rest, 'last');
  });

  test('continuous body survives the former 7.5 second total timeout', async t => {
    const relay = await fixture(t, (_, res) => {
      res.write('0'); let n = 0;
      const timer = setInterval(() => { res.write(String(++n)); if (n === 9) { clearInterval(timer); res.end(); } }, 1000);
      res.once('close', () => clearInterval(timer));
    });
    const res = await within(request(t, relay.port).response, 11000);
    assert.equal(res.statusCode, 200);
    assert.equal(await within(text(res), 11000), '0123456789');
  });

  test('missing upstream headers times out to empty 404 and releases upstream', async t => {
    const closed = deferred();
    const relay = await fixture(t, (_, res) => res.once('close', closed.resolve));
    const before = Date.now();
    const res = await within(request(t, relay.port).response, 10000);
    assert.equal(res.statusCode, 404); assert.equal(await text(res), '');
    assert.ok(Date.now() - before >= 7000);
    await within(closed.promise);
  });

  for (const upgrade of [false, true]) {
    test(`client cancellation before headers releases upstream (upgrade=${upgrade})`, async t => {
      const arrived = deferred(), closed = deferred();
      const relay = await fixture(t, (_, res) => { res.once('close', closed.resolve); arrived.resolve(); });
      const client = request(t, relay.port, upgrade ? { headers: upgradeHeaders } : {});
      await within(arrived.promise); client.req.destroy();
      await within(closed.promise);
    });
    test(`client cancellation after headers releases upstream (upgrade=${upgrade})`, async t => {
      const closed = deferred();
      const relay = await fixture(t, (_, res) => { res.write('first'); res.once('close', closed.resolve); });
      const client = request(t, relay.port, upgrade ? { headers: upgradeHeaders } : {});
      const res = await within(client.response);
      await within(new Promise(ok => res.once('data', ok)));
      client.req.destroy(); await within(closed.promise);
    });
  }

  for (const started of [false, true]) {
    test(`rejected upgrade closes both connections after client FIN (started=${started})`, async t => {
      const arrived = deferred(), upstreamClosed = deferred(), received = deferred();
      const relay = await fixture(t, (_, res) => {
        res.once('close', upstreamClosed.resolve); if (started) res.write('first'); arrived.resolve();
      });
      const sock = net.connect(relay.port, '127.0.0.1'); t.after(() => sock.destroy());
      sock.on('error', () => {}); sock.on('data', received.resolve);
      const closed = new Promise(ok => sock.once('close', ok));
      sock.write('GET /other HTTP/1.1\r\nHost: 127.0.0.1\r\n' + Object.entries(upgradeHeaders).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      await within(arrived.promise); if (started) await within(received.promise);
      sock.end(); await within(upstreamClosed.promise); await within(closed);
    });
  }

  test('upstream body failure aborts an already started response without normal end', async t => {
    const sent = deferred();
    const relay = await fixture(t, (_, res) => { res.write('partial'); sent.resolve(res); });
    const res = await within(request(t, relay.port).response);
    let ended = false; res.once('end', () => { ended = true; });
    await within(new Promise(ok => res.once('data', ok)));
    const aborted = new Promise(ok => res.once('aborted', ok));
    (await sent.promise).destroy(); await within(aborted);
    assert.equal(res.statusCode, 200); assert.equal(ended, false); assert.equal(res.complete, false);
  });

  test('30 seconds without the next upstream chunk aborts downstream and upstream', async t => {
    const closed = deferred();
    const relay = await fixture(t, (_, res) => { res.write('partial'); res.once('close', closed.resolve); });
    const res = await within(request(t, relay.port).response, 10000);
    assert.equal(res.statusCode, 200);
    await within(new Promise(ok => res.once('data', ok)));
    let ended = false; res.once('end', () => { ended = true; });
    const before = Date.now();
    await within(new Promise(ok => res.once('aborted', ok)), 33000);
    assert.ok(Date.now() - before >= 29000); assert.equal(ended, false); assert.equal(res.complete, false);
    await within(closed.promise);
  });

  test('backpressure bounds upstream consumption and does not count as upstream idle', async t => {
    const total = 32 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 97);
    let produced = 0;
    const relay = await fixture(t, (_, res) => {
      const pump = () => { while (produced < total) { produced += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
      pump();
    });
    const res = await within(request(t, relay.port).response, 10000);
    assert.equal(res.statusCode, 200);
    res.pause(); await delay(31000);
    assert.ok(produced < total, `upstream fully consumed ${produced} bytes while client paused`);
    let received = 0; res.on('data', d => { received += d.length; }); res.resume();
    await within(new Promise((ok, bad) => { res.once('end', ok); res.once('error', bad); }), 8000);
    assert.equal(received, total); assert.equal(res.complete, true);
  });

  test('unknown-path upgrade preserves status, allowed headers and body on raw TCP', async t => {
    const relay = await fixture(t, (req, res) => {
      assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.upgrade, undefined);
      res.writeHead(422, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Set-Cookie': 'secret=1' }); res.end('decoy rejection');
    });
    const sock = net.connect(relay.port, '127.0.0.1'); t.after(() => sock.destroy());
    const wire = new Promise((ok, bad) => { let data = ''; sock.on('data', d => { data += d.toString(); }); sock.once('end', () => ok(data)); sock.once('error', bad); });
    sock.write('GET /other HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: secret=1\r\nAuthorization: Bearer private\r\n\r\n');
    const data = await within(wire);
    assert.match(data, /^HTTP\/1\.1 422/); assert.match(data, /content-type: text\/plain/i);
    assert.match(data, /cache-control: no-store/i); assert.match(data, /decoy rejection/); assert.doesNotMatch(data, /set-cookie/i);
  });

  test('HEAD, empty responses, redirects, protected routes and absent DECOY retain behavior', async t => {
    let origin, calls = 0;
    const relay = await fixture(t, (req, res) => {
      calls++;
      if (req.url === '/redirect') { res.writeHead(302, { location: origin + '/target' }); res.end('redirect'); }
      else if (req.url === '/empty') { res.writeHead(204); res.end(); }
      else { assert.equal(req.method, 'HEAD'); res.writeHead(200, { 'content-type': 'text/plain' }); res.end(); }
    }); origin = relay.origin;
    for (const [path, method, status, body] of [['/other', 'HEAD', 200, ''], ['/empty', 'GET', 204, ''], ['/redirect', 'GET', 302, 'redirect']]) {
      const res = await within(request(t, relay.port, { path, method }).response);
      assert.equal(res.statusCode, status); assert.equal(await text(res), body);
      if (status === 302) assert.equal(res.headers.location, '/target');
    }
    for (const path of ['/health', '/api/v1/ws', '/api/v1/session']) {
      const res = await within(request(t, relay.port, { path }).response); await text(res);
      assert.equal(res.statusCode, path === '/health' ? 200 : 404);
    }
    assert.equal(calls, 3);
    const bare = await start({ port: 0, env: ENV, proto: 'http' }); t.after(() => bare.close());
    for (const [path, status] of [['/', 200], ['/other', 404]]) {
      const res = await within(request(t, bare.port, { path }).response); assert.equal(res.statusCode, status); await text(res);
    }
  });
});
