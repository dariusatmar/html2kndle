import { readFile } from 'node:fs/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { emailConfigured, loadConfig, type Config } from './config.js';
import { handleSend } from './pipeline.js';
import { UserError, type Delivery, type SendRequest } from './types.js';

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '';
  const local = email.slice(0, at);
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}${email.slice(at)}`;
}

function wantsText(c: Context): boolean {
  if (c.req.query('format') === 'text') return true;
  const accept = c.req.header('accept') ?? '';
  return accept.includes('text/plain') && !accept.includes('application/json');
}

function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\;]/g, '_');
}

function contentDisposition(filename: string): string {
  const enc = encodeURIComponent(filename).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${enc}`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  const indexPath = new URL('../public/index.html', import.meta.url);

  const fail = (c: Context, status: number, message: string): Response => {
    const st = status as 400;
    if (wantsText(c)) return c.text(`Error: ${message}`, st);
    return c.json({ ok: false, error: message }, st);
  };

  app.onError((err, c) => {
    if (err instanceof UserError) return fail(c, err.status, err.message);
    console.error('[server] unexpected error:', err);
    return fail(c, 500, 'Internal server error');
  });

  const auth = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (cfg.authToken) {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
      const provided = bearer ?? c.req.header('x-auth-token') ?? c.req.query('token') ?? '';
      if (!provided || !safeEqual(provided, cfg.authToken)) {
        return fail(c, 401, 'Unauthorized: missing or invalid token');
      }
    }
    await next();
  };

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/', async (c) => {
    const html = await readFile(indexPath, 'utf8');
    return c.html(html, 200, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  });

  app.get('/api/config', auth, (c) =>
    c.json({ emailConfigured: emailConfigured(cfg), kindleEmail: maskEmail(cfg.kindleEmail) }),
  );

  app.post(
    '/api/send',
    auth,
    bodyLimit({
      maxSize: cfg.maxBytes + 64 * 1024,
      onError: (c) => fail(c, 413, `Request is larger than the ${Math.round((cfg.maxBytes / 1024 / 1024) * 10) / 10} MB limit`),
    }),
    async (c) => {
      const ctype = (c.req.header('content-type') ?? '').toLowerCase();
      let fields: Record<string, unknown> = {};
      try {
        if (ctype.includes('application/json')) {
          const body = await c.req.json();
          if (body && typeof body === 'object' && !Array.isArray(body)) fields = body as Record<string, unknown>;
          else throw new UserError('JSON body must be an object', 400);
        } else if (ctype.includes('multipart/form-data') || ctype.includes('application/x-www-form-urlencoded')) {
          fields = (await c.req.parseBody()) as Record<string, unknown>;
        } else {
          throw new UserError('Unsupported content type; use JSON, multipart/form-data or form-urlencoded', 415);
        }
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError('Could not parse the request body', 400);
      }

      const req: SendRequest = { url: str(fields.url), html: str(fields.html), title: str(fields.title) };
      const f = fields.file;
      if (f && typeof f === 'object' && 'arrayBuffer' in f) {
        const file = f as File;
        if (file.size > 0) {
          if (file.size > cfg.maxBytes) throw new UserError('Uploaded file is too large', 413);
          req.file = {
            filename: file.name || 'upload',
            contentType: file.type || '',
            data: Buffer.from(await file.arrayBuffer()),
          };
        }
      }

      const canEmail = emailConfigured(cfg);
      const requested = str(fields.delivery) ?? c.req.query('delivery');
      if (requested !== undefined && requested !== 'email' && requested !== 'download') {
        throw new UserError("delivery must be 'email' or 'download'", 400);
      }
      const delivery: Delivery = (requested as Delivery | undefined) ?? (canEmail ? 'email' : 'download');
      if (delivery === 'email' && !canEmail) {
        throw new UserError(
          'Email delivery is not configured. Set KINDLE_EMAIL, FROM_EMAIL and SMTP_HOST/SMTP_USER/SMTP_PASS on the server, or use delivery=download.',
          503,
        );
      }

      const { result, doc } = await handleSend(req, delivery, cfg);
      if (delivery === 'download') {
        return new Response(new Uint8Array(doc.data), {
          status: 200,
          headers: {
            'Content-Type': doc.contentType,
            'Content-Length': String(doc.data.length),
            'Content-Disposition': contentDisposition(doc.filename),
            'X-Document-Title': encodeURIComponent(doc.title),
            'Cache-Control': 'no-store',
          },
        });
      }
      if (wantsText(c)) return c.text(`Sent "${result.title}" to Kindle`);
      return c.json(result);
    },
  );

  return app;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  const cfg = loadConfig();
  if (!cfg.authToken) {
    console.warn('!!! WARNING: AUTH_TOKEN is empty - the API is OPEN to anyone who can reach this server. Set AUTH_TOKEN. !!!');
  }
  if (!emailConfigured(cfg)) console.warn('Email is not configured; only delivery=download will work.');
  const app = createApp(cfg);
  serve({ fetch: app.fetch, port: cfg.port }, (info) => console.log(`html2kindle listening on http://localhost:${info.port}`));
}
