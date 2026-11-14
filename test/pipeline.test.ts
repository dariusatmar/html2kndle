import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prepareDocument, handleSend } from '../src/pipeline.js';
import { loadConfig, type Config } from '../src/config.js';
import { sendToKindle } from '../src/mailer.js';
import { UserError } from '../src/types.js';
import nodemailer from 'nodemailer';

const cfg: Config = { ...loadConfig({}), allowPrivateHosts: true, fetchTimeoutMs: 3000 };
const mailCfg: Config = {
  ...cfg,
  kindleEmail: 'me_abc@kindle.com',
  fromEmail: 'from@example.com',
  smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'super-secret' },
};
const ARTICLE = `<html><head><title>My Essay</title></head><body><article><h1>My Essay</h1>${'<p>Some long paragraph of words that make an essay readable and long enough. </p>'.repeat(20)}</article></body></html>`;

let server: http.Server;
let base: string;
before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(ARTICLE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('requires an input', async () => {
  await assert.rejects(prepareDocument({}, cfg), (e: unknown) => e instanceof UserError && e.status === 400);
});

test('html input becomes an EPUB', async () => {
  const doc = await prepareDocument({ html: ARTICLE, url: 'https://example.com/essay' }, cfg);
  assert.equal(doc.data.subarray(0, 2).toString(), 'PK');
  assert.match(doc.filename, /\.epub$/);
  assert.equal(doc.contentType, 'application/epub+zip');
});

test('url input is fetched and converted; title override wins', async () => {
  const doc = await prepareDocument({ url: `${base}/x`, title: 'Custom Title' }, cfg);
  assert.equal(doc.title, 'Custom Title');
  assert.equal(doc.data.subarray(0, 2).toString(), 'PK');
});

test('precedence: file > html > url', async () => {
  const pdf = Buffer.from('%PDF-1.4 test');
  const doc = await prepareDocument(
    { file: { filename: 'paper.pdf', contentType: 'application/pdf', data: pdf }, html: ARTICLE, url: `${base}/x` },
    cfg,
  );
  assert.equal(doc.contentType, 'application/pdf');
  assert.deepEqual(doc.data, pdf);
  assert.equal(doc.title, 'paper');
  const doc2 = await prepareDocument({ html: ARTICLE, url: 'http://127.0.0.1:1/never' }, cfg);
  assert.match(doc2.filename, /\.epub$/);
});

test('PDF title from req.title; passthrough as-is', async () => {
  const d1 = await prepareDocument({ title: 'T', file: { filename: 'a.pdf', contentType: '', data: Buffer.from('%PDF-1') } }, cfg);
  assert.equal(d1.title, 'T');
  const d2 = await prepareDocument({ file: { filename: 'book.epub', contentType: 'application/epub+zip', data: Buffer.from('PKx') } }, cfg);
  assert.equal(d2.contentType, 'application/epub+zip');
  assert.equal(d2.filename, 'book.epub');
});

test('handleSend download does not email; email uses injected transport', async () => {
  const req = { file: { filename: 'a.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1') } };
  const d = await handleSend(req, 'download', cfg);
  assert.equal(d.result.delivery, 'download');
  assert.equal(d.result.messageId, undefined);
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const e = await handleSend(req, 'email', mailCfg, transport);
  assert.equal(e.result.delivery, 'email');
  assert.ok(e.result.messageId);
  assert.equal(e.result.bytes, e.doc.data.length);
});

test('mailer: attachment, recipients, subject', async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const sent: { to: unknown; from: unknown; subject: unknown; attachments: Array<{ filename?: string; contentType?: string }> }[] = [];
  const spy = {
    sendMail: async (opts: Parameters<typeof transport.sendMail>[0]) => {
      const info = await transport.sendMail(opts);
      const m = JSON.parse((info as { message: string }).message);
      sent.push({ to: m.to, from: m.from, subject: m.subject, attachments: m.attachments });
      return info;
    },
  } as unknown as Pick<typeof transport, 'sendMail'>;
  const r = await sendToKindle(
    { filename: 'Doc.epub', contentType: 'application/epub+zip', data: Buffer.from('PKdata'), title: 'Doc Title' },
    mailCfg,
    spy,
  );
  assert.ok(r.messageId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.subject, 'Doc Title');
  assert.deepEqual(sent[0]!.to, [{ address: 'me_abc@kindle.com', name: '' }]);
  assert.deepEqual(sent[0]!.from, { address: 'from@example.com', name: '' });
  assert.equal(sent[0]!.attachments[0]!.filename, 'Doc.epub');
  assert.equal(sent[0]!.attachments[0]!.contentType, 'application/epub+zip');
});

test('mailer: unconfigured => 503; SMTP failure => 502 without leaking password', async () => {
  const doc = { filename: 'a.epub', contentType: 'application/epub+zip', data: Buffer.from('x'), title: 'A' };
  await assert.rejects(sendToKindle(doc, cfg), (e: unknown) => e instanceof UserError && e.status === 503 && /not configured/.test(e.message));
  const bad = { sendMail: async () => { throw Object.assign(new Error('Invalid login super-secret'), { code: 'EAUTH' }); } };
  await assert.rejects(sendToKindle(doc, mailCfg, bad as never), (e: unknown) => {
    assert.ok(e instanceof UserError);
    assert.equal(e.status, 502);
    assert.ok(!e.message.includes('super-secret'));
    return true;
  });
});
