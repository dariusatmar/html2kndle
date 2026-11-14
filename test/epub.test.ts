import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { buildEpub } from '../src/epub.js';
import { extractArticle } from '../src/extract.js';
import type { Article } from '../src/types.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BLOG_URL = 'https://blog.example.com/2024/03/slowness/';

const EXPECTED_FILES = [
  'mimetype',
  'META-INF/container.xml',
  'OEBPS/content.opf',
  'OEBPS/nav.xhtml',
  'OEBPS/toc.ncx',
  'OEBPS/style.css',
  'OEBPS/content.xhtml',
];

function baseArticle(over: Partial<Article> = {}): Article {
  return {
    title: 'A Title',
    lang: 'en',
    contentHtml: '<p>Hello world, this is the body.</p>',
    textLength: 31,
    ...over,
  };
}

/** Parse as XML; JSDOM throws on any well-formedness error. */
function parseXml(xml: string, contentType: 'application/xhtml+xml' | 'text/xml' = 'text/xml'): Document {
  return new JSDOM(xml, { contentType }).window.document;
}

async function unpack(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  const files: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) files[name] = await zip.files[name].async('string');
  }
  return { zip, files };
}

/** Every XML file in the EPUB must be well-formed and contain no named entities beyond the XML five. */
function assertAllWellFormed(files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    if (!/\.(xhtml|opf|ncx|xml)$/.test(name)) continue;
    const ct = name.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/xml';
    assert.doesNotThrow(() => parseXml(body, ct), `${name} is not well-formed`);
    const named = body.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[A-Za-z0-9]+;/g);
    assert.equal(named, null, `${name} contains named entities: ${named?.join(', ')}`);
  }
}

test('blog essay -> EPUB: zip structure, mimetype first and STORED', async () => {
  const doc = await buildEpub(extractArticle(fixture('blog-essay.html'), BLOG_URL));
  assert.equal(doc.contentType, 'application/epub+zip');
  assert.equal(doc.filename, 'On-Slowness-Attention.epub');
  assert.equal(doc.title, 'On Slowness & Attention');

  const buf = doc.data;
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.equal(buf.readUInt16LE(8), 0, 'compression method STORE');
  assert.equal(buf.readUInt16LE(26), 8, 'file name length');
  assert.equal(buf.readUInt16LE(28), 0, 'no extra field');
  assert.equal(buf.subarray(30, 30 + 28).toString('ascii'), 'mimetypeapplication/epub+zip');

  const { zip, files } = await unpack(buf);
  assert.deepEqual(Object.keys(zip.files), EXPECTED_FILES);
  assert.equal(files.mimetype, 'application/epub+zip');
  assert.match(files['META-INF/container.xml'], /full-path="OEBPS\/content\.opf"/);
});

