#!/usr/bin/env node
// SSH ProxyCommand: HTTP CONNECT tunnel with proxy auth.
// Usage: proxy-connect-node.js <host> <port>
const net = require('net');

const PROXY_HOST = '45.38.107.97';
const PROXY_PORT = 6014;
const PROXY_AUTH = Buffer.from('pzjzqjfp:bo3f6h31q6yn').toString('base64');

const [host, port] = process.argv.slice(2);

const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
  sock.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    `Proxy-Authorization: Basic ${PROXY_AUTH}\r\n\r\n`
  );
});

let buffered = Buffer.alloc(0);
let connected = false;

sock.on('data', (chunk) => {
  if (connected) return;
  buffered = Buffer.concat([buffered, chunk]);
  const idx = buffered.indexOf('\r\n\r\n');
  if (idx === -1) return;

  const head = buffered.subarray(0, idx).toString();
  const status = head.split('\r\n')[0];
  if (!/ 200 /.test(status)) {
    process.stderr.write(`proxy CONNECT failed: ${status}\n`);
    process.exit(1);
  }

  connected = true;
  sock.removeAllListeners('data');
  const rest = buffered.subarray(idx + 4);
  if (rest.length) process.stdout.write(rest);
  sock.pipe(process.stdout);
  process.stdin.pipe(sock);
});

sock.on('error', (e) => {
  process.stderr.write(`proxy error: ${e.message}\n`);
  process.exit(1);
});

process.stdin.on('end', () => sock.end());
