import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import { UserError, type SendRequest, type Source } from './types.js';

const MAX_REDIRECTS = 5;
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// ---------- IP classification ----------

function ipv4Private(a: number, b: number, c: number, d: number): boolean {
  void c;
  void d;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (approx)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function expandIPv6(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  // embedded IPv4 tail
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const p = m[2]!.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    s = `${m[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else groups = head;
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True if the address must not be fetched (private, loopback, link-local, etc.). */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number) as [number, number, number, number];
    return ipv4Private(a, b, c, d);
  }
  if (net.isIPv6(ip)) {
    const g = expandIPv6(ip);
    if (!g) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    if (g.every((x) => x === 0)) return true; // ::
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
    // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96
    const v4 = (): boolean => ipv4Private(g6 >> 8, g6 & 255, g7 >> 8, g7 & 255);
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return v4();
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4();
    if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
    if ((g0 & 0xffc0) === 0xfec0) return true; // site-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    if (g0 === 0x2002) return ipv4Private(g1 >> 8, g1 & 255, g2 >> 8, g2 & 255); // 6to4
    return false;
  }
  return true;
}

function blockedError(): UserError {
  return new UserError('That address is not allowed (private or local network addresses are blocked)', 400);
}

// ---------- low-level request ----------

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawGet(u: URL, cfg: Config, deadline: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    if (!cfg.allowPrivateHosts && net.isIP(hostname) && isBlockedAddress(hostname)) {
      reject(blockedError());
      return;
    }
    // Validate at connection time (pins the check to the address actually used; defeats DNS rebinding).
    const lookup: net.LookupFunction = (host, opts, cb) => {
      dns.lookup(host, { ...(opts as dns.LookupOptions), all: true }, (err, addrs) => {
        const list = (addrs ?? []) as dns.LookupAddress[];
        if (err) return (cb as (e: Error | null, a?: unknown, f?: number) => void)(err);
        if (!cfg.allowPrivateHosts && list.some((a) => isBlockedAddress(a.address))) {
          return (cb as (e: Error | null) => void)(blockedError());
        }
        if (!list.length) return (cb as (e: Error | null) => void)(new Error(`No address for ${host}`));
        if ((opts as dns.LookupOptions).all) return (cb as (e: null, a: unknown) => void)(null, list);
        (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
      });
    };

    const remaining = Math.max(1, deadline - Date.now());
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      u,
      {
        method: 'GET',
        lookup,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          done(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > cfg.maxBytes && !res.headers['content-encoding']) {
          req.destroy();
          done(() => reject(tooLarge(cfg)));
          return;
        }
        let stream: Readable = res;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (c: Buffer) => {
          total += c.length;
          if (total > cfg.maxBytes) {
            req.destroy();
            res.destroy();
            done(() => reject(tooLarge(cfg)));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => done(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
        stream.on('error', (e) => done(() => reject(wrapNetErr(e))));
        res.on('error', (e) => done(() => reject(wrapNetErr(e))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new UserError('Timed out fetching the page', 504)));
    }, remaining);
    req.on('error', (e) => done(() => reject(wrapNetErr(e))));
    req.end();
  });
}

function tooLarge(cfg: Config): UserError {
  return new UserError(`Document is larger than the ${Math.round(cfg.maxBytes / 1024 / 1024 * 10) / 10} MB limit`, 413);
}

function wrapNetErr(e: unknown): Error {
  if (e instanceof UserError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return new UserError('Could not resolve that host', 502);
  if (err.code === 'ECONNREFUSED') return new UserError('Connection refused by the remote host', 502);
  if (err.code === 'ECONNRESET') return new UserError('Connection reset by the remote host', 502);
  return new UserError(`Could not fetch the page: ${err.message}`, 502);
}

// ---------- helpers ----------

function parseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UserError('That does not look like a valid URL', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UserError('Only http and https URLs are supported', 400);
  }
  return u;
}

function isPdfBytes(b: Buffer): boolean {
  // Allow a little leading junk, as the spec does (header within first 1024 bytes).
  return b.subarray(0, 1024).includes('%PDF-');
}

function startsWithPdf(b: Buffer): boolean {
  return b.subarray(0, 5).toString('latin1') === '%PDF-';
}

function mimeOf(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

function charsetFromContentType(header: string | undefined): string | undefined {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(header ?? '');
  return m?.[1];
}

function decodeHtml(body: Buffer, contentType: string | undefined): string {
  let charset = charsetFromContentType(contentType);
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) charset = 'utf-8';
  else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) charset = 'utf-16le';
  else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) charset = 'utf-16be';
  if (!charset) {
    const head = body.subarray(0, 4096).toString('latin1');
    const m =
      /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-:.]+)/i.exec(head) ??
      /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_\-]+)["']/i.exec(head);
    charset = m?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function safeAscii(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'document'
  );
}

function pdfFilename(name: string | undefined): string {
  let n = (name ?? '').trim();
  n = n.replace(/\.pdf$/i, '');
  return `${safeAscii(n)}.pdf`;
}

function filenameFromDisposition(cd: string | undefined): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[2]!.trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
  return (plain?.[1] ?? plain?.[2])?.trim();
}

function filenameFromUrl(u: URL): string | undefined {
  const last = u.pathname.split('/').filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// ---------- public API ----------

export async function fetchSource(url: string, cfg: Config): Promise<Source> {
  let current = parseUrl(url);
  const deadline = Date.now() + cfg.fetchTimeoutMs;
  let res: RawResponse | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await rawGet(current, cfg, deadline);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === MAX_REDIRECTS) throw new UserError('Too many redirects', 502);
      let next: URL;
      try {
        next = new URL(String(res.headers.location), current);
      } catch {
        throw new UserError('Bad redirect from remote server', 502);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new UserError('Redirected to an unsupported URL scheme', 400);
      }
      current = next;
      continue;
    }
    break;
  }
  if (!res) throw new UserError('Fetch failed', 502);
  if (res.status < 200 || res.status >= 300) {
    throw new UserError(`The site responded with HTTP ${res.status}`, 502);
  }
  const finalUrl = current.toString();
  const ct = res.headers['content-type'] as string | undefined;
  const mime = mimeOf(ct);

  if (startsWithPdf(res.body) || isPdfBytes(res.body) || mime === 'application/pdf') {
    const name =
      filenameFromDisposition(res.headers['content-disposition'] as string | undefined) ?? filenameFromUrl(current);
    return { kind: 'pdf', data: res.body, filename: pdfFilename(name), url: finalUrl };
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '') {
    return { kind: 'html', html: decodeHtml(res.body, ct), url: finalUrl };
  }
  throw new UserError(`Unsupported content type: ${mime}`, 415);
}

const PASSTHROUGH: Record<string, string> = {
  epub: 'application/epub+zip',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
};

export function sourceFromUpload(file: NonNullable<SendRequest['file']>): Source {
  const name = file.filename || 'upload';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const type = mimeOf(file.contentType);
  if (type === 'application/pdf' || ext === 'pdf' || startsWithPdf(file.data)) {
    return { kind: 'pdf', data: file.data, filename: pdfFilename(name), };
  }
  if (ext === 'html' || ext === 'htm' || type === 'text/html' || type === 'application/xhtml+xml') {
    return { kind: 'html', html: decodeHtml(file.data, file.contentType) };
  }
  if (PASSTHROUGH[ext]) {
    return { kind: 'passthrough', data: file.data, filename: safeAscii(name), contentType: PASSTHROUGH[ext]! };
  }
  if (type === 'application/epub+zip') {
    return { kind: 'passthrough', data: file.data, filename: safeAscii(name), contentType: type };
  }
  throw new UserError('Unsupported file type. Use PDF, HTML, EPUB, TXT, DOCX or RTF.', 415);
}
