/**
 * Shared contracts for html2kindle. Every module codes against these types.
 *
 * Pipeline:  input (url | html | file) -> Source -> Document -> delivery (email | download)
 */

/** What the caller hands us. Exactly one of `url`, `html`, or `file` drives the run. */
export interface SendRequest {
  /** Page or PDF URL. Also used as the base URL / source link when `html` is supplied. */
  url?: string;
  /** Raw page HTML captured on the device (e.g. by the iOS Shortcut). Skips the network fetch. */
  html?: string;
  /** Uploaded file (PDF, HTML, EPUB, TXT). */
  file?: { filename: string; contentType: string; data: Buffer };
  /** Optional title override. */
  title?: string;
}

/** Raw bytes we ended up with after fetching / receiving an upload. */
export type Source =
  | { kind: 'html'; html: string; url?: string }
  | { kind: 'pdf'; data: Buffer; filename: string; url?: string }
  /** Already Kindle-ready (epub, txt, docx...): passed through untouched. */
  | { kind: 'passthrough'; data: Buffer; filename: string; contentType: string; url?: string };

/** Readable article extracted from an HTML page. */
export interface Article {
  title: string;
  byline?: string;
  siteName?: string;
  /** Source URL, if known. */
  url?: string;
  /** BCP-47 language tag, default "en". */
  lang: string;
  /** ISO date string if the page exposed one. */
  publishedTime?: string;
  /**
   * Cleaned article body as an HTML fragment (no <html>/<body>), text-only:
   * no scripts, styles, iframes, forms, images or media. Not necessarily
   * well-formed XML — the EPUB builder is responsible for XHTML serialisation.
   */
  contentHtml: string;
  /** Plain-text length of the body, for sanity checks / reading-time estimates. */
  textLength: number;
}

/** A file ready to be delivered to the Kindle. */
export interface KindleDocument {
  /** Safe filename including extension, e.g. "The-Title.epub". */
  filename: string;
  contentType: string;
  data: Buffer;
  /** Human title (shown in UI / used as email subject). */
  title: string;
}

export type Delivery = 'email' | 'download';

export interface SendResult {
  ok: true;
  title: string;
  filename: string;
  bytes: number;
  delivery: Delivery;
  /** Present for email deliveries. */
  messageId?: string;
}

/** Error with an HTTP status and a message that is safe to show the user. */
export class UserError extends Error {
  constructor(
    message: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** Module signatures (implemented in the named files). */
// src/extract.ts : export function extractArticle(html: string, url?: string, titleOverride?: string): Article
// src/epub.ts    : export function buildEpub(article: Article): Promise<KindleDocument>
// src/fetch.ts   : export function fetchSource(url: string, cfg: Config): Promise<Source>
//                  export function sourceFromUpload(file: NonNullable<SendRequest['file']>): Source
// src/mailer.ts  : export function sendToKindle(doc: KindleDocument, cfg: Config): Promise<{ messageId: string }>
// src/pipeline.ts: export function prepareDocument(req: SendRequest, cfg: Config): Promise<KindleDocument>
//                  export function handleSend(req: SendRequest, delivery: Delivery, cfg: Config): Promise<{ result: SendResult; doc: KindleDocument }>