test('blog essay -> EPUB: every XML file well-formed, content correct', async () => {
  const doc = await buildEpub(extractArticle(fixture('blog-essay.html'), BLOG_URL));
  const { files } = await unpack(doc.data);
  assertAllWellFormed(files);

  const content = files['OEBPS/content.xhtml'];
  assert.ok(!content.includes('&nbsp;'));
  assert.ok(content.includes('when\u00A0nobody'), 'nbsp kept as a character');
  assert.match(content, /<hr\s*\/>/, 'void elements self-closed');
  assert.ok(!/<hr>/.test(content));

  const x = parseXml(content, 'application/xhtml+xml');
  assert.equal(x.documentElement.namespaceURI, 'http://www.w3.org/1999/xhtml');
  assert.equal(x.documentElement.getAttribute('xml:lang'), 'en-GB');
  assert.equal(x.querySelector('h1')?.textContent, 'On Slowness & Attention');
  assert.match(x.querySelector('.byline')?.textContent ?? '', /By Zoë Brontë/);
  assert.match(x.querySelector('.source')?.textContent ?? '', /The Quiet Blog/);
  assert.equal(x.querySelector('.source a')?.getAttribute('href'), BLOG_URL);
  assert.match(x.querySelector('.date')?.textContent ?? '', /2024/);
  assert.match(x.body.textContent ?? '', /日本語のテキストもここにあります/);
  assert.match(x.body.textContent ?? '', /a < b && c > d/);

  // h2/h3 get ids and appear in nav + ncx
  const heads = Array.from(x.querySelectorAll('h2, h3'));
  assert.equal(heads.length, 2);
  for (const h of heads) assert.ok(h.id, 'heading has id');
  for (const h of heads) {
    assert.ok(files['OEBPS/nav.xhtml'].includes(`content.xhtml#${h.id}`));
    assert.ok(files['OEBPS/toc.ncx'].includes(`content.xhtml#${h.id}`));
  }
  // every fragment link in content resolves
  const ids = new Set(Array.from(x.querySelectorAll('[id]')).map((e) => e.id));
  assert.equal(ids.size, x.querySelectorAll('[id]').length, 'ids unique');
  for (const a of Array.from(x.querySelectorAll('a[href^="#"]'))) {
    assert.ok(ids.has(a.getAttribute('href')!.slice(1)), `dangling ${a.getAttribute('href')}`);
  }

  // OPF metadata
  const opf = parseXml(files['OEBPS/content.opf']);
  const DC = 'http://purl.org/dc/elements/1.1/';
  const dc = (n: string) => opf.getElementsByTagNameNS(DC, n)[0]?.textContent;
  assert.match(dc('identifier') ?? '', /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(dc('title'), 'On Slowness & Attention');
  assert.equal(dc('language'), 'en-GB');
  assert.equal(dc('creator'), 'Zoë Brontë');
  assert.equal(dc('source'), BLOG_URL);
  const modified = Array.from(opf.getElementsByTagName('meta')).find((m) => m.getAttribute('property') === 'dcterms:modified');
  assert.match(modified?.textContent ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(files['OEBPS/content.opf'], /properties="nav"/);
  assert.match(files['OEBPS/content.opf'], /<spine toc="ncx">/);

  // ncx uid matches the identifier
  assert.ok(files['OEBPS/toc.ncx'].includes(`content="${dc('identifier')}"`));

  // CSS: no fixed font sizes for body text
  assert.ok(!/body\s*\{[^}]*font-size/.test(files['OEBPS/style.css']));
  assert.ok(!/\d+px\s*;?\s*\}?/.test(files['OEBPS/style.css'].replace(/border[^;]*;/g, '')));
});

test('article without h2/h3 gets a single TOC entry; no byline means no dc:creator', async () => {
  const doc = await buildEpub(baseArticle());
  const { files } = await unpack(doc.data);
  assertAllWellFormed(files);
  const nav = parseXml(files['OEBPS/nav.xhtml'], 'application/xhtml+xml');
  assert.equal(nav.querySelectorAll('nav li').length, 1);
  assert.equal(parseXml(files['OEBPS/toc.ncx']).getElementsByTagName('navPoint').length, 1);
  assert.ok(!files['OEBPS/content.opf'].includes('dc:creator'));
  assert.ok(!files['OEBPS/content.opf'].includes('dc:source'));
});

test('hostile / malformed contentHtml still yields well-formed XHTML', async () => {
  const contentHtml = [
    '<p>Entities: &nbsp;&copy;&mdash;&hellip;&eacute; &amp; &lt;tag&gt; &quot;q&quot; &apos;</p>',
    '<p>Unclosed <b>bold <i>both</p>',
    '<br><hr><p>a<br>b</p>',
    '<p title="a &quot;quoted&quot; <value> & more" data-x="1" onclick="evil()" style="color:red">attrs</p>',
    '<p foo"bar="x" 1bad="y" xml:lang="fr" xmlns:evil="http://x">bad attr names</p>',
    '<!-- a -- comment -->',
    '<script>alert(1)</script><style>p{}</style><img src=x onerror=alert(1)>',
    '<font color="red"><center>legacy</center></font>',
    '<foo:bar>namespaced tag</foo:bar>',
    '<p>control\u0001chars\u000Bhere\uFFFE and lone \uD800 surrogate</p>',
    '<a href="javascript:alert(1)">js link</a> <a href="relative.html">rel</a> <a href="https://ex.com/a b?x=1&y=2">spaces</a>',
    '<a href="#missing">dangling</a> <a href="#ok">ok</a> <span id="ok">target</span> <span id="ok">dup</span>',
    '<h2>One</h2><h3>One.a</h3><h2 id="h2k-title">Collides</h2><h2></h2>',
    '<table><tr><td>cell<td>cell2</table>',
    '<pre>  indented\n    code &lt;x&gt;</pre>',
  ].join('\n');
  const doc = await buildEpub(baseArticle({ contentHtml, title: 'Hostile <&> "test"', byline: 'by A & B' }));
  const { files } = await unpack(doc.data);
  assertAllWellFormed(files);
  const content = files['OEBPS/content.xhtml'];
  assert.ok(!/<script|<style|<img|onclick|onerror|javascript:|style="/i.test(content.split('</head>')[1]));
  assert.ok(!content.includes('\u0001'));
  assert.match(content, /href="https:\/\/ex\.com\/a%20b\?x=1&amp;y=2"/);
  const x = parseXml(content, 'application/xhtml+xml');
  assert.equal(x.querySelectorAll('[id="h2k-title"]').length, 1);
  assert.equal(x.querySelectorAll('[id="ok"]').length, 1);
  assert.equal(x.querySelector('a[href="#missing"]'), null);
  assert.ok(x.querySelector('a[href="#ok"]'));
  assert.match(x.querySelector('pre')?.textContent ?? '', /^ {2}indented\n {4}code <x>$/);
  assert.equal(x.querySelector('.byline')?.textContent, 'by A & B');
  const nav = parseXml(files['OEBPS/nav.xhtml'], 'application/xhtml+xml');
  // title + One (with nested One.a) + Collides; the empty h2 is skipped
  assert.equal(nav.querySelectorAll('nav > ol > li').length, 3);
  assert.equal(nav.querySelectorAll('nav ol ol li').length, 1);
});

test('unusual titles yield safe filenames and well-formed OPF', async () => {
  const cases: [string, RegExp | string][] = [
    ['🚀 Launch day! 🎉', 'Launch-day.epub'],
    ['AC/DC: Back in Black / Live', 'AC-DC-Back-in-Black-Live.epub'],
    [`"Quotes" & 'apostrophes' <tags>`, 'Quotes-apostrophes-tags.epub'],
    ['Crème brûlée à la façon de Zoë', 'Creme-brulee-a-la-facon-de-Zoe.epub'],
    ['', 'article.epub'],
    ['   ', 'article.epub'],
    ['日本語のタイトル', 'article.epub'],
    ['../../etc/passwd', 'etc-passwd.epub'],
    ['Word '.repeat(60), /^(Word-)*Word\.epub$/],
  ];
  for (const [title, expected] of cases) {
    const doc = await buildEpub(baseArticle({ title }));
    if (typeof expected === 'string') assert.equal(doc.filename, expected, `title ${JSON.stringify(title)}`);
    else assert.match(doc.filename, expected);
    assert.match(doc.filename, /^[A-Za-z0-9-]{1,80}\.epub$/);
    assert.ok(doc.title.length > 0);
    const { files } = await unpack(doc.data);
    assertAllWellFormed(files);
    const opf = parseXml(files['OEBPS/content.opf']);
    const dcTitle = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent;
    assert.equal(dcTitle, title.trim().replace(/\s+/g, ' ') || 'Untitled');
  }
});

test('odd metadata: bad lang, bad url, bad date are dropped or defaulted', async () => {
  const doc = await buildEpub(
    baseArticle({ lang: 'english please', url: 'javascript:alert(1)', publishedTime: 'yesterday-ish', siteName: 'Site <&>' }),
  );
  const { files } = await unpack(doc.data);
  assertAllWellFormed(files);
  assert.match(files['OEBPS/content.opf'], /<dc:language>en<\/dc:language>/);
  assert.ok(!files['OEBPS/content.opf'].includes('dc:source'));
  assert.ok(!files['OEBPS/content.opf'].includes('dc:date'));
  assert.ok(!files['OEBPS/content.xhtml'].includes('javascript:'));
  assert.match(files['OEBPS/content.xhtml'], /Site &lt;&amp;&gt;/);
});
