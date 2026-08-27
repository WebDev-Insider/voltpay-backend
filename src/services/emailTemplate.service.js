/**
 * The VoltPay email design system.
 *
 * Every email the backend sends renders through `renderEmail()` here, so the
 * logo, the palette, the spacing and the footer are defined once. Adding a new
 * email means picking blocks, not pasting table markup.
 *
 * WHY THE MARKUP LOOKS LIKE THIS
 * ------------------------------
 * Outlook 2007-2021 lays HTML out with Microsoft Word's engine, not a browser
 * one. It ignores `border-radius`, `max-width` on a `<div>`, flexbox, grid and
 * `background-image`. So:
 *
 *   - Structure is nested `<table>`, never `<div>` columns. `role="presentation"`
 *     stops screen readers announcing them as data tables.
 *   - Every style is inline. `<style>` in `<head>` is stripped by Gmail's
 *     clipper on long mails and by most webmail; the only thing we put there is
 *     the dark-mode and small-screen media queries, which are progressive
 *     enhancement and may safely be dropped.
 *   - Colour, padding and radius live on `<td>`, not on the table.
 *   - An MSO conditional wraps the 600px column so Outlook still gets a fixed
 *     width when `max-width` is ignored.
 *
 * WHY THE LOGO IS A HOSTED URL
 * ----------------------------
 * Gmail, Outlook.com and Yahoo all strip `data:` image sources, so a base64
 * logo is invisible in the three clients that matter most in Nigeria. The file
 * is served from this backend at /assets/brand/voltpay-logo.png (see
 * assets.routes.js) and the URL is built from PUBLIC_BASE_URL.
 *
 * Images are also blocked by default in Outlook desktop and in a lot of
 * corporate mail. The `<img>` therefore carries its own inline `color`,
 * `font-size` and `font-weight`, so a blocked image draws the word "VoltPay"
 * in brand blue rather than a broken-image icon. When no https base URL is
 * configured at all we skip the `<img>` entirely and draw the wordmark in
 * text - "Volt" blue, "pay" navy, which is what the real logo is.
 */

// Straight from lib/core/utils/my_color.dart, so email and app agree.
//   statusColor #2B5BEE is the blue in the logo's "Volt"
//   dark        #1F2937 is the navy in the logo's "pay"
const PALETTE = {
  brand: '#2B5BEE',
  brandDark: '#1E44BE',
  navy: '#1F2937',
  ink: '#0F172A',
  body: '#475569',
  muted: '#94A3B8',
  border: '#E2E8F0',
  hairline: '#EEF2F7',
  page: '#F1F5F9',
  surface: '#FFFFFF',
  subtle: '#F8FAFC',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
};

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO_STACK =
  "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace";

const TONES = {
  info: { bar: PALETTE.brand, bg: '#EFF4FE', text: '#1E3A8A' },
  success: { bar: PALETTE.success, bg: '#ECFDF5', text: '#065F46' },
  warning: { bar: PALETTE.warning, bg: '#FFFBEB', text: '#92400E' },
  danger: { bar: PALETTE.danger, bg: '#FEF2F2', text: '#991B1B' },
};

/** Escape anything that came from a user or a provider before it hits the HTML. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brandName() {
  return String(process.env.EMAIL_BRAND_NAME || 'VoltPay').trim() || 'VoltPay';
}

function brandColor() {
  const raw = String(process.env.EMAIL_BRAND_COLOR || '').trim();
  // Only accept a real hex. render.yaml has shipped `#0000FF` at times, which
  // is pure blue and looks nothing like the logo, so an unset value is better
  // than a wrong one - fall back to the actual brand blue.
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : PALETTE.brand;
}

function supportEmail() {
  return String(process.env.SUPPORT_EMAIL_TO || process.env.SUPPORT_EMAIL || '').trim() || null;
}

/**
 * The public https origin this backend answers on. Anything that is not https
 * is treated as absent: mail clients refuse or warn on mixed-content images,
 * and a broken logo looks worse than no logo.
 */
