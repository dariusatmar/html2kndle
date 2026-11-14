import type { Config } from './config.js';
import { buildEpub } from './epub.js';
import { extractArticle } from './extract.js';
import { fetchSource, sourceFromUpload } from './fetch.js';
import { sendToKindle } from './mailer.js';
import { UserError, type Delivery, type KindleDocument, type SendRequest, type SendResult, type Source } from './types.js';

async function resolveSource(req: SendRequest, cfg: Config): Promise<Source> {
  if (req.file) return sourceFromUpload(req.file);
  if (req.html && req.html.trim()) return { kind: 'html', html: req.html, url: req.url?.trim() || undefined };
  if (req.url && req.url.trim()) return fetchSource(req.url, cfg);
  throw new UserError('Provide a url, html, or a file', 400);
}

export async function prepareDocument(req: SendRequest, cfg: Config): Promise<KindleDocument> {
  const src = await resolveSource(req, cfg);
  const title = req.title?.trim() || undefined;
  switch (src.kind) {
    case 'html': {
      const article = extractArticle(src.html, src.url, title);
      return buildEpub(article);
    }
    case 'pdf':
      return {
        filename: src.filename,
        contentType: 'application/pdf',
        data: src.data,
        title: title ?? src.filename.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() ?? src.filename,
      };
    case 'passthrough':
      return {
        filename: src.filename,
        contentType: src.contentType,
        data: src.data,
        title: title ?? src.filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(),
      };
  }
}

export async function handleSend(
  req: SendRequest,
  delivery: Delivery,
  cfg: Config,
): Promise<{ result: SendResult; doc: KindleDocument }> {
  const doc = await prepareDocument(req, cfg);
  const result: SendResult = { ok: true, title: doc.title, filename: doc.filename, bytes: doc.data.length, delivery };
  if (delivery === 'email') {
    const { messageId } = await sendToKindle(doc, cfg);
    result.messageId = messageId;
  }
  return { result, doc };
}
