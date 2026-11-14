/**
 * Article -> EPUB 3 (with EPUB 2 toc.ncx) suitable for Send-to-Kindle.
 *
 * Amazon's converter rejects malformed XML, so the body is re-parsed with an
 * HTML parser, scrubbed, and serialised as XHTML with XMLSerializer.
 */
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import type { Article, KindleDocument } from './types.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const TITLE_ID = 'h2k-title';

/** Elements that must never reach the EPUB, even if a caller hands us raw HTML. */
const DROP_TAGS =
  'script, style, link, meta, base, title, head, template, iframe, frame, frameset, object, embed, applet, ' +
  'form, input, button, select, textarea, svg, math, canvas, video, audio, source, track, img, picture, map, area, noscript';
/** Elements not allowed in EPUB 3 XHTML content; replaced by their children. */
const UNWRAP_TAGS = new Set(['html', 'body', 'font', 'center', 'big', 'tt', 'strike', 'blink', 'marquee', 'nobr', 'acronym', 'basefont']);

const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Characters not allowed in XML 1.0 documents.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const EPUB_CSS = `@charset "UTF-8";
body { margin: 0; padding: 0; line-height: 1.45; text-align: left; }
h1, h2, h3, h4, h5, h6 { line-height: 1.2; text-align: left; page-break-after: avoid; margin: 1.2em 0 0.5em 0; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }
p { margin: 0 0 0.8em 0; text-indent: 0; }
a { color: inherit; text-decoration: underline; }
blockquote { margin: 1em 1.5em; padding: 0; font-style: italic; }
blockquote em, blockquote i { font-style: normal; }
pre { font-family: monospace; font-size: 0.85em; white-space: pre-wrap; margin: 1em 0; padding: 0.5em; border: 1px solid #999; }
code, kbd, samp { font-family: monospace; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #999; padding: 0.2em 0.4em; vertical-align: top; text-align: left; }
caption { font-style: italic; }
ul, ol { margin: 0.5em 0 0.8em 0; padding-left: 1.5em; }
li { margin: 0.2em 0; }
hr { border: 0; border-top: 1px solid #999; margin: 1.5em 0; }
sup, sub { font-size: 0.75em; line-height: 0; }
.title-block { margin-bottom: 1.5em; }
.title-block h1 { margin-top: 0; }
.byline { font-style: italic; margin: 0 0 0.3em 0; }
.source, .date { font-size: 0.9em; margin: 0 0 0.3em 0; }
`;

