import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractArticle } from '../src/extract.js';
import { UserError } from '../src/types.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BLOG_URL = 'https://blog.example.com/2024/03/slowness/';

const blog = () => extractArticle(fixture('blog-essay.html'), BLOG_URL);
const fragment = (html: string) => JSDOM.fragment(`<div>${html}</div>`).firstElementChild as Element;

test('blog essay: metadata', () => {
  const a = blog();
  assert.equal(a.title, 'On Slowness & Attention');
  assert.equal(a.byline, 'Zoë Brontë');
  assert.equal(a.siteName, 'The Quiet Blog');
  assert.equal(a.lang, 'en-GB');
  assert.equal(a.url, BLOG_URL);
  assert.equal(a.publishedTime, '2024-03-05T09:30:00.000Z');
  assert.ok(a.textLength > 1500, `textLength ${a.textLength}`);
});

test('blog essay: body text, structure and non-ASCII retained', () => {
  const { contentHtml } = blog();
  const root = fragment(contentHtml);
  const text = root.textContent ?? '';
  assert.match(text, /particular kind of quiet/);
  assert.match(text, /reclaim the pauses between them/);
  assert.match(text, /Café Ünter den Linden/);
  assert.match(text, /Søren/);
  assert.match(text, /日本語のテキストもここにあります/);
  assert.match(text, /3€ & go up to 5€/);
  assert.match(text, /Keep a paper notebook for stray thoughts <no apps>/);
  assert.match(text, /Figure 1: Hours of deep work/, 'figcaption text kept');
  assert.match(text, /Share this post/, 'javascript: link text kept');
  for (const sel of ['h2', 'h3', 'blockquote', 'ol', 'li', 'pre code', 'table', 'th', 'td', 'em', 'strong', 'sup', 'sub', 'hr']) {
    assert.ok(root.querySelector(sel), `expected <${sel}>`);
  }
  // &nbsp; survives as a character (the EPUB builder is responsible for XML-safe output)
  assert.ok(text.includes('when nobody'));
});

test('blog essay: clutter, scripts and media removed', () => {
  const { contentHtml } = blog();
  const root = fragment(contentHtml);
  const text = root.textContent ?? '';
  for (const junk of ['ADVERTISEMENT', 'FOOTER-MARKER', 'Popular posts', 'Ten productivity hacks', 'Subscribe to the newsletter', 'INJECTED BY SCRIPT', 'trackFooter', '__TRACK__', 'font-family']) {
    assert.ok(!text.includes(junk), `should not contain ${junk}`);
  }
  for (const tag of ['script', 'style', 'iframe', 'form', 'input', 'button', 'svg', 'canvas', 'video', 'audio', 'img', 'picture', 'noscript', 'nav', 'figure', 'link', 'meta', 'span']) {
    assert.equal(root.querySelector(tag), null, `<${tag}> should be gone`);
  }
});

test('blog essay: attributes stripped', () => {
  const root = fragment(blog().contentHtml);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      assert.ok(
        !/^(on|data-)/i.test(attr.name) && !['style', 'class', 'src', 'srcset', 'rel'].includes(attr.name),
        `<${el.localName} ${attr.name}> should be stripped`,
      );
    }
  }
  assert.ok(root.querySelector('em[lang="ja"]'), 'lang attribute kept');
});

