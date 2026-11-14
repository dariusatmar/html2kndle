import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchSource, sourceFromUpload, isBlockedAddress, _internals } from '../src/fetch.js';
import { loadConfig, type Config } from '../src/config.js';
import { UserError } from '../src/types.js';

const strict: Config = { ...loadConfig({}), allowPrivateHosts: false, fetchTimeoutMs: 3000 };
let cfg: Config;
let server: http.Server;
let base: string;

before(async () => {
  cfg = { ...loadConfig({}), allowPrivateHosts: true, fetchTimeoutMs: 3000, maxBytes: 100_000 };
  server = http.createServer((req, res) => {
    const u = req.url ?? '/';
    if (u === '/html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body>héllo</body></html>');
    } else if (u === '/latin') {
      res.setHeader('content-type', 'text/html; charset=windows-1252');
      res.end(Buffer.from('<p>caf\xe9 \x93quoted\x94</p>', 'latin1'));
    } else if (u === '/meta') {
      res.setHeader('content-type', 'text/html');
      res.end(Buffer.from('<meta charset="windows-1252"><p>na\xefve</p>', 'latin1'));
    } else if (u === '/pdf-mislabelled') {
      res.setHeader('content-type', 'text/html');
      res.end('%PDF-1.4\n%fake');
    } else if (u === '/dl') {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', 'attachment; filename="Annual Report 2024.pdf"');
      res.end('%PDF-1.4 x');
    } else if (u === '/papers/my%20paper') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end('%PDF-1.7 x');
    } else if (u === '/big') {
      res.setHeader('content-type', 'text/html');
      res.write(Buffer.alloc(60_000, 97));
      res.end(Buffer.alloc(60_000, 97));
    } else if (u === '/r1') {
      res.statusCode = 302;
      res.setHeader('location', '/html');
      res.end();
    } else if (u === '/loop') {
      res.statusCode = 302;
      res.setHeader('location', '/loop');
      res.end();
    } else if (u === '/to-private') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      res.end();
    } else if (u === '/404') {
      res.statusCode = 404;
      res.end('nope');
    } else if (u === '/img') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function rejects(p: Promise<unknown>, status: number, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof UserError, `expected UserError, got ${String(e)}`);
    assert.equal(e.status, status);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('SSRF: literal private/loopback/metadata addresses are rejected', async () => {
  for (const u of [
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
  ]) {
    await rejects(fetchSource(u, strict), 400, /not allowed/);
  }
});

test('SSRF: hostnames that resolve to loopback are rejected', async () => {
  await rejects(fetchSource('http://localhost/', strict), 400, /not allowed/);
});

test('isBlockedAddress classification', () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('172.32.0.1'), false);
  assert.equal(isBlockedAddress('172.31.255.255'), true);
});

test('non-http schemes and garbage are rejected', async () => {
  await rejects(fetchSource('file:///etc/passwd', cfg), 400, /http/);
  await rejects(fetchSource('ftp://example.com/x', cfg), 400);
  await rejects(fetchSource('not a url', cfg), 400);
});

test('redirect to a private host is rejected (re-validated per hop)', async () => {
  const orig = _internals.isBlocked;
  _internals.isBlocked = (ip) => ip !== '127.0.0.1' && orig(ip); // allow only the local test server
  try {
    await rejects(fetchSource(`${base}/to-private`, strict), 400, /not allowed/);
    const ok = await fetchSource(`${base}/html`, strict);
    assert.equal(ok.kind, 'html');
  } finally {
    _internals.isBlocked = orig;
  }
});

test('redirects are followed, loops are capped', async () => {
  const s = await fetchSource(`${base}/r1`, cfg);
  assert.equal(s.kind, 'html');
  assert.equal(s.url, `${base}/html`);
  await rejects(fetchSource(`${base}/loop`, cfg), 502, /redirects/);
});

test('size limit => 413', async () => {
  await rejects(fetchSource(`${base}/big`, cfg), 413);
});

test('non-2xx => 502 with status', async () => {
  await rejects(fetchSource(`${base}/404`, cfg), 502, /404/);
});

test('unsupported content type => 415', async () => {
  await rejects(fetchSource(`${base}/img`, cfg), 415);
});

test('utf-8 html and windows-1252 header/meta charsets', async () => {
  const a = await fetchSource(`${base}/html`, cfg);
  assert.ok(a.kind === 'html' && a.html.includes('héllo'));
  const b = await fetchSource(`${base}/latin`, cfg);
  assert.ok(b.kind === 'html' && b.html.includes('café “quoted”'), b.kind === 'html' ? b.html : '');
  const c = await fetchSource(`${base}/meta`, cfg);
  assert.ok(c.kind === 'html' && c.html.includes('naïve'));
});

test('PDF sniffed by magic bytes despite wrong content-type', async () => {
  const s = await fetchSource(`${base}/pdf-mislabelled`, cfg);
  assert.equal(s.kind, 'pdf');
  const o = await fetchSource(`${base}/papers/my%20paper`, cfg);
  assert.ok(o.kind === 'pdf' && o.filename === 'my-paper.pdf', JSON.stringify(o.kind === 'pdf' && o.filename));
});

test('PDF filename from Content-Disposition is ASCII-safe with .pdf', async () => {
  const s = await fetchSource(`${base}/dl`, cfg);
  assert.ok(s.kind === 'pdf');
  assert.match(s.filename, /^[A-Za-z0-9._-]+\.pdf$/);
  assert.equal(s.filename, 'Annual-Report-2024.pdf');
});

test('sourceFromUpload classification', () => {
  const d = (s: string): Buffer => Buffer.from(s);
  assert.equal(sourceFromUpload({ filename: 'a.pdf', contentType: 'application/pdf', data: d('%PDF-1') }).kind, 'pdf');
  assert.equal(sourceFromUpload({ filename: 'noext', contentType: '', data: d('%PDF-1.7') }).kind, 'pdf');
  assert.equal(sourceFromUpload({ filename: 'a.html', contentType: 'text/html', data: d('<p>x</p>') }).kind, 'html');
  assert.equal(sourceFromUpload({ filename: 'a.htm', contentType: '', data: d('<p>x</p>') }).kind, 'html');
  for (const n of ['a.epub', 'a.txt', 'a.docx', 'a.rtf']) {
    assert.equal(sourceFromUpload({ filename: n, contentType: '', data: d('x') }).kind, 'passthrough', n);
  }
  assert.throws(() => sourceFromUpload({ filename: 'a.exe', contentType: 'application/x-msdownload', data: d('MZ') }), (e: unknown) => e instanceof UserError && e.status === 415);
});