export async function buildEpub(article: Article): Promise<KindleDocument> {
  const title = cleanText(article.title) || 'Untitled';
  const lang = normaliseLang(article.lang);
  const byline = cleanText(article.byline);
  const siteName = cleanText(article.siteName);
  const sourceUrl = safeHttpUrl(article.url);
  const date = isoDate(article.publishedTime);
  const uuid = randomUUID();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const { bodyXhtml, headings } = contentToXhtml(article.contentHtml ?? '');

  const titleBlock = [
    `<div class="title-block">`,
    `<h1 id="${TITLE_ID}">${esc(title)}</h1>`,
    byline ? `<p class="byline">${esc(/^by\s/i.test(byline) ? byline : `By ${byline}`)}</p>` : '',
    siteName || sourceUrl
      ? `<p class="source">${[
          siteName ? esc(siteName) : '',
          sourceUrl ? `<a href="${esc(sourceUrl)}">${esc(displayHost(sourceUrl))}</a>` : '',
        ]
          .filter(Boolean)
          .join(' · ')}</p>`
      : '',
    date ? `<p class="date">${esc(formatDate(date, lang))}</p>` : '',
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');

  const contentXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${titleBlock}
<div class="article">
${bodyXhtml}
</div>
</body>
</html>
`;

  const toc: TocEntry[] = [{ id: TITLE_ID, text: title, children: [] }];
  for (const h of headings) {
    if (h.level === 3 && toc.length > 1) toc[toc.length - 1].children.push({ ...h, children: [] });
    else toc.push({ ...h, children: [] });
  }

  const navXhtml = buildNav(title, lang, toc);
  const ncx = buildNcx(title, uuid, toc);
  const opf = buildOpf({ title, lang, uuid, modified, byline, siteName, sourceUrl, date });

  const zip = new JSZip();
  // mimetype must be first and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', createFolders: false });
  zip.file('META-INF/container.xml', CONTAINER_XML, { createFolders: false });
  zip.file('OEBPS/content.opf', opf, { createFolders: false });
  zip.file('OEBPS/nav.xhtml', navXhtml, { createFolders: false });
  zip.file('OEBPS/toc.ncx', ncx, { createFolders: false });
  zip.file('OEBPS/style.css', EPUB_CSS, { createFolders: false });
  zip.file('OEBPS/content.xhtml', contentXhtml, { createFolders: false });

  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    mimeType: 'application/epub+zip',
    platform: 'UNIX',
  });

  return {
    filename: `${slugify(cleanText(article.title))}.epub`,
    contentType: 'application/epub+zip',
    data,
    title,
  };
}

// ---------------------------------------------------------------------------
// Body conversion

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}
interface TocEntry {
  id: string;
  text: string;
  children: TocEntry[];
}

/** Parse an HTML fragment and serialise it as well-formed XHTML body content. */
export function contentToXhtml(html: string): { bodyXhtml: string; headings: Heading[] } {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
  try {
    const doc = dom.window.document;
    const body = doc.body;
    body.innerHTML = html; // scripting is disabled; nothing executes

    // Comments / processing instructions out (a "--" inside a comment is not XML-safe).
    const walker = doc.createTreeWalker(body, 128 | 64 /* SHOW_COMMENT | SHOW_PROCESSING_INSTRUCTION */);
    const junk: Node[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) junk.push(n);
    junk.forEach((n) => n.parentNode?.removeChild(n));

    body.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());

    // Elements: unwrap invalid / non-XHTML ones, scrub attributes.
    for (const el of Array.from(body.querySelectorAll('*'))) {
      const name = el.localName;
      if (!XML_NAME.test(name) || el.namespaceURI !== XHTML_NS || UNWRAP_TAGS.has(name)) {
        unwrap(el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const n = attr.name.toLowerCase();
        if (
          !XML_NAME.test(attr.name) ||
          n.startsWith('on') ||
          n === 'style' ||
          n === 'xmlns' ||
          (n === 'href' && !safeHref(attr.value))
        ) {
          el.removeAttribute(attr.name);
          continue;
        }
        const cleaned = attr.value.replace(INVALID_XML_CHARS, '');
        if (cleaned !== attr.value) el.setAttribute(attr.name, cleaned);
      }
      if (name === 'a' && el.hasAttribute('href')) {
        el.setAttribute('href', normaliseHref(el.getAttribute('href') ?? ''));
      }
    }

    // Ids: must be unique, non-empty, whitespace-free, and not collide with ours.
    const seen = new Set<string>([TITLE_ID]);
    body.querySelectorAll('[id]').forEach((el) => {
      const id = el.getAttribute('id') ?? '';
      if (!id || /\s/.test(id) || seen.has(id) || !/^[A-Za-z_]/.test(id)) el.removeAttribute('id');
      else seen.add(id);
    });
    // Fragment links must point at surviving ids.
    body.querySelectorAll('a[href^="#"]').forEach((a) => {
      const target = decodeFrag((a.getAttribute('href') ?? '').slice(1));
      if (!seen.has(target) || target === TITLE_ID) unwrap(a);
      else a.setAttribute('href', '#' + target);
    });

    // Headings for the table of contents.
    const headings: Heading[] = [];
    let counter = 0;
    body.querySelectorAll('h2, h3').forEach((h) => {
      const text = cleanText(h.textContent);
      if (!text) return;
      let id = h.getAttribute('id');
      if (!id) {
        do id = `h2k-sec-${++counter}`;
        while (seen.has(id));
        seen.add(id);
        h.setAttribute('id', id);
      }
      headings.push({ id, text: text.slice(0, 200), level: h.localName === 'h2' ? 2 : 3 });
    });

    // Text: strip characters XML 1.0 forbids.
    const tw = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const v = n.nodeValue ?? '';
      const cleaned = v.replace(INVALID_XML_CHARS, '');
      if (cleaned !== v) n.nodeValue = cleaned;
    }

    const serializer = new dom.window.XMLSerializer();
    const parts = Array.from(body.childNodes).map((n) => serializer.serializeToString(n));
    // Each top-level element carries a redundant xmlns (the document default); drop it.
    const bodyXhtml = parts
      .map((s) => s.replace(/^(<[A-Za-z][A-Za-z0-9._-]*) xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/, '$1'))
      .join('');
    return { bodyXhtml, headings };
  } finally {
    dom.window.close();
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function decodeFrag(f: string): string {
  try {
    return decodeURIComponent(f);
  } catch {
    return f;
  }
}

function safeHref(href: string): boolean {
  const h = href.trim();
  if (h.startsWith('#')) return h.length > 1;
  try {
    const u = new URL(h);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false; // relative links have nothing to point at inside the EPUB
  }
}

function normaliseHref(href: string): string {
  const h = href.trim();
  if (h.startsWith('#')) return h;
  try {
    return new URL(h).href; // percent-encodes spaces and other illegal characters
  } catch {
    return h;
  }
}

// ---------------------------------------------------------------------------
// Package documents

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

interface OpfInput {
  title: string;
  lang: string;
  uuid: string;
  modified: string;
  byline: string;
  siteName: string;
  sourceUrl?: string;
  date?: string;
}

function buildOpf(m: OpfInput): string {
  const meta = [
    `<dc:identifier id="bookid">urn:uuid:${m.uuid}</dc:identifier>`,
    `<dc:title>${esc(m.title)}</dc:title>`,
    `<dc:language>${esc(m.lang)}</dc:language>`,
    m.byline ? `<dc:creator id="creator">${esc(m.byline)}</dc:creator>` : '',
    m.siteName ? `<dc:publisher>${esc(m.siteName)}</dc:publisher>` : '',
    m.sourceUrl ? `<dc:source>${esc(m.sourceUrl)}</dc:source>` : '',
    m.date ? `<dc:date>${esc(m.date)}</dc:date>` : '',
    `<meta property="dcterms:modified">${m.modified}</meta>`,
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(m.lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${meta.join('\n    ')}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>
`;
}

function buildNav(title: string, lang: string, toc: TocEntry[]): string {
  const render = (entries: TocEntry[], indent: string): string =>
    `${indent}<ol>\n` +
    entries
      .map((e) => {
        const link = `<a href="content.xhtml#${esc(e.id)}">${esc(e.text)}</a>`;
        return e.children.length
          ? `${indent}  <li>${link}\n${render(e.children, indent + '    ')}${indent}  </li>\n`
          : `${indent}  <li>${link}</li>\n`;
      })
      .join('') +
    `${indent}</ol>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
${render(toc, '')}</nav>
</body>
</html>
`;
}

function buildNcx(title: string, uuid: string, toc: TocEntry[]): string {
  let order = 0;
  let depth = 1;
  const render = (entries: TocEntry[], level: number, indent: string): string =>
    entries
      .map((e) => {
        depth = Math.max(depth, level);
        const n = ++order;
        return (
          `${indent}<navPoint id="np-${n}" playOrder="${n}">\n` +
          `${indent}  <navLabel><text>${esc(e.text)}</text></navLabel>\n` +
          `${indent}  <content src="content.xhtml#${esc(e.id)}"/>\n` +
          render(e.children, level + 1, indent + '  ') +
          `${indent}</navPoint>\n`
        );
      })
      .join('');
  const points = render(toc, 1, '    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="${depth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
${points}  </navMap>
</ncx>
`;
}

// ---------------------------------------------------------------------------
// Helpers

/** XML-escape text or an attribute value (also strips XML-illegal characters). */
export function esc(s: string): string {
  return s
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(INVALID_XML_CHARS, '').replace(/\s+/g, ' ').trim();
}

function normaliseLang(lang?: string): string {
  const l = (lang ?? '').trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(l) ? l : 'en';
}

function safeHttpUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** W3C-style date (YYYY-MM-DD or full ISO) or undefined. */
function isoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  if (y < 1000 || y > 9999) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatDate(iso: string, lang: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

/** ASCII-safe filename stem from a title, max 80 chars, fallback "article". */
export function slugify(title: string): string {
  const ascii = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = ascii;
  if (slug.length > 80) {
    slug = slug.slice(0, 80);
    const cut = slug.lastIndexOf('-');
    if (cut >= 40) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/g, '');
  }
  return slug || 'article';
}
