# iOS Shortcut: Send to Kindle

This guide shows how to build a "Send to Kindle" Shortcut by hand in the iOS Shortcuts app. Share a page from Safari, and the Shortcut sends it to your html2kindle service.

The signed `.shortcut` file is not shipped with this project, so you build it yourself. Replace these placeholders throughout:

- `YOUR-HOST`: your service's HTTPS address, without a trailing slash (for example `html2kindle.example.com`).
- `YOUR_TOKEN`: your `AUTH_TOKEN` value.

Exact menu wording varies between iOS versions. The steps below name the actions and fields; find the matching controls in your version.

## Variant A: send the URL (simple)

Use this for most articles. The service fetches the page itself.

1. Open the **Shortcuts** app and tap **+** to create a new Shortcut. Name it **Send to Kindle**.
2. Open the Shortcut's details (the info or settings control on the Shortcut's page). Turn on **Show in Share Sheet**. Under the accepted types, select only **Safari web pages** and **URLs**. Deselect any other types.
3. Add the action **Get Contents of URL** and set:
   - **URL:** `https://YOUR-HOST/api/send?format=text`
   - **Method:** `POST`
   - **Headers:** add one header. Key: `Authorization`. Value: `Bearer YOUR_TOKEN`
   - **Request Body:** `JSON`. Add one field. Key: `url`. Value: the **Shortcut Input** variable (the magic variable that holds the page URL).
4. Add the action **Show Result** (or **Show Notification**). Set its input to the output of **Get Contents of URL**. The reply is a one-line status message.
5. In Safari, open an article, tap **Share**, then tap **Send to Kindle**.

## Variant B: send the rendered page HTML

Use this for logged-in, paywalled, or JavaScript-heavy pages. The phone sends the page as your browser sees it, so the service does not need to fetch it.

1. Create a new Shortcut named **Send to Kindle (HTML)**. Turn on **Show in Share Sheet** and accept only **Safari web pages**.
2. Add the action **Run JavaScript on Web Page** and paste this script:

   ```js
   completion({ url: location.href, title: document.title, html: document.documentElement.outerHTML })
   ```

3. Add three **Get Dictionary Value** actions, each taking the **Dictionary** output of the previous action as its input:
   - Key `url`
   - Key `title`
   - Key `html`
4. Add the action **Get Contents of URL** and set:
   - **URL:** `https://YOUR-HOST/api/send?format=text`
   - **Method:** `POST`
   - **Headers:** `Authorization` with value `Bearer YOUR_TOKEN`
   - **Request Body:** `JSON`. Add three fields, each taken from the matching **Get Dictionary Value** output:
     - `url`
     - `title`
     - `html`
5. Add the action **Show Result**, with the output of **Get Contents of URL** as its input.

Notes:

- **Run JavaScript on Web Page** works only when the Shortcut is run from Safari's share sheet. It does not run from the Shortcuts app or from a Home Screen icon.
- The first time you run it, iOS asks for permission for the Shortcut to run JavaScript on the page. Allow it.
- The HTML of a full page can be large. The service rejects inputs larger than `MAX_BYTES`.

## Sharing PDFs

- If the PDF has a public URL, share it from Safari with **Variant A**. The service fetches the PDF and emails it unchanged.
- If the PDF is not reachable by URL (for example, it is saved on the phone or was opened from a login-only page), save it to **Files**, then upload it through the web page at `https://YOUR-HOST/`.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| Response is `401` | The token is wrong. Check that the `Authorization` header is `Bearer YOUR_TOKEN` with the exact `AUTH_TOKEN` value, and that there are no extra spaces or line breaks. |
| Response is `503` | SMTP is not configured on the server. Set `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS`, then restart the service. |
| Response is `422` | The service found no readable text in the page. Try **Variant B**, which sends the rendered HTML. |
| Nothing arrives on the Kindle | Check that the sender address (`FROM_EMAIL`) is on Amazon's Approved Personal Document E-mail List. Check that the Kindle address (`KINDLE_EMAIL`) is correct. Check for the Amazon confirmation email in your inbox. |
| Shortcut does not appear in the share sheet | Scroll to the bottom of the share sheet, tap **Edit Actions**, and turn on **Send to Kindle**. |

If a problem is not listed here, check the service's logs on the server.
