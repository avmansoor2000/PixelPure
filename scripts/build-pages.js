'use strict';
// Generates the static legal/info pages from one template. Run: npm run build:pages
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'public');

const LOGO = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="8" fill="url(#bm)"/><path d="M10 22V10h6.5a4 4 0 0 1 0 8H13" fill="none" stroke="#0b0b12" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22.5" cy="22" r="1.8" fill="#0b0b12"/></svg>`;

const page = ({ slug, title, description, body, noindex }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — PixelPure</title>
  <meta name="description" content="${description}">
  <meta name="theme-color" content="#08080d">
  ${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="/${slug}">`}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <header class="nav scrolled">
    <div class="container nav-inner">
      <a href="/" class="brand" aria-label="PixelPure home">${LOGO}<span>PixelPure</span></a>
      <nav class="nav-links" aria-label="Primary"><a href="/#features">Features</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a></nav>
      <div class="nav-cta"><a class="btn btn-primary btn-sm" href="/">Open editor</a></div>
    </div>
  </header>
  <main class="page"><div class="container container-narrow prose">
${body}
  </div></main>
  <footer class="footer"><div class="container footer-inner">
    <div class="footer-brand"><a href="/" class="brand">${LOGO}<span>PixelPure</span></a><p>AI watermark removal and image enhancement.</p></div>
    <nav class="footer-links" aria-label="Footer"><a href="/about">About</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a><a href="/contact">Contact</a></nav>
    <p class="footer-copy">© ${new Date().getFullYear()} PixelPure. All rights reserved.</p>
  </div></footer>
</body>
</html>
`;

const updated = 'Last updated: November 2026';
const pages = [
  {
    slug: 'about', title: 'About', description: 'PixelPure makes AI image cleanup and enhancement simple, fast and private.',
    body: `<h1>About PixelPure</h1>
<p class="updated">Clean images, without the busywork.</p>
<p>PixelPure is an AI image editor focused on two jobs: removing what shouldn't be in a picture, and making what remains look its best. Brush over a watermark, date stamp, logo or stray object and our inpainting models rebuild the background. Upscale 2× or 4× when you need more resolution for print, product pages or presentations.</p>
<h2>How we build</h2>
<p>We integrate best-in-class AI image models behind a single, simple editor, and we only change the pixels you select — everything else stays exactly as it was. Uploads are validated, stripped of metadata and deleted automatically.</p>
<h2>Responsible use</h2>
<p>PixelPure is meant for images you own or are licensed to edit. Please respect photographers, artists and stock agencies — see our <a href="/terms">Terms</a>.</p>`,
  },
  {
    slug: 'privacy', title: 'Privacy Policy', description: 'How PixelPure handles your images and data.',
    body: `<h1>Privacy Policy</h1>
<p class="updated">${updated}</p>
<h2>What we collect</h2>
<p>When you use PixelPure we process the images you upload, the selection masks you draw and basic technical data (IP address, browser type) needed to operate and protect the service, for example rate limiting.</p>
<h2>How your images are processed</h2>
<ul>
<li>Uploads are validated and re-encoded on our servers. EXIF, GPS and other embedded metadata are removed.</li>
<li>To perform AI removal or enhancement, the image and mask are sent to our AI processing partner (such as Stability AI, Clipdrop or Replicate, depending on configuration) solely to produce your result.</li>
<li>Uploaded images and results are stored temporarily and <strong>deleted automatically after 60 minutes</strong>. You can also remove an image earlier from the editor's image tray.</li>
<li>We do not sell your images or use them to train models.</li>
</ul>
<h2>Cookies</h2>
<p>The editor does not use advertising or tracking cookies.</p>
<h2>Your rights</h2>
<p>You may request access to or deletion of personal data we hold by contacting us. Because images are deleted automatically, we usually hold none beyond the retention window.</p>
<h2>Contact</h2>
<p>Questions about privacy? <a href="/contact">Get in touch</a>.</p>`,
  },
  {
    slug: 'terms', title: 'Terms of Service', description: 'The terms that govern use of PixelPure.',
    body: `<h1>Terms of Service</h1>
<p class="updated">${updated}</p>
<h2>1. Acceptable use</h2>
<p>You may only upload and edit images that you own or have the rights or permission to modify. You must not use PixelPure to remove watermarks, logos, signatures or copyright notices in order to use, distribute or sell another party's work without authorisation, or for any unlawful, infringing, deceptive or harmful purpose.</p>
<h2>2. Your content</h2>
<p>You keep all rights to your images. You grant us a limited licence to process them solely to provide the service. Results are yours to use, subject to the rights of any third parties in the original image.</p>
<h2>3. AI results</h2>
<p>AI-generated reconstructions may contain inaccuracies or artefacts. Review results before use. The service is provided "as is" without warranties of any kind.</p>
<h2>4. Limits and availability</h2>
<p>We may apply usage limits, rate limits and file-size limits and may change or discontinue features at any time.</p>
<h2>5. Plans and billing</h2>
<p>Paid plans, where offered, renew monthly until cancelled. Plan limits are described on the pricing page.</p>
<h2>6. Liability</h2>
<p>To the maximum extent permitted by law, PixelPure is not liable for indirect or consequential damages arising from use of the service.</p>
<h2>7. Contact</h2>
<p>Questions about these terms? <a href="/contact">Contact us</a>.</p>`,
  },
  {
    slug: 'contact', title: 'Contact', description: 'Get in touch with the PixelPure team for support, plans and partnerships.',
    body: `<h1>Contact us</h1>
<p class="updated">We usually reply within one business day.</p>
<div class="contact-card">
<h2 class="mt-0">Support &amp; plans</h2>
<p>Email <a href="mailto:hello@pixelpure.app">hello@pixelpure.app</a> for help with the editor, Pro or Premium plans, invoices, or partnerships.</p>
<p class="muted small">Tip: include the approximate time and what you were trying to do. Please don't email images you don't have rights to.</p>
</div>`,
  },
  {
    slug: '404', title: 'Page not found', description: 'This page does not exist.', noindex: true,
    body: `<h1>Page not found</h1><p class="updated">The page you're looking for doesn't exist or has moved.</p><p><a class="btn btn-primary btn-link" href="/">Back to PixelPure</a></p>`,
  },
];

for (const p of pages) fs.writeFileSync(path.join(out, `${p.slug}.html`), page(p));
console.log('Built', pages.map((p) => p.slug + '.html').join(', '));
