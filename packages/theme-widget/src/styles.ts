// Design tokens + component CSS for the in-flow free-gift sections (injected into the cart drawer).
// Direction: a quiet MONOCHROME identity matching the theme's black/neutral look, and BLENDED INTO the
// drawer — no floating card, no shadow, transparent/inherited background; the stepper reads as a slim
// progress row (one small headline + a visible bar), the chooser as a section below the items with a
// light divider. Restraint: inherit the theme's font; carry hierarchy with weight, not size. Quality
// floor: visible keyboard focus, reduced-motion respected.
export const FGE_STYLE_ID = 'fge-styles';

export const FGE_CSS = `
.fge{
  --fge-ink:#111111; --fge-muted:#707070; --fge-subtle:#f5f5f5;
  --fge-line:#e3e3e3; --fge-brand:#111111; --fge-brand-strong:#000000; --fge-card-radius:10px;
  box-sizing:border-box; font-family:inherit; line-height:1.35;
}
.fge *{ box-sizing:border-box; }

/* --- top: a compact BANNER CARD (subtle outline + light fill, no heavy shadow). The headline is
   only "Spend CA$X more to unlock <gift>" (or "You've unlocked…"); the theme's own "Your cart" drawer
   header sits separately above and is NOT restated here. Kept slim so cart items below keep space. --- */
.fge-stepper-wrap{
  margin:6px 0 4px; padding:11px 14px 8px; color:var(--fge-ink);
  border:1px solid var(--fge-line); border-radius:12px; background-color:#fafafa;
}

.fge-headline{ margin:0 0 2px; font-size:12.5px; font-weight:600; color:var(--fge-ink); }
.fge-headline .fge-amt{ color:var(--fge-brand-strong); font-weight:750; }
.fge-subnote{ margin:6px 0 0; font-size:10px; line-height:1.3; color:var(--fge-muted); }

/* --- the progress stepper: a clearly visible slim bar. Explicit px geometry (NOT inset:0 + parent
   height) so the track/fill/dots render reliably regardless of the host theme's resets. Bar area 16px;
   a 4px track centred in it; a 14px dot per tier on the track; labels hang below (room via margin). */
.fge-stepper{ position:relative; height:16px; margin:14px 8px 30px; }
.fge-stepper__track{
  position:absolute; left:0; right:0; top:6px; height:4px;
  background-color:var(--fge-line); border-radius:999px;
}
.fge-stepper__fill{
  position:absolute; left:0; top:6px; height:4px; min-width:0;
  background-color:var(--fge-brand); border-radius:999px; transition:width .35s ease;
}
.fge-step{ position:absolute; top:8px; transform:translate(-50%,-50%); transition:left .35s ease; }
.fge-step__dot{
  width:14px; height:14px; border-radius:50%;
  background-color:#ffffff; border:2px solid var(--fge-line);
  transition:background-color .3s ease, border-color .3s ease, box-shadow .3s ease;
}
.fge-step.is-reached .fge-step__dot{
  background-color:var(--fge-brand); border-color:var(--fge-brand);
}
.fge-step.is-current .fge-step__dot{
  background-color:var(--fge-brand); border-color:var(--fge-brand);
  box-shadow:0 0 0 4px rgba(17,17,17,.16);
}
.fge-step__label{
  position:absolute; top:16px; left:50%; transform:translateX(-50%);
  white-space:nowrap; font-size:10.5px; font-weight:600; color:var(--fge-muted);
}
/* Edge-aware label alignment so the first/last labels stay inside the track (no right-edge clip). */
.fge-step--start .fge-step__label{ left:0; transform:none; text-align:left; }
.fge-step--end .fge-step__label{ left:auto; right:0; transform:none; text-align:right; }
.fge-step.is-reached .fge-step__label{ color:var(--fge-brand-strong); }

/* THEME-OVERRIDE: Dawn's base.css hides empty block elements (div:empty{display:none}). Our bar, its
   fill, each tier dot, and the no-image card placeholder are intentionally EMPTY visual divs — without
   this they vanish and only the text labels survive. !important beats the theme's :empty rule. */
.fge-stepper__track,
.fge-stepper__fill,
.fge-step__dot,
.fge-card__img{ display:block !important; }

/* THEME-OVERRIDE: Dawn renders TWO "Your cart" titles inside the drawer — the H2.drawer__heading
   (header) and the H1.title--primary (cart section title, normally suppressed). Our injected layout
   surfaces both, so we hide the section-title duplicate — SCOPED to drawer containers only, so the
   cart PAGE's own H1.title--primary is untouched. No-op on themes where it isn't present. */
cart-drawer .title--primary,
#CartDrawer .title--primary,
.drawer__inner .title--primary{ display:none !important; }

/* --- gift panel: lives INSIDE the drawer's scrollable items region, after the line items, so it
   scrolls with the cart (no inner max-height/scroll — that would nest a scrollbar and pin it). --- */
.fge-gift{
  border-top:1px solid var(--fge-line); padding-top:12px; margin-top:8px;
}
.fge-gift__title{ margin:0 0 8px; font-size:13px; font-weight:700; letter-spacing:.01em; }
.fge-gift__hint{ margin:0; font-size:13px; color:var(--fge-muted); }

.fge-card{
  display:flex; align-items:center; gap:11px; width:100%; text-align:left;
  background:var(--fge-subtle); border:1.5px solid var(--fge-line);
  border-radius:var(--fge-card-radius); padding:8px 10px; margin:0 0 8px; cursor:pointer;
}
.fge-card:focus-within{ outline:2px solid var(--fge-brand); outline-offset:2px; }
.fge-card.is-selected{ border-color:var(--fge-brand); background:#f0f0f0; }
.fge-card.is-unavailable{ opacity:.55; cursor:not-allowed; }
.fge-card__radio{ accent-color:var(--fge-brand); width:16px; height:16px; flex:0 0 auto; }
.fge-card__img{
  width:46px; height:46px; flex:0 0 auto; border-radius:8px; object-fit:cover;
  background:#ececec; border:1px solid var(--fge-line);
}
.fge-card__body{ flex:1 1 auto; min-width:0; }
.fge-card__name{ font-size:13px; font-weight:600; color:var(--fge-ink); }
.fge-card__status{ font-size:11.5px; color:var(--fge-muted); margin-top:1px; }
.fge-card__status.is-unlocked{ color:var(--fge-ink); font-weight:700; }
.fge-card__status.is-unavailable{ color:#8a8a8a; }

/* Variant chips (Ice/Dawn, S/M/L) INSIDE the card body, directly under the product title. A row of
   small rounded pills. The theme forces block/full-width on buttons in the cart form, so display +
   width are overridden with !important so each pill shrink-wraps its label (S / M / L). */
.fge-variants{ display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.fge-variant{
  display:inline-flex !important; width:auto !important; flex:0 0 auto;
  align-items:center; justify-content:center;
  font:inherit; font-size:12px; line-height:1; padding:6px 11px; min-width:34px; cursor:pointer;
  background:#fff; color:var(--fge-ink); border:1.5px solid var(--fge-line); border-radius:999px;
}
.fge-variant.is-selected{ background:var(--fge-brand); color:#fff; border-color:var(--fge-brand); }
.fge-variant:focus-visible{ outline:2px solid var(--fge-brand); outline-offset:2px; }
.fge-variant.is-unavailable{ opacity:.5; cursor:not-allowed; text-decoration:line-through; }

.fge-note--unavailable{ margin:4px 0 0; font-size:11.5px; color:#8a8a8a; }

/* Pending (a gift reconcile is in progress): dim the cards/chips; the decline control stays
   full-opacity (still usable). The message lives on the Checkout button; the chooser shows a spinner
   next to its heading instead of a text line. */
.fge-gift.is-pending .fge-card,
.fge-gift.is-pending .fge-variants{ opacity:.5; transition:opacity .2s ease; }

/* Small neutral spinner (chooser heading + the Checkout button overlay reuse the same keyframes). The
   visible arc (border-top-color != the ring) is what makes the rotation readable. Centering uses layout
   (inline-block / position), NEVER transform — so fge-spin owns transform purely for rotation and the
   spinner rotates IN PLACE instead of bobbing. */
.fge-spinner{
  display:inline-block; width:13px; height:13px; margin-left:8px; vertical-align:-2px;
  border:2px solid var(--fge-line); border-top-color:var(--fge-ink); border-radius:50%;
  animation:fge-spin .7s linear infinite;
}
@keyframes fge-spin{ from{ transform:rotate(0deg); } to{ transform:rotate(360deg); } }

.fge-decline{
  display:flex; align-items:center; gap:8px; margin:12px 0 0; padding-top:11px;
  border-top:1px solid var(--fge-line); font-size:13px; color:var(--fge-ink); cursor:pointer;
}
.fge-decline input{ accent-color:var(--fge-brand); width:16px; height:16px; }
.fge-decline:focus-within{ outline:2px solid var(--fge-brand); outline-offset:2px; border-radius:4px; }

/* Visually-hidden but screen-reader-readable (the pending live region). A <span> so the theme's
   div:empty rule never hides it; persistently present, announces on textContent change. */
.fge-sr-only{
  position:absolute !important; width:1px; height:1px; margin:-1px; padding:0;
  overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap; border:0;
}

/* THEME-OVERRIDE: lock + load the theme's Checkout button (drawer + /cart) while a gift reconcile is
   in progress, so the shopper can't pay before the gift is confirmed at $0, and the button itself
   explains why. ALL via the body class (no innerHTML swap), so it survives the theme re-rendering its
   footer AND restores the original "Check out" label exactly when the class is removed. The original
   label is hidden (color:transparent) and a spinner (::before) + message (::after) overlay it.
   Cleared on every terminal outcome + a safety timeout, so Checkout can never get stuck. */
body.fge-checkout-pending #CartDrawer-Checkout,
body.fge-checkout-pending #checkout,
body.fge-checkout-pending [name="checkout"],
body.fge-checkout-pending .cart__checkout-button{
  pointer-events:none !important; cursor:not-allowed !important; opacity:.7 !important;
  position:relative !important; color:transparent !important;
}
body.fge-checkout-pending #CartDrawer-Checkout::before,
body.fge-checkout-pending #checkout::before,
body.fge-checkout-pending [name="checkout"]::before,
body.fge-checkout-pending .cart__checkout-button::before{
  content:""; box-sizing:border-box; position:absolute; top:calc(50% - 7.5px); left:18px;
  width:15px; height:15px; border:2px solid rgba(255,255,255,.45); border-top-color:#fff;
  border-radius:50%; animation:fge-spin .7s linear infinite;
}
body.fge-checkout-pending #CartDrawer-Checkout::after,
body.fge-checkout-pending #checkout::after,
body.fge-checkout-pending [name="checkout"]::after,
body.fge-checkout-pending .cart__checkout-button::after{
  content:"Updating your free gift…"; position:absolute; inset:0; display:flex;
  align-items:center; justify-content:center; color:#fff; font-size:13px;
  letter-spacing:normal; text-transform:none;
}

@media (prefers-reduced-motion: reduce){
  .fge-stepper__fill, .fge-step, .fge-step__dot, .fge-gift.is-pending .fge-card,
  .fge-gift.is-pending .fge-variants{ transition:none; }
  .fge-spinner,
  body.fge-checkout-pending #CartDrawer-Checkout::before,
  body.fge-checkout-pending #checkout::before,
  body.fge-checkout-pending [name="checkout"]::before,
  body.fge-checkout-pending .cart__checkout-button::before{ animation:none; }
}

/* --- Stage 1: two-group cart layout (buys / gets). Quiet, blended group headers + read-only gift
   rows. These target the theme's own line nodes (which lack the .fge token scope), so colors are
   explicit hex matching the tokens above. No card/divider — just labeled sections in the same list. */
.fge-group-head{ background:transparent; }
.fge-group-head__cell{ padding:14px 0 6px; border:0; }
.fge-group-head__title{
  display:block; font-size:11px; font-weight:700; letter-spacing:.04em;
  text-transform:uppercase; color:#707070;
}
.fge-group-head__sub{ display:block; margin-top:1px; font-size:11px; font-weight:600; color:#111111; }
/* The "Free gift" / "Free gift — pending" badge injected into a gift line when the theme shows no
   discount label, and the relabeled discount node. */
.fge-line-badge, .fge-free-badge{
  display:inline-block; font-size:11px; font-weight:700; color:#111111; text-transform:none;
  letter-spacing:normal;
}
.fge-gift-line--pending .fge-line-badge{ color:#8a6d00; } /* amber: not-yet-free, needs attention */

/* --- Stage 2: the interactive merged stepper injected on a SPLIT buy row (replaces the theme's native
   per-split stepper, which would write only one split key). A slim −/qty/+ group + a quiet "Remove",
   styled to read like a cart control without depending on the theme's button CSS. --- */
.fge-merged-stepper{
  display:inline-flex; align-items:center; gap:2px; flex-wrap:wrap;
}
.fge-merged-stepper__btn{
  appearance:none; -webkit-appearance:none; cursor:pointer;
  min-width:30px; height:30px; padding:0 6px; line-height:1;
  font-size:15px; font-weight:600; color:#111111;
  background:#ffffff; border:1px solid #cfcfcf; border-radius:6px;
}
.fge-merged-stepper__qty{
  min-width:28px; padding:0 6px; text-align:center; font-size:13px; font-weight:600; color:#111111;
}
.fge-merged-stepper__remove{
  appearance:none; -webkit-appearance:none; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center;
  margin-left:6px; padding:0; width:30px; height:30px;
  color:#707070; background:transparent; border:0;
}
.fge-merged-stepper__remove:hover{ color:#111111; }
.fge-merged-stepper__btn:focus-visible, .fge-merged-stepper__remove:focus-visible{
  outline:2px solid var(--fge-brand); outline-offset:2px;
}
.fge-merged-stepper.is-busy{ opacity:.55; }
.fge-merged-stepper__btn:disabled, .fge-merged-stepper__remove:disabled{ cursor:default; }
/* A marked overlap unit kept read-only in the buys group (issue-#6 / §M): subtly de-emphasized. */
.fge-buy-line--locked{ opacity:.9; }

/* --- Stage 2 (defect B.1): a transient failure notice (e.g. a VF-blocked update). Fixed bottom-center
   toast, appended to <body>; hidden until is-visible. Reduced-motion friendly (opacity only). --- */
.fge-notice{
  position:fixed; left:50%; bottom:20px; transform:translateX(-50%);
  z-index:2147483000; max-width:min(92vw,420px); padding:11px 16px;
  font-size:13px; font-weight:600; line-height:1.35; color:#ffffff;
  background:#1a1a1a; border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.28);
  opacity:0; pointer-events:none; transition:opacity .2s ease;
}
.fge-notice.is-visible{ opacity:1; }
`;

export function injectStyles(): void {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined || doc.getElementById(FGE_STYLE_ID) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.id = FGE_STYLE_ID;
  style.textContent = FGE_CSS;
  doc.head.append(style);
}
