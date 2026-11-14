import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.js';
import { loadConfig, type Config } from '../src/config.js';

const ARTICLE = `<html><head><title>Server Essay</title></head><body><article><h1>Server Essay</h1>${'<p>Some long paragraph of words that make an essay readable and long enough. </p>'.repeat(20)}</article></body></html>`;
const TOKEN = 's3cret';
const base: Config = { ...loadConfig({}), authToken: TOKEN, allowPrivateHosts: true, fetchTimeoutMs: 3000, maxBytes: 200_000 };
const app = createApp(base);

let page: http.Server;
let pageUrl: string;
before(async () => {
  page = http.createServer((_q, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(ARTICLE);
  });
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/essay`;
});
after(() => page.close());

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, headers: Record<string, string> = auth, qs = ''): Promise<Response> =>
  Promise.resolve(app.request(`/api/send${qs}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

test('healthz and index need no auth', async () => {
  const h = await app.request('/healthz');
  assert.deepEqual(await h.json(), { ok: true });
  const i = await app.request('/');
  assert.equal(i.status, 200);
  assert.match(i.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await i.text(), /Send to Kindle/);
});

test('auth: missing / wrong / right in header, x-auth-token, query', async () => {
  assert.equal((await app.request('/api/config')).status, 401);
  assert.equal((await app.request('/api/config', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await app.request('/api/config?token=nope')).status, 401);
  assert.equal((await app.request('/api/config', { headers: auth })).status, 200);
  assert.equal((await app.request('/api/config', { headers: { 'X-Auth-Token': TOKEN } })).status, 200);
  assert.equal((await app.request(`/api/config?token=${TOKEN}`)).status, 200);
  const r = await app.request('/api/config');
  assert.deepEqual(await r.json(), { ok: false, error: 'Unauthorized: missing or invalid token' });
});

test('empty authToken allows everything', async () => {
  const open = createApp({ ...base, authToken: '' });
  assert.equal((await open.request('/api/config')).status, 200);
});

test('/api/config masks the email', async () => {
  const a = createApp({ ...base, kindleEmail: 'jane_doe123@kindle.com', fromEmail: 'a@b.c', smtp: { host: 'h', port: 1, secure: false, user: 'u', pass: 'p' } });
  const j = (await (await a.request('/api/config', { headers: auth })).json()) as { emailConfigured: boolean; kindleEmail: string };
  assert.equal(j.emailConfigured, true);
  assert.ok(!j.kindleEmail.includes('jane_doe123'));
  assert.ok(j.kindleEmail.endsWith('@kindle.com'));
});

test('JSON html + delivery=download returns EPUB', async () => {
  const r = await json({ html: ARTICLE, url: 'https://example.com/e', delivery: 'download' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/epub+zip');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="[^"]+\.epub"; filename\*=UTF-8''/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('JSON url (fetched) download', async () => {
  const r = await json({ url: pageUrl, delivery: 'download', title: 'Ünïcode "Title"' });
  assert.equal(r.status, 200);
  const cd = r.headers.get('content-disposition') ?? '';
  assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('multipart url + download', async () => {
  const fd = new FormData();
  fd.set('url', pageUrl);
  fd.set('delivery', 'download');
  const r = await app.request('/api/send', { method: 'POST', headers: auth, body: fd });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('urlencoded form works', async () => {
  const r = await app.request('/api/send', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url: pageUrl, delivery: 'download' }).toString(),
  });
  assert.equal(r.status, 200);
});

test('PDF upload passthrough', async () => {
  const fd = new FormData();
  const pdf = Buffer.from('%PDF-1.4\nhello');
  fd.set('file', new File([pdf], 'My Paper.pdf', { type: 'application/pdf' }));
  fd.set('delivery', 'download');
  const r = await app.request('/api/send', { method: 'POST', headers: auth, body: fd });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition') ?? '', /My-Paper\.pdf/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), pdf);
});

test('email not configured => 503 JSON (explicit and default is download)', async () => {
  const r = await json({ html: ARTICLE, delivery: 'email' });
  assert.equal(r.status, 503);
  const j = (await r.json()) as { ok: boolean; error: string };
  assert.equal(j.ok, false);
  assert.match(j.error, /SMTP|download/);
  const d = await json({ html: ARTICLE });
  assert.equal(d.status, 200); // defaults to download when email is unavailable
});

test('errors: 400 missing input, bad delivery, bad content type; text format', async () => {
  const r = await json({});
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { ok: boolean }).ok, false);
  assert.equal((await json({ html: ARTICLE, delivery: 'pigeon' })).status, 400);
  const t = await json({}, auth, '?format=text');
  assert.equal(t.status, 400);
  assert.match(t.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await t.text(), /^Error: /);
  const a = await json({ html: ARTICLE, delivery: 'email' }, { ...auth, Accept: 'text/plain' });
  assert.equal(a.status, 503);
  assert.match(await a.text(), /^Error: /);
  const ct = await app.request('/api/send', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(ct.status, 415);
});

test('ssrf blocked through the API', async () => {
  const strict = createApp({ ...base, allowPrivateHosts: false });
  const r = await strict.request('/api/send', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://169.254.169.254/', delivery: 'download' }) });
  assert.equal(r.status, 400);
});

test('email success text format with injected-free path: configured but SMTP unreachable => 502', async () => {
  const a = createApp({ ...base, kindleEmail: 'k@kindle.com', fromEmail: 'f@x.com', smtp: { host: '127.0.0.1', port: 1, secure: false, user: 'u', pass: 'p' } });
  const r = await a.request('/api/send?format=text', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ html: ARTICLE }) });
  assert.equal(r.status, 502);
  assert.match(await r.text(), /^Error: Email delivery failed/);
});

test('oversized body => 413', async () => {
  const big = createApp({ ...base, maxBytes: 1000 });
  const body = JSON.stringify({ html: 'x'.repeat(200_000) });
  const r = await big.request('/api/send', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });
  assert.equal(r.status, 413);
  assert.equal(((await r.json()) as { ok: boolean }).ok, false);
});

test('no permissive CORS headers', async () => {
  const r = await app.request('/healthz', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
