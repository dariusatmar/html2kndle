/**
 * HTML page -> readable, text-only Article.
 *
 * Uses Mozilla Readability on a script-less JSDOM, with a simple
 * <article>/<main>/<body> fallback, then sanitises the result down to an
 * allowlist of semantic elements and attributes.
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { UserError, type Article } from './types.js';

/** Inputs bigger than this get their (non JSON-LD) scripts/styles stripped by regex before parsing. */
const PRESTRIP_THRESHOLD = 2_000_000;
/** Hard cap on what we are willing to hand to the HTML parser. */
const MAX_PARSE_CHARS = 20_000_000;
/** Below this many characters of body text we consider extraction to have failed. */
const MIN_TEXT = 50;
/** Readability results shorter than this make us also try the simple fallback. */
const READABILITY_MIN_TEXT = 200;

/** Elements removed together with their content. */
const DROP_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'title', 'head', 'template',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'progress', 'meter',
  'svg', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area',
  'img', 'picture', 'image', 'noscript', 'dialog', 'nav', 'menu', 'portal', 'slot',
]);

/** Elements kept as-is (attributes filtered by ALLOWED_ATTRS). Anything else is unwrapped. */
const KEEP_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'code', 'kbd', 'samp', 'var', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sup', 'sub', 'br', 'hr',
  'a', 'abbr', 'cite', 'q', 'dfn', 'time', 'div', 'section', 'article', 'aside',
]);

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  abbr: ['title'],
  dfn: ['title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  time: ['datetime'],
};
const GLOBAL_ATTRS = ['lang', 'dir'];

const TEXT_NODE = 3;

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

export function extractArticle(html: string, url?: string, titleOverride?: string): Article {
  if (typeof html !== 'string') html = String(html ?? '');
  if (html.length > PRESTRIP_THRESHOLD) html = prestrip(html);
  if (html.length > MAX_PARSE_CHARS) {
    throw new UserError('This page is too large to convert', 413);
  }

  const baseUrl = normaliseUrl(url);
  // No runScripts and no resources: page scripts are never executed or fetched.
  const dom = new JSDOM(html, baseUrl ? { url: baseUrl } : {});
  const doc = dom.window.document;

  // Metadata from the untouched document (Readability mutates its input).
  const meta = readMeta(doc);

  let readable: ReturnType<Readability['parse']> = null;
  try {
    const clone = doc.cloneNode(true) as Document;
    readable = new Readability(clone, { charThreshold: 500 }).parse();
  } catch {
    readable = null;
  }

  let container: HTMLElement | null = null;
  let text = '';
  if (readable?.content) {
    container = doc.createElement('div');
    container.innerHTML = readable.content; // scripting disabled: nothing executes
    sanitize(container, baseUrl);
    text = collapse(container.textContent);
  }

  if (!container || text.length < READABILITY_MIN_TEXT) {
    const fb = fallbackContainer(doc);
    if (fb) {
      sanitize(fb, baseUrl);
      const fbText = collapse(fb.textContent);
      if (fbText.length > text.length) {
        container = fb;
        text = fbText;
      }
    }
  }

  if (!container || text.length < MIN_TEXT) {
    throw new UserError('Could not find readable text on this page', 422);
  }

  const title =
    collapse(titleOverride) ||
    collapse(readable?.title) ||
    meta.ogTitle ||
    meta.docTitle ||
    'Untitled';

  const article: Article = {
    title: title.slice(0, 500),
    lang: normaliseLang(meta.lang),
    contentHtml: container.innerHTML,
    textLength: text.length,
  };
  const byline = collapse(readable?.byline) || meta.author;
  if (byline) article.byline = byline.slice(0, 300);
  const siteName = collapse(readable?.siteName) || meta.siteName;
  if (siteName) article.siteName = siteName.slice(0, 200);
  if (baseUrl) article.url = baseUrl;
  const published = normaliseDate(readable?.publishedTime) ?? normaliseDate(meta.publishedTime);
  if (published) article.publishedTime = published;

  dom.window.close();
  return article;
}