test('blog essay: links absolutised, javascript: and dead fragments unwrapped, footnotes kept', () => {
  const root = fragment(blog().contentHtml);
  const hrefs = Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');
  assert.ok(hrefs.includes('https://blog.example.com/2024/03/notes/residue.html'));
  assert.ok(hrefs.includes('https://blog.example.com/archive/2023/focus/'));
  assert.ok(hrefs.includes('https://example.org/papers/leroy-2009.pdf'));
  for (const h of hrefs) {
    assert.ok(/^(https?:|mailto:|#)/.test(h), `unexpected href ${h}`);
    assert.ok(!h.startsWith('javascript:'));
  }
  // footnote reference and back-reference both survive with their targets
  assert.ok(hrefs.includes('#fn1'));
  assert.ok(hrefs.includes('#fnref1'));
  assert.ok(root.querySelector('[id="fn1"]'));
  assert.ok(root.querySelector('[id="fnref1"]'));
  // a link to a missing target is unwrapped but its text kept
  assert.ok(!hrefs.includes('#does-not-exist'));
  assert.match(root.textContent ?? '', /a section that was removed/);
  // ids that nothing links to are dropped
  const ids = Array.from(root.querySelectorAll('[id]')).map((e) => e.id).sort();
  assert.deepEqual(ids, ['fn1', 'fnref1']);
});

test('title override wins, and title falls back sensibly', () => {
  assert.equal(extractArticle(fixture('blog-essay.html'), BLOG_URL, '  My   Title ').title, 'My Title');
  assert.equal(extractArticle(fixture('blog-essay.html'), BLOG_URL, '   ').title, 'On Slowness & Attention');
  const noTitle = `<html><body><p>${'Some words that make up a paragraph of real text. '.repeat(5)}</p></body></html>`;
  assert.equal(extractArticle(noTitle).title, 'Untitled');
});

test('minimal page without <article> still extracts', () => {
  const a = extractArticle(fixture('minimal.html'), 'https://home.example.com/~me/notes.html');
  assert.equal(a.title, 'Notes on a Minimal Page');
  assert.equal(a.lang, 'en');
  const root = fragment(a.contentHtml);
  assert.match(root.textContent ?? '', /hand-written HTML/);
  const hrefs = Array.from(root.querySelectorAll('a[href]')).map((x) => x.getAttribute('href'));
  assert.ok(hrefs.includes('https://home.example.com/~me/other.html'));
  assert.ok(hrefs.includes('mailto:me@example.com'));
});

test('fallback path used when Readability finds too little', () => {
  const html = `<html><body><nav>Menu Menu</nav><main><p>Short but real text, enough to pass the minimum threshold here.</p></main><footer>Footer junk</footer></body></html>`;
  const a = extractArticle(html, 'https://x.example/');
  assert.match(a.contentHtml, /Short but real text/);
  assert.ok(!a.contentHtml.includes('Footer junk'));
  assert.ok(!a.contentHtml.includes('Menu Menu'));
});

test('empty / JS-only page throws UserError 422', () => {
  for (const html of [fixture('empty-js.html'), '', '<html><body>   </body></html>', '<p>hi</p>']) {
    assert.throws(
      () => extractArticle(html, 'https://app.example.com/'),
      (err: unknown) => err instanceof UserError && err.status === 422 && /readable text/.test(err.message),
    );
  }
});

test('relative links are unwrapped when there is no base URL; bad URLs are ignored', () => {
  const html = `<html><body><article><p>${'Text that is long enough to count as an article body. '.repeat(6)}<a href="/rel">relative</a> <a href="https://abs.example/">absolute</a></p></article></body></html>`;
  for (const url of [undefined, 'not a url', 'ftp://example.com/x']) {
    const a = extractArticle(html, url);
    assert.equal(a.url, undefined);
    assert.ok(!a.contentHtml.includes('href="/rel"'));
    assert.match(a.contentHtml, /relative/);
    assert.match(a.contentHtml, /href="https:\/\/abs\.example\/"/);
  }
});

test('malformed HTML and weird lang are handled', () => {
  const html = `<html lang="not a lang!"><body><div><p>Unclosed <b>bold <i>italic</p><p>${'More body text for the reader to enjoy. '.repeat(8)}<table><tr><td>cell</div></body>`;
  const a = extractArticle(html);
  assert.equal(a.lang, 'en');
  assert.match(a.contentHtml, /More body text/);
});

test('page scripts never execute', () => {
  const html = `<html><body><script>globalThis.__h2k_pwned = true;</script><article><p>${'Plenty of article text here for the parser. '.repeat(6)}</p><img src="x" onerror="globalThis.__h2k_pwned = true"></article></body></html>`;
  extractArticle(html, 'https://evil.example/');
  assert.equal((globalThis as Record<string, unknown>).__h2k_pwned, undefined);
});

test('large input is handled', () => {
  const para = `<p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}</p>`;
  const bigScript = `<script>${'var x = "' + 'a'.repeat(3_000_000) + '";'}</script>`;
  const html = `<html><head>${bigScript}</head><body><article>${para.repeat(300)}</article></body></html>`;
  const a = extractArticle(html, 'https://big.example/');
  assert.ok(a.textLength > 100_000);
  assert.ok(!a.contentHtml.includes('aaaaaaaa'));
});
