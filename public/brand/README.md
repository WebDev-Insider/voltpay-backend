# backend/public/brand

Served publicly at `/assets/brand/:filename` by `assets.controller.getBrandAsset`,
which allowlists the filenames below. It sits outside `API_PREFIX` so no session
is needed, and sets `Cross-Origin-Resource-Policy: cross-origin` — without that
header helmet's default blocks the fetch that Gmail and Outlook.com make when
they render the email on their own domain.

| File | Size | Used by |
|---|---|---|
| `voltpay-logo.png` | 400×75 | the masthead of every transactional email |
| `voltpay-logo-white.png` | 400×77 | reserved for a dark masthead; nothing references it yet |

## These are derived copies, not the source

The originals are `assets/images/logo/logo.png` and `logo_white.png` at
3264px wide — right for the Flutter app, splash screens and print.

**Do not copy them here unchanged.** `renderLogo()` displays the mark at
`height="34"` / `max-width:190px`, so 400px is already 2× what any retina
client can use. The full-resolution file is 85.8KB; this one is 7.3KB. Every
recipient pays that difference on every email, and most VoltPay users are on
metered Nigerian mobile data.

To regenerate after a brand change, downscale to 400px wide keeping the alpha
channel (the source is RGBA and the mark has to sit on the email's `#F1F5F9`
ground without a white box behind it).

## If the logo does not appear in an email

The `src` is built from `PUBLIC_BASE_URL` (or `EMAIL_LOGO_URL` if set to
override, e.g. to put the file on a CDN). `publicBase()` returns `null` for
anything that is not `https://` — a mixed-content image gets refused by most
clients, so a text wordmark is the better failure. In order:

1. `EMAIL_LOGO_URL` set → used verbatim.
2. `PUBLIC_BASE_URL` is https → `{base}/assets/brand/voltpay-logo.png`.
3. Neither → the email renders a text wordmark instead of an image.

If the image is reachable but the recipient's client blocks remote images, the
`<img>` carries inline `color`/`font-size`/`font-weight`, so the alt text still
renders as a styled wordmark rather than a broken-image box.

Run `npm run email:preview` to see all of it in a browser.