/** Cheap pre-pass for huge pages: drop executable scripts and styles (keep JSON-LD, used for metadata). */
function prestrip(html: string): string {
  return html
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (m, attrs: string) =>
      /application\/ld\+json/i.test(attrs) && m.length < 200_000 ? m : '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function normaliseUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* ignore */
  }
  return undefined;
}

function normaliseLang(lang?: string): string {
  const l = (lang ?? '').trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(l) ? l : 'en';
}

function normaliseDate(value?: string | null): string | undefined {
  const v = collapse(value);
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  if (y < 1000 || y > 9999) return undefined;
  return d.toISOString();
}

interface PageMeta {
  lang?: string;
  ogTitle?: string;
  docTitle?: string;
  author?: string;
  siteName?: string;
  publishedTime?: string;
}

function readMeta(doc: Document): PageMeta {
  const metaContent = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      for (const el of Array.from(doc.querySelectorAll('meta'))) {
        const name = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').toLowerCase();
        if (name === key) {
          const c = collapse(el.getAttribute('content'));
          if (c) return c;
        }
      }
    }
    return undefined;
  };
  return {
    lang: doc.documentElement?.getAttribute('lang') ?? undefined,
    ogTitle: metaContent('og:title', 'twitter:title'),
    docTitle: collapse(doc.querySelector('title')?.textContent) || undefined,
    author: metaContent('author', 'article:author'),
    siteName: metaContent('og:site_name'),
    publishedTime: metaContent('article:published_time', 'og:published_time', 'date', 'dc.date'),
  };
}

/** Simple fallback: biggest <article>, else <main>, else <body>, minus page chrome. */
function fallbackContainer(doc: Document): HTMLElement | null {
  const textLen = (el: Element) => collapse(el.textContent).length;
  const articles = Array.from(doc.querySelectorAll('article'));
  let root: Element | null = null;
  if (articles.length) {
    root = articles.reduce((a, b) => (textLen(b) > textLen(a) ? b : a));
  }
  root ??= doc.querySelector('main') ?? doc.querySelector('[role="main"]') ?? doc.body;
  if (!root) return null;
  const clone = root.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      'nav, header, footer, aside, script, style, noscript, form, ' +
        '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"], [hidden]',
    )
    .forEach((el) => el.remove());
  const wrapper = doc.createElement('div');
  wrapper.appendChild(clone);
  return wrapper;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Sanitise `root` in place down to text-only semantic HTML. */
