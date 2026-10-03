#!/usr/bin/env node
// A fake "headless browser" for the external watcher runner's tests: an HTTP server on 127.0.0.1
// answering /json/version, and a minimal WebSocket CDP endpoint (RFC 6455 handshake and text frames,
// written here: no ws dependency) that supports exactly the calls the runner makes —
// Target.createTarget, Target.attachToTarget, Page.enable, Page.navigate (+ Page.loadEventFired),
// Runtime.evaluate, Browser.close. It cannot run page JavaScript: Runtime.evaluate of the extraction
// script answers with the configured result.
//
// Run as the "binary": node fake-cdp.mjs --record <file> [--text <t>] [--count <n>] [--redirect <url>]
//   followed by the runner's own arguments (Lightpanda style `serve --host 127.0.0.1 --port <p>
//   --http_proxy <url>`, or Chromium style `--remote-debugging-port=<p> --proxy-server=<url>`).
// It writes {argv, env, calls} to the record file after every CDP call.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const record = opt('--record');
const text = opt('--text', '$12.50');
const count = Number(opt('--count', '1'));
const redirect = opt('--redirect', '');
const port = Number(opt('--port') ?? (argv.find((a) => a.startsWith('--remote-debugging-port=')) ?? '').split('=')[1]);
const host = opt('--host', '127.0.0.1');
const calls = [];
let currentUrl = 'about:blank';
const save = () => record && writeFileSync(record, JSON.stringify({ argv, env: { HOME: process.env.HOME, HTTP_PROXY: process.env.HTTP_PROXY }, calls }, null, 2));
save();

function frame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
  if (!head) {
    const h = Buffer.alloc(10);
    h[0] = 0x81;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return Buffer.concat([h, payload]);
  }
  return Buffer.concat([head, payload]);
}

function parseFrames(buf, onText, onClose) {
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (op === 1) onText(data.toString('utf8'));
    else if (op === 8) onClose();
    off = p + len;
  }
  return buf.subarray(off);
}

const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'FakeCDP/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
    return;
  }
  res.writeHead(404).end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (o) => socket.write(frame(JSON.stringify(o)));
  let rest = Buffer.alloc(0);
  socket.on('data', (d) => {
    rest = parseFrames(Buffer.concat([rest, d]), (t) => {
      const m = JSON.parse(t);
      calls.push({ method: m.method, params: m.params, sessionId: m.sessionId });
      save();
      const reply = (result) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      switch (m.method) {
        case 'Target.createTarget':
          return reply({ targetId: 'T1' });
        case 'Target.attachToTarget':
          return reply({ sessionId: 'S1' });
        case 'Page.enable':
          return reply({});
        case 'Page.navigate':
          currentUrl = redirect || m.params.url;
          reply({ frameId: 'F1', loaderId: 'L1' });
          setTimeout(() => send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: m.sessionId }), 20);
          return;
        case 'Runtime.evaluate': {
          const e = String(m.params.expression);
          if (e === 'location.href') return reply({ result: { type: 'string', value: currentUrl } });
          if (e.includes('gbMatch')) return reply({ result: { type: 'object', value: { url: currentUrl, title: 'Price watch', heading: 'Blue Widget', count, text: count === 1 ? text : '' } } });
          return reply({ result: { type: 'undefined' } });
        }
        case 'Browser.close':
          reply({});
          setTimeout(() => process.exit(0), 10);
          return;
        default:
          return send({ id: m.id, error: { code: -32601, message: `'${m.method}' wasn't found` } });
      }
    }, () => socket.end());
  });
  socket.on('error', () => undefined);
});

server.listen(port, host);
