#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { handleSend } from './pipeline.js';
import { UserError, type SendRequest } from './types.js';

const USAGE = `Usage: html2kindle <url-or-file> [--download [outPath]] [--title TITLE]

  <url-or-file>      http(s) URL, or a local .pdf/.html/.epub/.txt file
  --download [path]  write the document locally instead of emailing it
  --title TITLE      override the document title
`;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.rtf': 'application/rtf',
};

export async function main(argv: string[]): Promise<number> {
  let input: string | undefined;
  let title: string | undefined;
  let download = false;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    } else if (a === '--title') {
      title = argv[++i];
      if (!title) {
        console.error('Error: --title needs a value');
        return 2;
      }
    } else if (a === '--download') {
      download = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && input !== undefined) outPath = argv[++i];
    } else if (a.startsWith('--')) {
      console.error(`Error: unknown option ${a}\n\n${USAGE}`);
      return 2;
    } else if (input === undefined) input = a;
    else {
      console.error(`Error: unexpected argument ${a}\n\n${USAGE}`);
      return 2;
    }
  }
  if (!input) {
    console.error(USAGE);
    return 2;
  }
  const cfg = loadConfig();
  const req: SendRequest = { title };
  if (/^https?:\/\//i.test(input)) req.url = input;
  else {
    let data: Buffer;
    try {
      data = await readFile(input);
    } catch {
      console.error(`Error: cannot read file "${input}"`);
      return 2;
    }
    req.file = { filename: basename(input), contentType: MIME[extname(input).toLowerCase()] ?? '', data };
  }
  try {
    const { result, doc } = await handleSend(req, download ? 'download' : 'email', cfg);
    if (download) {
      const target = resolve(outPath ?? doc.filename);
      await writeFile(target, doc.data);
      console.log(`Saved "${doc.title}" to ${target} (${doc.data.length} bytes)`);
    } else {
      console.log(`Sent "${result.title}" to Kindle (${result.bytes} bytes)`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`Error: ${err.message}`);
      return err.status >= 500 ? 1 : 2;
    }
    console.error('Error: unexpected failure', err);
    return 1;
  }
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