function sanitize(root: HTMLElement, baseUrl?: string): void {
  const doc = root.ownerDocument;

  // 1. Comments out.
  const comments: Node[] = [];
  const walker = doc.createTreeWalker(root, 128 /* SHOW_COMMENT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  // 2. MathML -> its text alternative.
  root.querySelectorAll('math').forEach((m) => {
    const alt =
      m.getAttribute('alttext') ??
      m.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
      m.textContent;
    m.replaceWith(doc.createTextNode(collapse(alt)));
  });

  // 3. Media and widgets out.
  root.querySelectorAll(Array.from(DROP_TAGS).join(',')).forEach((el) => el.remove());

  // 4. Figures: keep only their caption text, if any.
  root.querySelectorAll('figure').forEach((fig) => {
    const caption = fig.querySelector('figcaption');
    const captionText = collapse(caption?.textContent);
    const otherText = collapse(
      Array.from(fig.childNodes)
        .filter((n) => n !== caption)
        .map((n) => n.textContent ?? '')
        .join(' '),
    );
    if (!captionText && !otherText) {
      fig.remove();
      return;
    }
    if (caption && !otherText) {
      const p = doc.createElement('p');
      const em = doc.createElement('em');
      while (caption.firstChild) em.appendChild(caption.firstChild);
      p.appendChild(em);
      fig.replaceWith(p);
    } else {
      unwrap(fig); // e.g. a figure wrapping a blockquote or a code listing
    }
  });
  // Captions left outside a figure become plain paragraphs.
  root.querySelectorAll('figcaption').forEach((cap) => {
    const p = doc.createElement('p');
    while (cap.firstChild) p.appendChild(cap.firstChild);
    cap.replaceWith(p);
  });

  // 5. Old-style <a name="x"> anchors become ids so fragment links can target them.
  root.querySelectorAll('a[name]').forEach((a) => {
    if (!a.getAttribute('id')) a.setAttribute('id', a.getAttribute('name') ?? '');
  });

  // 6. Unwrap unknown elements, filter attributes (ids kept for now).
  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all) {
    const tag = el.localName.toLowerCase();
    if (!KEEP_TAGS.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      // Keep a target id alive if the element carried one.
      const id = el.getAttribute('id');
      if (id && el.parentNode) {
        const marker = doc.createElement('span');
        marker.setAttribute('id', id);
        el.parentNode.insertBefore(marker, el);
      }
      unwrap(el);
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag] ?? [];
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'id' || allowed.includes(name) || GLOBAL_ATTRS.includes(name)) continue;
      el.removeAttribute(attr.name);
    }
  }

  // 7. Links.
  const pageNoHash = baseUrl ? baseUrl.replace(/#.*$/, '') : undefined;
  const fragmentLinks: { a: Element; target: string }[] = [];
  root.querySelectorAll('a').forEach((a) => {
    const raw = (a.getAttribute('href') ?? '').trim();
    if (!raw) {
      a.removeAttribute('href');
      return;
    }
    if (raw.startsWith('#')) {
      fragmentLinks.push({ a, target: decodeFragment(raw.slice(1)) });
      return;
    }
    let abs: URL | undefined;
    try {
      abs = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    } catch {
      abs = undefined;
    }
    if (!abs || !['http:', 'https:', 'mailto:'].includes(abs.protocol)) {
      unwrap(a); // javascript:, data:, unresolvable relative links...
      return;
    }
    if (pageNoHash && abs.hash && abs.href.replace(/#.*$/, '') === pageNoHash) {
      a.setAttribute('href', abs.hash);
      fragmentLinks.push({ a, target: decodeFragment(abs.hash.slice(1)) });
      return;
    }
    a.setAttribute('href', abs.href);
  });

  // 8. Fragment links survive only if their target does; then drop unreferenced ids.
  const ids = new Set<string>();
  root.querySelectorAll('[id]').forEach((el) => ids.add(el.getAttribute('id') ?? ''));
  const referenced = new Set<string>();
  for (const { a, target } of fragmentLinks) {
    if (target && ids.has(target)) {
      referenced.add(target);
      a.setAttribute('href', '#' + target);
    } else {
      unwrap(a);
    }
  }
  root.querySelectorAll('[id]').forEach((el) => {
    if (!referenced.has(el.getAttribute('id') ?? '')) el.removeAttribute('id');
  });
  // Anchors that are neither links nor targets, and spans left only as markers, are noise.
  root.querySelectorAll('a:not([href]):not([id])').forEach(unwrap);
  root.querySelectorAll('span:not([id])').forEach(unwrap);

  // 9. Remove now-empty block/inline containers (keeps anything that is a link target).
  const emptyCandidates = 'p, div, section, article, aside, blockquote, li, em, strong, b, i, u, s, small, mark, h1, h2, h3, h4, h5, h6, cite, q, a';
  for (let pass = 0; pass < 3; pass++) {
    let removed = 0;
    root.querySelectorAll(emptyCandidates).forEach((el) => {
      if (el.hasAttribute('id') || el.querySelector('[id], br, hr, table')) return;
      if (collapse(el.textContent) === '') {
        el.remove();
        removed++;
      }
    });
    if (!removed) break;
  }

  // 10. Collapse runs of whitespace-only text between blocks (smaller output).
  root.normalize();
  const texts: Node[] = [];
  const tw = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n);
  for (const t of texts) {
    if (t.nodeType !== TEXT_NODE) continue;
    if (t.parentElement?.closest('pre')) continue;
    const v = t.nodeValue ?? '';
    if (/^\s+$/.test(v) && v.length > 1) t.nodeValue = v.includes('\n') ? '\n' : ' ';
  }
}

function decodeFragment(f: string): string {
  try {
    return decodeURIComponent(f);
  } catch {
    return f;
  }
}
