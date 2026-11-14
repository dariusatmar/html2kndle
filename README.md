# html2kindle

A small, self-hosted, single-user service. From your phone, send a web essay or a PDF to your Kindle.

- HTML pages are reduced to their readable text (Mozilla Readability), packaged as a text-only EPUB, and emailed to your Send-to-Kindle address.
- PDFs are emailed unchanged.
- EPUB, TXT, and DOCX uploads are passed through unchanged.
- Images are dropped in this version.

The service is a Node 22 + TypeScript HTTP server. It can also run in download-only mode, without email, if SMTP is not configured.

## How it works

1. You share a page or file from your phone (or paste a URL into the web page, or run the CLI).
2. The service fetches the page, or accepts the upload.
3. HTML is converted to a text-only EPUB. PDFs and other supported files are kept as they are.
4. The file is emailed to your Send-to-Kindle address through your SMTP account, or returned to you for download.

## Quick start

Requirements: Node 22 or later, and an SMTP account if you want email delivery.

```sh
git clone <this repository> html2kindle
cd html2kindle
npm install
cp .env.example .env     # then edit .env
npm run build
node --env-file=.env dist/server.js
```

Node does not load `.env` automatically. Use `node --env-file=.env` as shown, or pass the variables in your environment another way.

The server serves `public/index.html`, so `public/` must exist next to `dist/` at runtime. Running from the repository root satisfies this.

Open `http://localhost:8787/` to check that the web page loads, and `http://localhost:8787/healthz` to check the service.

## Amazon setup

1. Find your Send-to-Kindle address: on Amazon, go to **Manage Your Content and Devices**, then **Preferences**, then **Personal Document Settings**. Under Send-to-Kindle Email Settings, your address ends in `@kindle.com`. Put it in `KINDLE_EMAIL`.
2. Approve the sender: on the same page, add the address you send from (`FROM_EMAIL`, which defaults to `SMTP_USER`) to the **Approved Personal Document E-mail List**. Amazon rejects mail from senders that are not on this list.

## SMTP setup (Gmail example)

Gmail requires an App Password, which requires 2-Step Verification on the account.

1. Turn on 2-Step Verification in your Google account.
2. Create an App Password in your Google account security settings.
3. Set these in `.env`:

```sh
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<the 16-character App Password>
FROM_EMAIL=you@gmail.com
KINDLE_EMAIL=you@kindle.com
```

4. Add `you@gmail.com` to the Approved Personal Document E-mail List, as described above.

Port 587 uses STARTTLS, so `SMTP_SECURE` stays off. Use port 465 with `SMTP_SECURE=true` if your provider requires implicit TLS.

## Deploying

The service must be reachable from your phone over HTTPS. Any of these work:

- Docker on a small host (a VPS, or a platform such as Fly.io or Render), behind a reverse proxy that terminates TLS.
- A home server, exposed through a tunnel such as Tailscale or Cloudflare Tunnel.

Build and run the container:

```sh
docker build -t html2kindle .
docker run -d --name html2kindle -p 8787:8787 --env-file .env html2kindle
```

Docker reads `--env-file` itself, so `node --env-file` is not needed in the container. Put the reverse proxy or tunnel in front of port 8787 and use its HTTPS address as `YOUR-HOST` in the sections below.

## Using it

There are three ways to send content:

1. **iOS Shortcut (primary).** In Safari, tap Share, then "Send to Kindle". The Shortcut posts the page URL to the service. An optional variant posts the rendered page HTML, which helps with logged-in, paywalled, or JavaScript-heavy pages. Setup is in [docs/ios-shortcut.md](docs/ios-shortcut.md).
2. **Web page.** Open `https://YOUR-HOST/` on your phone. Paste a URL or pick a file, then tap "Send to Kindle" or "Download EPUB". You can add the page to the Home Screen. To store the token in the browser, open `https://YOUR-HOST/#token=XXXX` once. The token is then saved and the fragment is not sent to the server.
3. **CLI.** From the repository:

```sh
npm run cli -- <url-or-file> [--download [outPath]] [--title T]
```

`--download` saves the EPUB locally instead of emailing it, optionally to `outPath`. `--title` sets the document title.

## API reference

