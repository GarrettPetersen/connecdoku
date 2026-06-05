# Shiji Kindle e-book ad — Connecdoku placement kit

Assets and copy for a tasteful cross-promo on [connecdoku.com](https://connecdoku.com) pointing readers to the **Records of the Grand Historian** Kindle edition on Amazon.

## Files in this folder

| File | Purpose |
|------|---------|
| `shiji.svg` | Book cover art (same SVG used on [24histories.com](https://24histories.com)). Portrait ratio 1600×2560; brand color `#9f2f2f`. |
| `README.md` | This placement guide. |

After deploy, host the cover at a stable URL on connecdoku.com, e.g. `https://connecdoku.com/shiji-ebook-ad/shiji.svg` (copy this folder into the site root or publish path).

---

## Amazon link (affiliate)

**Buy URL:** https://amzn.to/4vzL5yT

Use on every outbound Amazon link:

```html
rel="noopener noreferrer sponsored"
target="_blank"
```

**Required disclosure** (must appear on the same screen as the affiliate link, visible without scrolling on desktop):

> As an Amazon Associate, Garrett M. Petersen earns from qualifying purchases.

Connecdoku’s privacy policy should mention Amazon Associates if this ad ships (see [24histories privacy — Amazon Associates](https://24histories.com/privacy.html#amazon-associates) for wording).

---

## Copy (English only — anglophone audience)

| Field | Text |
|-------|------|
| Eyebrow | `Now on Kindle` |
| Headline | `Records of the Grand Historian` |
| Body | `The complete English translation of Sima Qian’s foundational history is available as a Kindle e-book — polished for long-form reading away from the browser.` |
| CTA button | `View on Amazon` |
| Web alternative | `Read free on 24 Histories` → https://24histories.com/book/shiji.html |
| Cover `alt` | `Records of the Grand Historian cover` |

Do **not** use Chinese characters (史記) in Connecdoku promo copy.

---

## Suggested placement

**Primary:** `index.html`, below the puzzle grid and hint button, **above** the existing `.rowCredit` line (around line 210).

Rationale: visible after play without covering the board; matches how other Garrett projects are credited in `.rowCredit`.

**Optional later:** same block on `archive.html` if archive traffic should see it (archive puzzles already show a stats disclaimer near `.rowCredit`).

---

## HTML snippet

Insert inside `#shell`, after `#hintContainer` and before `.rowCredit`:

```html
<aside id="shijiEbookAd" class="shiji-ebook-ad" aria-label="Kindle edition promotion">
  <a class="shiji-ebook-ad-cover" href="https://amzn.to/4vzL5yT" target="_blank" rel="noopener noreferrer sponsored">
    <img src="shiji-ebook-ad/shiji.svg" alt="Records of the Grand Historian cover" width="72" height="115" loading="lazy" decoding="async">
  </a>
  <div class="shiji-ebook-ad-copy">
    <p class="shiji-ebook-ad-eyebrow">Now on Kindle</p>
    <p class="shiji-ebook-ad-title">Records of the Grand Historian</p>
    <p class="shiji-ebook-ad-text">The complete English translation of Sima Qian’s foundational history is available as a Kindle e-book.</p>
    <p class="shiji-ebook-ad-actions">
      <a class="shiji-ebook-ad-btn" href="https://amzn.to/4vzL5yT" target="_blank" rel="noopener noreferrer sponsored">View on Amazon</a>
      <a class="shiji-ebook-ad-link" href="https://24histories.com/book/shiji.html" target="_blank" rel="noopener noreferrer">Read free on 24 Histories</a>
    </p>
    <p class="shiji-ebook-ad-disclosure">As an Amazon Associate, Garrett M. Petersen earns from qualifying purchases.</p>
  </div>
</aside>
```

---

## CSS snippet

Add to the `<style>` block in `index.html` (near `.rowCredit`):

```css
.shiji-ebook-ad{
  display:flex;align-items:center;gap:14px;margin:20px 0 8px;padding:14px 16px;
  border:1px solid #e0e0e0;border-left:4px solid #9f2f2f;border-radius:12px;
  background:#fff;text-align:left
}
.shiji-ebook-ad-cover{
  flex-shrink:0;width:72px;border-radius:6px;overflow:hidden;
  box-shadow:0 4px 12px rgba(0,0,0,.12)
}
.shiji-ebook-ad-cover img{display:block;width:100%;height:auto}
.shiji-ebook-ad-eyebrow{margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;
  text-transform:uppercase;color:#9f2f2f}
.shiji-ebook-ad-title{margin:0 0 6px;font-size:15px;font-weight:700;color:#222}
.shiji-ebook-ad-text{margin:0 0 10px;font-size:13px;line-height:1.45;color:#444}
.shiji-ebook-ad-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px}
.shiji-ebook-ad-btn{
  display:inline-block;padding:8px 12px;border-radius:20px;background:#9f2f2f;
  color:#fff;text-decoration:none;font-size:13px;font-weight:600
}
.shiji-ebook-ad-link{font-size:12px;color:#4caf50;text-decoration:none}
.shiji-ebook-ad-disclosure{margin:0;font-size:11px;line-height:1.4;color:#888}
@media (max-width:480px){
  .shiji-ebook-ad{flex-direction:column;align-items:flex-start}
}
```

Cover width is fixed at **72px** so the SVG does not expand to its intrinsic 1600px size.

---

## Deploy checklist

1. Copy `shiji-ebook-ad/` (this folder) into the Connecdoku publish root so `shiji.svg` is served.
2. Paste HTML after `#hintContainer` in `index.html`.
3. Paste CSS into `index.html` `<style>`.
4. Add an **Amazon Associates** paragraph to `privacy.html` (mirror 24 Histories wording).
5. Deploy via normal Connecdoku / Cloudflare workflow.
6. Smoke-test: open homepage, confirm cover is thumbnail-sized, all Amazon links include `rel="sponsored"`, disclosure is visible.

---

## Reference — live implementation on 24 Histories

The same book, link, and disclosure are already wired on:

- https://24histories.com/book/shiji.html (hub callout + one-time modal)
- https://24histories.com/ (footer link)
- Source: `records-of-the-grand-historian/public/kindle-promo-shared.js`

**Amazon URL:** `https://amzn.to/4vzL5yT`  
**Site URL:** `https://24histories.com/book/shiji.html`  
**Author / translator:** Garrett M. Petersen  
**Original author:** Sima Qian  
**Brand color:** `#9f2f2f`