function publicBase() {
  const base = String(
    process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BACKEND_URL || ''
  )
    .trim()
    .replace(/\/+$/, '');
  return /^https:\/\//i.test(base) ? base : null;
}

function logoUrl() {
  const explicit = String(process.env.EMAIL_LOGO_URL || '').trim();
  if (explicit) return explicit;
  const base = publicBase();
  return base ? `${base}/assets/brand/voltpay-logo.png` : null;
}

/**
 * The masthead. Height is fixed at 34px and width left to the aspect ratio of
 * the file (the wordmark is ~5.3:1, so 180x34), because Outlook needs an
 * explicit dimension or it draws the image at full pixel size - which for a
 * 3264px-wide source means a logo wider than the screen.
 */
function renderLogo() {
  const name = brandName();
  const url = logoUrl();

  if (!url) {
    // No hosted asset configured. The logo is a pure wordmark, so text is a
    // near-identical stand-in rather than a downgrade.
    return `<div style="font-family:${FONT_STACK};font-size:27px;font-weight:800;letter-spacing:-0.6px;line-height:34px;">
                  <span style="color:${brandColor()};">Volt</span><span style="color:${PALETTE.navy};">pay</span>
                </div>`;
  }

  return `<img src="${esc(url)}" alt="${esc(name)}" height="34"
                  style="display:block;border:0;outline:none;text-decoration:none;height:34px;width:auto;max-width:190px;font-family:${FONT_STACK};font-size:24px;font-weight:800;letter-spacing:-0.5px;color:${brandColor()};" />`;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/*                                                                             */
/* Each returns one or more `<tr>` for the card body. They are composed in an  */
/* array and handed to renderEmail(), which is the only place that knows what  */
/* the card around them looks like.                                            */
/* -------------------------------------------------------------------------- */

/**
 * A paragraph. `html` is trusted - callers pass `<b>` for emphasis - so
 * anything user-supplied has to go through esc() before it gets here.
 */
function paragraph(html, options = {}) {
  const size = options.small ? '13px' : '15px';
  const lineHeight = options.small ? '20px' : '24px';
  const color = options.muted ? PALETTE.muted : PALETTE.body;
  const align = options.align || 'left';
  return `<tr>
              <td class="vp-pad" style="padding:0 36px 16px 36px;">
                <div style="font-family:${FONT_STACK};font-size:${size};line-height:${lineHeight};color:${color};text-align:${align};margin:0;">${html}</div>
              </td>
            </tr>`;
}

/**
 * The one-time code. Sized and spaced to be read off a screen and typed into a
 * phone: 36px, 8px of tracking, monospace so 0/O and 1/l cannot be confused.
 *
 * `user-select:all` makes one tap select the whole code in clients that honour
 * it; the rest fall back to normal selection, which is fine.
 */
function codePanel(code, options = {}) {
  const value = esc(String(code).trim());
  const caption = options.caption ? esc(options.caption) : null;
  const accent = brandColor();

  return `<tr>
              <td class="vp-pad" style="padding:4px 36px 20px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;">
                  <tr>
                    <td align="center" style="background-color:${PALETTE.subtle};border:1px solid ${PALETTE.border};border-radius:14px;padding:22px 16px 18px 16px;">
                      ${
                        caption
                          ? `<div style="font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${PALETTE.muted};padding-bottom:10px;">${caption}</div>`
                          : ''
                      }
                      <div class="vp-code" style="font-family:${MONO_STACK};font-size:36px;line-height:44px;font-weight:700;letter-spacing:8px;text-indent:8px;color:${PALETTE.ink};-webkit-user-select:all;user-select:all;white-space:nowrap;">${value}</div>
                      <div style="height:3px;width:44px;background-color:${accent};border-radius:3px;margin:14px auto 0 auto;font-size:0;line-height:3px;">&nbsp;</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/**
 * A call-to-action. The `<!--[if mso]>` branch draws a VML rounded rectangle,
 * because Outlook renders neither the padding nor the radius of an anchor and
 * would otherwise show a bare blue link.
 */
function button({ label, url, tone = 'brand' }) {
  const bg = tone === 'danger' ? PALETTE.danger : brandColor();
  const href = esc(url);
  const text = esc(label);

  return `<tr>
              <td align="center" class="vp-pad" style="padding:4px 36px 24px 36px;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="25%" stroke="f" fillcolor="${bg}">
                  <w:anchorlock/>
                  <center style="color:#FFFFFF;font-family:${FONT_STACK};font-size:15px;font-weight:bold;">${text}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-- -->
                <a href="${href}" style="display:inline-block;background-color:${bg};color:#FFFFFF;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:20px;text-decoration:none;padding:14px 34px;border-radius:12px;mso-hide:all;">${text}</a>
                <!--<![endif]-->
              </td>
            </tr>`;
}

/**
 * A callout for the "if this wasn't you" line and anything else the reader must
 * not skim past.
 *
 * The accent stripe is a 4px-wide table cell rather than a `border-left`,
 * because Outlook drops one-sided borders on a `<div>` but always paints a
 * cell background.
 */
function notice({ tone = 'info', title, body }) {
  const t = TONES[tone] || TONES.info;
  return `<tr>
              <td class="vp-pad" style="padding:0 36px 20px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;">
                  <tr>
                    <td width="4" style="width:4px;background-color:${t.bar};border-radius:4px 0 0 4px;font-size:0;line-height:0;">&nbsp;</td>
                    <td style="background-color:${t.bg};border-radius:0 10px 10px 0;padding:14px 16px;">
                      ${
                        title
                          ? `<div style="font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${t.text};padding-bottom:4px;">${title}</div>`
                          : ''
                      }
                      <div style="font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${t.text};">${body}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/**
 * Label/value rows - a receipt, an application summary, the details of a
 * scheduled deletion. Values are right-aligned so numbers line up.
 */
function detailList(rows = []) {
  const items = rows
    .filter(Boolean)
    .map(
      ([label, value], index) => `<tr>
                    <td style="padding:${index === 0 ? '0' : '10px'} 0 10px 0;border-top:${index === 0 ? 'none' : `1px solid ${PALETTE.hairline}`};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};">${label}</td>
                    <td align="right" style="padding:${index === 0 ? '0' : '10px'} 0 10px 0;border-top:${index === 0 ? 'none' : `1px solid ${PALETTE.hairline}`};font-family:${FONT_STACK};font-size:13px;line-height:20px;font-weight:600;color:${PALETTE.ink};">${value}</td>
                  </tr>`
    )
    .join('');

  if (!items) return '';

  return `<tr>
              <td class="vp-pad" style="padding:0 36px 20px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${PALETTE.subtle};border:1px solid ${PALETTE.border};border-radius:12px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${items}</table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/**
 * The recovery phrase grid: three numbered words per row, the same shape the
 * app draws, so the two can be checked against each other word for word.
 */
function wordGrid(words = []) {
  const clean = words.filter(Boolean);
  if (!clean.length) return '';

  const rows = [];
  for (let i = 0; i < clean.length; i += 3) {
    const slice = clean.slice(i, i + 3);
    // Pad the last row so three columns keep an even width.
    while (slice.length < 3) slice.push(null);
    const cells = slice
      .map((word, offset) =>
        word === null
          ? '<td width="33%" style="width:33%;padding:5px;">&nbsp;</td>'
          : `<td width="33%" style="width:33%;padding:5px;">
                        <div style="border:1px solid ${PALETTE.border};border-radius:10px;background-color:${PALETTE.surface};padding:10px 8px;text-align:center;font-family:${MONO_STACK};font-size:14px;line-height:18px;color:${PALETTE.ink};">
                          <span style="color:${PALETTE.muted};font-size:11px;">${i + offset + 1}</span>&nbsp;${esc(word)}
                        </div>
                      </td>`
      )
      .join('');
    rows.push(`<tr>${cells}</tr>`);
  }

  return `<tr>
              <td class="vp-pad" style="padding:0 36px 20px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${PALETTE.subtle};border:1px solid ${PALETTE.border};border-radius:14px;">
                  <tr>
                    <td style="padding:10px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${rows.join('')}</table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/** A quoted block for a support reply or any message written by a person. */
function quote(html) {
  return `<tr>
              <td class="vp-pad" style="padding:0 36px 20px 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
                  <tr>
                    <td style="background-color:${PALETTE.subtle};border:1px solid ${PALETTE.border};border-radius:12px;padding:16px 18px;font-family:${FONT_STACK};font-size:15px;line-height:24px;color:${PALETTE.body};">${html}</td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

/** A hairline between sections of the card. */
function divider() {
  return `<tr>
              <td class="vp-pad" style="padding:4px 36px 20px 36px;">
                <div style="height:1px;background-color:${PALETTE.hairline};font-size:0;line-height:1px;">&nbsp;</div>
              </td>
            </tr>`;
}

/** Raw escape hatch, for a caller that has already built email-safe rows. */
function raw(html) {
  return String(html || '');
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * WHAT IS ESCAPED AND WHAT IS NOT
 * -------------------------------
 * `subject`, `preheader`, `eyebrow` and `tag` are escaped here - they are
 * chrome, and no caller has a reason to put markup in them.
 *
 * `heading`, `footnote` and everything inside a block are **trusted HTML**,
 * because the callers legitimately pass `<b>` and `<a>`. Anything that came
 * from a user, a business or an admin must therefore go through `esc()` before
 * it is handed in. support.controller does this for the ticket subject and
 * body; email.service does it for a company name and a decline reason.
 *
 * @param {object}   opts
 * @param {string}   opts.subject    <title>, and what the client shows if it has no subject. Escaped.
 * @param {string}  [opts.preheader] The grey line the inbox shows after the subject. Escaped.
 * @param {string}  [opts.eyebrow]   Small uppercase tag above the heading, e.g. "Security". Escaped.
 * @param {string}   opts.heading    The h1. Trusted HTML.
 * @param {string[]}[opts.blocks]    Rows from the block helpers above.
 * @param {string}  [opts.footnote]  Small print inside the card. Trusted HTML.
 * @param {string}  [opts.tag]       Right-hand chip in the card header, e.g. a ticket code. Escaped.
 */
function renderEmail({ subject, preheader, eyebrow, heading, blocks = [], footnote, tag }) {
  const name = brandName();
  const accent = brandColor();
  const year = new Date().getFullYear();
  const support = supportEmail();
  const body = blocks.filter(Boolean).join('');

  const supportLine = support
    ? `Need help? Email <a href="mailto:${esc(support)}" style="color:${accent};text-decoration:none;font-weight:600;">${esc(support)}</a> or open Support in the ${esc(name)} app.`
    : `Need help? Open the Support section of the ${esc(name)} app.`;

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${esc(subject)}</title>
    <!--[if mso]>
    <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
    <![endif]-->
    <style>
      /* Progressive enhancement only - every rule here has an inline fallback,
         because Gmail's clipper and most webmail strip this block. */
      body { margin:0 !important; padding:0 !important; width:100% !important; }
      a { text-decoration:none; }
      img { -ms-interpolation-mode:bicubic; }
      /* Outlook.com forces its own line-height onto paragraphs; this releases
         it. No angle brackets in this block: some mail sanitizers parse a
         style body by looking for tag-shaped text. */
      .ExternalClass, .ExternalClass p, .ExternalClass div { line-height:100%; }
      @media only screen and (max-width:620px) {
        .vp-shell { width:100% !important; }
        .vp-pad { padding-left:22px !important; padding-right:22px !important; }
        .vp-code { font-size:30px !important; letter-spacing:6px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;width:100%;background-color:${PALETTE.page};-webkit-font-smoothing:antialiased;">
    <!-- Inbox preview line. Kept out of sight, and padded so the client does not
         pull the first words of the body in after it. -->
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:transparent;">
      ${esc(preheader || subject)}
      &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${PALETTE.page};">
      <tr>
        <td align="center" style="padding:32px 12px 40px 12px;">

          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="vp-shell" style="width:600px;max-width:600px;">

            <!-- masthead -->
            <tr>
              <td align="center" style="padding:4px 0 22px 0;">
                ${renderLogo()}
              </td>
            </tr>

            <!-- card -->
            <tr>
              <td style="background-color:${PALETTE.surface};border:1px solid ${PALETTE.border};border-radius:18px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">

                  <!-- accent rail: the one flash of brand colour on the card -->
                  <tr>
                    <td style="background-color:${accent};height:5px;border-radius:18px 18px 0 0;font-size:0;line-height:5px;">&nbsp;</td>
                  </tr>

                  ${
                    eyebrow
                      ? `<tr>
                    <td class="vp-pad" style="padding:28px 36px 0 36px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
                        <tr>
                          <td style="font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${accent};">${esc(eyebrow)}</td>
                          ${
                            tag
                              ? `<td align="right" style="font-family:${MONO_STACK};font-size:11px;font-weight:600;letter-spacing:0.6px;color:${PALETTE.muted};">${esc(tag)}</td>`
                              : ''
                          }
                        </tr>
                      </table>
                    </td>
                  </tr>`
                      : ''
                  }

                  <tr>
                    <td class="vp-pad" style="padding:${eyebrow ? '8px' : '30px'} 36px 14px 36px;">
                      <h1 style="margin:0;font-family:${FONT_STACK};font-size:23px;line-height:31px;font-weight:700;letter-spacing:-0.4px;color:${PALETTE.ink};">${heading}</h1>
                    </td>
                  </tr>

                  ${body}

                  ${
                    footnote
                      ? `<tr>
                    <td class="vp-pad" style="padding:0 36px 4px 36px;">
                      <div style="height:1px;background-color:${PALETTE.hairline};font-size:0;line-height:1px;">&nbsp;</div>
                    </td>
                  </tr>
                  <tr>
                    <td class="vp-pad" style="padding:16px 36px 0 36px;">
                      <div style="font-family:${FONT_STACK};font-size:12px;line-height:19px;color:${PALETTE.muted};">${footnote}</div>
                    </td>
                  </tr>`
                      : ''
                  }

                  <tr><td style="height:28px;font-size:0;line-height:28px;">&nbsp;</td></tr>
                </table>
              </td>
            </tr>

            <!-- footer -->
            <tr>
              <td align="center" style="padding:24px 16px 0 16px;">
                <div style="font-family:${FONT_STACK};font-size:12px;line-height:20px;color:${PALETTE.muted};">
                  ${supportLine}
                </div>
                <div style="height:12px;font-size:0;line-height:12px;">&nbsp;</div>
                <div style="font-family:${FONT_STACK};font-size:11px;line-height:18px;color:${PALETTE.muted};">
                  This is an automated message from ${esc(name)}. Please do not reply to it.
                </div>
                <div style="font-family:${FONT_STACK};font-size:11px;line-height:18px;color:${PALETTE.muted};">
                  &copy; ${year} ${esc(name)} by Jade Edge Technology. All rights reserved.
                </div>
              </td>
            </tr>

          </table>
          <!--[if mso]></td></tr></table><![endif]-->

        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * The plain-text alternative. Not decoration: a message with no text/plain part
 * scores worse with spam filters, and the OTP mails in particular have to be
 * readable on a watch or a screen reader.
 *
 * Takes the same paragraph strings the HTML uses and strips the tags, so the
 * two versions cannot drift.
 */
function toPlainText(parts = []) {
  return parts
    .filter(Boolean)
    .map(part =>
      String(part)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+\n/g, '\n')
        .trim()
    )
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  renderEmail,
  toPlainText,
  esc,
  brandName,
  brandColor,
  supportEmail,
  logoUrl,
  PALETTE,
  FONT_STACK,
  MONO_STACK,
  blocks: {
    paragraph,
    codePanel,
    button,
    notice,
    detailList,
    wordGrid,
    quote,
    divider,
    raw,
  },
};