Endpoints:

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/healthz` | no | Returns `{ "ok": true }`. |
| GET | `/` | no | Web UI. |
| GET | `/api/config` | yes | Returns `{ emailConfigured, kindleEmail }`. The Kindle address is masked. |
| POST | `/api/send` | yes | Converts and sends (or returns) a page or file. |

`POST /api/send` accepts one of:

- JSON: `{ url?, html?, title?, delivery? }`
- multipart form with `url`, `html`, `title`, `delivery` fields and a `file` part
- URL-encoded form with the same fields

`delivery` is `email` (the default when SMTP is configured) or `download`, which returns the file in the response.

Add `?format=text` to get a one-line plain-text reply. The Shortcut uses this.

**Authentication.** Send the token in one of these ways:

- `Authorization: Bearer <AUTH_TOKEN>` (preferred)
- `X-Auth-Token: <AUTH_TOKEN>`
- `?token=<AUTH_TOKEN>` query parameter (see the security notes)

Examples, with `YOUR-HOST` and `YOUR_TOKEN` replaced by your values:

```sh
# Send a URL to the Kindle
curl -X POST "https://YOUR-HOST/api/send" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/essay"}'

# Download the EPUB instead of emailing it
curl -X POST "https://YOUR-HOST/api/send" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/essay","delivery":"download"}' \
  -o essay.epub

# Upload a PDF
curl -X POST "https://YOUR-HOST/api/send" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@paper.pdf"
```

## Configuration

All variables are read from the environment. See [.env.example](.env.example) for comments.

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `8787` | Port the HTTP server listens on. |
| `AUTH_TOKEN` | empty | Shared secret for the API and web UI. Generate with `openssl rand -hex 32`. If empty, auth is disabled; use this for local use only. |
| `KINDLE_EMAIL` | none | Your Send-to-Kindle address (`@kindle.com`). |
| `FROM_EMAIL` | `SMTP_USER` | Sender address. Must be on Amazon's Approved Personal Document E-mail List. |
| `SMTP_HOST` | none | SMTP server host, for example `smtp.gmail.com`. If not set, the service runs in download-only mode. |
| `SMTP_PORT` | `587` | SMTP server port. |
| `SMTP_SECURE` | `true` only when `SMTP_PORT` is `465`, otherwise `false` | Use implicit TLS. |
| `SMTP_USER` | none | SMTP login. |
| `SMTP_PASS` | none | SMTP password or App Password. |
| `MAX_BYTES` | `26214400` (25 MB) | Maximum size of an uploaded or fetched input. |
| `FETCH_TIMEOUT_MS` | `20000` | Timeout for fetching a page, in milliseconds. |
| `ALLOW_PRIVATE_HOSTS` | `false` | Leave off. Setting it to `true` disables the protection against fetching internal network addresses. |

## Limitations

- Text only. Images are dropped from HTML pages.
- JavaScript-rendered pages may come out empty. Use the Shortcut's page-HTML variant so the phone sends the rendered page.
- Paywalled or login-only pages have the same problem. The page-HTML variant sends what your browser can see.
- Scanned PDFs are not OCR'd, so they have no searchable text.
- PDFs are sent unchanged. Kindle shows them as fixed-layout pages.
- Attachment size is limited by your SMTP provider, commonly about 25 MB. `MAX_BYTES` also caps input size.
- The server fetches pages directly and ignores `HTTP_PROXY` / `HTTPS_PROXY`, so it needs direct outbound internet access.
- Some sites block requests from server IP addresses. The page-HTML variant avoids this as well.

## Security notes

- This is a single-user service. Anyone with `AUTH_TOKEN` can send content to your Kindle.
- Keep `AUTH_TOKEN` secret. Do not commit `.env`.
- Always serve the service over HTTPS. A plain-HTTP token can be read on the network.
- Prefer the `Authorization` header. A token in a query string can end up in server, proxy, or browser logs.
- Keep `ALLOW_PRIVATE_HOSTS` off, so the service cannot be used to fetch addresses on your internal network.

## Development

```sh
npm install
npm run dev         # development run
npm run typecheck   # type-check the project
npm test            # run the tests
npm run build       # compile to dist/
```
