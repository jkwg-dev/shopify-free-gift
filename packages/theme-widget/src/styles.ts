// Design tokens + component CSS for the in-flow free-gift sections (injected into the cart drawer).
// Direction: a quiet MONOCHROME identity matching the theme's black/neutral look, and BLENDED INTO the
// drawer — no floating card, no shadow, transparent/inherited background; the stepper reads as a slim
// progress row, the chooser as a section below the items with a light divider. Restraint: inherit the
// theme's font; carry hierarchy with weight, letter-spacing, an uppercase eyebrow. Quality floor:
// visible keyboard focus, reduced-motion respected.
export const FGE_STYLE_ID = 'fge-styles';

export const FGE_CSS = `
.fge{
  --fge-ink:#111111; --fge-muted:#707070; --fge-subtle:#f5f5f5;
  --fge-line:#e3e3e3; --fge-brand:#111111; --fge-brand-strong:#000000; --fge-card-radius:10px;
  box-sizing:border-box; font-family:inherit; line-height:1.35;
}
.fge *{ box-sizing:border-box; }

/* --- top: slim progress row (blended, no box/shadow) --- */
.fge-stepper-wrap{ padding:8px 2px 6px; color:var(--fge-ink); }

.fge-eyebrow{
  margin:0 0 2px; font-size:10.5px; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
  color:var(--fge-muted);
}
.fge-headline{ margin:0 0 10px; font-size:13.5px; font-weight:650; color:var(--fge-ink); }
.fge-headline .fge-amt{ color:var(--fge-brand-strong); font-weight:750; }
.fge-subnote{ margin:6px 0 0; font-size:11px; color:var(--fge-muted); }

/* --- the progress stepper --- */
.fge-stepper{ position:relative; margin:12px 6px 28px; height:6px; }
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
  background:var(--fge-brand); border-color:var(--fge-brand);
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

/* --- gift panel (below the cart items; capped so a tall OR tier doesn't push checkout off-screen) --- */
.fge-gift{
  border-top:1px solid var(--fge-line); padding-top:12px; margin-top:4px;
  max-height:42vh; overflow:auto;
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

.fge-note--unavailable{ margin:4px 0 0; font-size:11.5px; color:#8a8a8a; }

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
