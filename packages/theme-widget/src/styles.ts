// Design tokens + component CSS for the free-gift drawer panel (Phase 5b-2b-1 polish). Injected once.
// Direction: a calm, "evergreen reward" identity for a snowboard store's gift-with-purchase — green
// progress (the trail to your gift) with a single muted-gold "reward" accent for the unlocked gift.
// Restraint: inherit the theme's font (don't fight the storefront); carry hierarchy with weight,
// letter-spacing and an uppercase eyebrow. Signature: the horizontal "trail" stepper. Quality floor:
// opaque surfaces (no bleed-through), visible keyboard focus, reduced-motion respected.
export const FGE_STYLE_ID = 'fge-styles';

export const FGE_CSS = `
[data-fge-overlay]{
  --fge-ink:#16271d; --fge-muted:#5d6f63; --fge-surface:#ffffff; --fge-subtle:#f4f8f5;
  --fge-line:#d8e3da; --fge-brand:#1f7a4d; --fge-brand-strong:#155f3a; --fge-gift:#b8862f;
  --fge-radius:14px; --fge-card-radius:10px;
  box-sizing:border-box; color:var(--fge-ink);
  font-family:inherit; line-height:1.35; -webkit-font-smoothing:antialiased;
  background:var(--fge-surface);
  border:1px solid var(--fge-line); border-radius:var(--fge-radius);
  box-shadow:0 14px 38px rgba(20,39,30,.20);
  padding:16px 16px 14px;
}
[data-fge-overlay] *{ box-sizing:border-box; }

.fge-eyebrow{
  margin:0 0 2px; font-size:11px; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
  color:var(--fge-brand-strong);
}
.fge-headline{ margin:0 0 12px; font-size:15px; font-weight:650; color:var(--fge-ink); }
.fge-headline .fge-amt{ color:var(--fge-brand-strong); }
.fge-subnote{ margin:6px 0 0; font-size:11.5px; color:var(--fge-muted); }

/* --- the trail stepper (signature) --- */
.fge-stepper{ position:relative; margin:14px 6px 30px; height:6px; }
.fge-stepper__track{ position:absolute; inset:0; background:var(--fge-line); border-radius:999px; }
.fge-stepper__fill{
  position:absolute; left:0; top:0; bottom:0; background:var(--fge-brand);
  border-radius:999px; transition:width .35s ease;
}
.fge-step{ position:absolute; top:50%; transform:translate(-50%,-50%); text-align:center; }
.fge-step__dot{
  width:14px; height:14px; border-radius:50%; background:var(--fge-surface);
  border:2px solid var(--fge-line); margin:0 auto;
}
.fge-step.is-reached .fge-step__dot{ background:var(--fge-brand); border-color:var(--fge-brand); }
.fge-step.is-current .fge-step__dot{
  background:var(--fge-gift); border-color:var(--fge-gift);
  box-shadow:0 0 0 4px rgba(184,134,47,.22);
}
.fge-step__label{
  position:absolute; top:16px; left:50%; transform:translateX(-50%);
  white-space:nowrap; font-size:11px; font-weight:600; color:var(--fge-muted);
}
.fge-step.is-reached .fge-step__label{ color:var(--fge-brand-strong); }

/* --- gift panel --- */
.fge-gift{ border-top:1px solid var(--fge-line); padding-top:12px; }
.fge-gift__title{ margin:0 0 8px; font-size:13px; font-weight:700; letter-spacing:.01em; }
.fge-gift__hint{ margin:0; font-size:13px; color:var(--fge-muted); }

.fge-card{
  display:flex; align-items:center; gap:11px; width:100%; text-align:left;
  background:var(--fge-subtle); border:1.5px solid var(--fge-line);
  border-radius:var(--fge-card-radius); padding:8px 10px; margin:0 0 8px; cursor:pointer;
}
.fge-card:focus-within{ outline:2px solid var(--fge-brand); outline-offset:2px; }
.fge-card.is-selected{ border-color:var(--fge-brand); background:#eef5f0; }
.fge-card.is-unavailable{ opacity:.6; cursor:not-allowed; }
.fge-card__radio{ accent-color:var(--fge-brand); width:16px; height:16px; flex:0 0 auto; }
.fge-card__img{
  width:46px; height:46px; flex:0 0 auto; border-radius:8px; object-fit:cover;
  background:#e7eee9; border:1px solid var(--fge-line);
}
.fge-card__body{ flex:1 1 auto; min-width:0; }
.fge-card__name{ font-size:13px; font-weight:600; color:var(--fge-ink); }
.fge-card__status{ font-size:11.5px; color:var(--fge-muted); margin-top:1px; }
.fge-card__status.is-unlocked{ color:var(--fge-gift); font-weight:700; }
.fge-card__status.is-unavailable{ color:#9a6a00; }

.fge-bundle{ display:flex; align-items:center; gap:10px; }
.fge-bundle .fge-plus{ color:var(--fge-muted); font-weight:700; }

.fge-note--unavailable{ margin:4px 0 0; font-size:11.5px; color:#9a6a00; }

.fge-decline{
  display:flex; align-items:center; gap:8px; margin:12px 0 0; padding-top:11px;
  border-top:1px solid var(--fge-line); font-size:13px; color:var(--fge-ink); cursor:pointer;
}
.fge-decline input{ accent-color:var(--fge-brand); width:16px; height:16px; }

@media (prefers-reduced-motion: reduce){
  .fge-stepper__fill{ transition:none; }
}
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
