"use strict";
(() => {
  // ../core/src/money.ts
  function money(amountMinor, currency) {
    if (!Number.isInteger(amountMinor)) {
      throw new RangeError(`Money amount must be an integer minor-unit value, got ${amountMinor}`);
    }
    return { amountMinor, currency };
  }

  // ../core/src/reconcile.ts
  var GIFT_LINE_PROPERTY = "_fge_gift";
  function reconcileGiftLines(cart, result) {
    const desired = result.status === "gift" ? result.giftVariantIds : [];
    const desiredSet = new Set(desired);
    const appAddedGiftLines = cart.filter((line) => line.appAdded);
    const remove = [];
    const adjust = [];
    const kept = /* @__PURE__ */ new Set();
    for (const line of appAddedGiftLines) {
      if (!desiredSet.has(line.variantId)) {
        remove.push({ id: line.id, variantId: line.variantId });
        continue;
      }
      if (kept.has(line.variantId)) {
        remove.push({ id: line.id, variantId: line.variantId });
        continue;
      }
      kept.add(line.variantId);
      if (line.quantity !== 1) {
        adjust.push({ id: line.id, variantId: line.variantId, quantity: 1 });
      }
    }
    const add = desired.filter((variantId) => !kept.has(variantId)).map((variantId) => ({
      variantId,
      quantity: 1,
      properties: { [GIFT_LINE_PROPERTY]: "1" }
    }));
    return {
      add,
      remove,
      adjust,
      applyCode: result.status === "gift" ? result.code : null,
      status: result.status,
      reason: result.status === "no-gift" ? result.reason : null
    };
  }

  // src/cartDrawer.ts
  var DRAWER_SELECTORS = [
    "cart-drawer",
    "#CartDrawer",
    ".cart-drawer",
    '[class*="cart-drawer" i]',
    ".drawer--cart",
    "cart-notification"
  ];
  var PANEL_SELECTORS = [".drawer__inner", ".cart-drawer__inner", '[role="dialog"]'];
  var HEADER_SELECTORS = [".drawer__header", ".cart-drawer__header", '[class*="drawer__header" i]'];
  var ITEMS_SELECTORS = [
    "#CartDrawer-CartItems",
    ".drawer__contents",
    ".js-contents",
    ".cart-items",
    '[class*="cart-items" i]'
  ];
  var FOOTER_SELECTORS = [".drawer__footer", ".cart-drawer__footer", '[class*="drawer__footer" i]'];
  function findFirst(root2, selectors) {
    for (const sel of selectors) {
      const el = root2.querySelector(sel);
      if (el !== null) {
        return el;
      }
    }
    return null;
  }
  function findDrawer(selectorOverride) {
    const selectors = selectorOverride ? [selectorOverride, ...DRAWER_SELECTORS] : DRAWER_SELECTORS;
    return findFirst(document, selectors);
  }
  function mountDrawerSections(opts = {}) {
    const stepperEl = document.createElement("div");
    stepperEl.className = "fge fge-stepper-wrap";
    stepperEl.setAttribute("data-fge-stepper", "");
    const chooserEl2 = document.createElement("div");
    chooserEl2.className = "fge";
    chooserEl2.setAttribute("data-fge-chooser", "");
    const drawer2 = findDrawer(opts.drawerSelector);
    const doAttach = () => {
      var _a2, _b2;
      if (drawer2 === null) {
        if (stepperEl.parentNode === null) document.body.append(stepperEl, chooserEl2);
        return;
      }
      const panel = (_a2 = findFirst(drawer2, PANEL_SELECTORS)) != null ? _a2 : drawer2;
      const header = findFirst(panel, HEADER_SELECTORS);
      const itemsEnd = (_b2 = findFirst(panel, FOOTER_SELECTORS)) != null ? _b2 : findFirst(panel, ITEMS_SELECTORS);
      if (header !== null) {
        header.insertAdjacentElement("afterend", stepperEl);
      } else if (stepperEl.parentNode === null) {
        panel.prepend(stepperEl);
      }
      if (itemsEnd !== null) {
        if (FOOTER_SELECTORS.some((s) => itemsEnd.matches(s))) {
          itemsEnd.insertAdjacentElement("beforebegin", chooserEl2);
        } else {
          itemsEnd.insertAdjacentElement("afterend", chooserEl2);
        }
      } else if (chooserEl2.parentNode === null) {
        panel.append(chooserEl2);
      }
    };
    let observer = null;
    const attach = () => {
      observer == null ? void 0 : observer.disconnect();
      try {
        doAttach();
      } finally {
        if (observer !== null && drawer2 !== null) {
          observer.takeRecords();
          observer.observe(drawer2, { childList: true, subtree: true });
        }
      }
    };
    if (drawer2 !== null) {
      observer = new MutationObserver(() => attach());
      observer.observe(drawer2, { childList: true, subtree: true });
    }
    attach();
    return { stepperEl, chooserEl: chooserEl2, attach };
  }

  // src/cartMutations.ts
  var toNumericId = (gid) => Number(gid.split("/").pop());
  var addItem = (a) => ({
    id: toNumericId(a.variantId),
    quantity: a.quantity,
    properties: a.properties
  });
  async function applyCartPlan(plan, post) {
    const removed = [];
    const added = [];
    const adjusted = [];
    const failures = [];
    for (const r of plan.remove) {
      const res = await post("cart/change.js", { id: r.id, quantity: 0 });
      if (res.ok) {
        removed.push(r.id);
      } else {
        failures.push({
          kind: "remove",
          variantId: r.variantId,
          status: res.status,
          body: await res.text()
        });
      }
    }
    for (const a of plan.adjust) {
      const res = await post("cart/change.js", { id: a.id, quantity: a.quantity });
      if (res.ok) {
        adjusted.push(a.id);
      } else {
        failures.push({
          kind: "remove",
          variantId: a.variantId,
          status: res.status,
          body: await res.text()
        });
      }
    }
    if (plan.add.length > 0) {
      const res = await post("cart/add.js", { items: plan.add.map(addItem) });
      if (res.ok) {
        added.push(...plan.add.map((a) => a.variantId));
      } else {
        const body = await res.text();
        logFailure(`batched cart/add.js failed (${res.status}); retrying per item`, body);
        for (const a of plan.add) {
          const one = await post("cart/add.js", { items: [addItem(a)] });
          if (one.ok) {
            added.push(a.variantId);
          } else {
            const oneBody = await one.text();
            failures.push({ kind: "add", variantId: a.variantId, status: one.status, body: oneBody });
            logFailure(`cart/add.js failed for ${a.variantId} (${one.status})`, oneBody);
          }
        }
      }
    }
    return { added, removed, adjusted, failures };
  }
  function failedAddVariantIds(failures) {
    return failures.filter((f) => f.kind === "add").map((f) => f.variantId);
  }
  function logFailure(message, body) {
    var _a2;
    const c = globalThis.console;
    (_a2 = c == null ? void 0 : c.warn) == null ? void 0 : _a2.call(c, `[free-gift] ${message}`, body.slice(0, 300));
  }

  // src/choices.ts
  function groupGiftOptionsByProduct(options) {
    const order = [];
    const byProduct = /* @__PURE__ */ new Map();
    for (const option of options) {
      const existing = byProduct.get(option.productId);
      if (existing === void 0) {
        order.push(option.productId);
        byProduct.set(option.productId, [option]);
      } else {
        existing.push(option);
      }
    }
    return order.map((productId) => {
      var _a2;
      return { productId, options: (_a2 = byProduct.get(productId)) != null ? _a2 : [] };
    });
  }
  function defaultGiftChoices(tiers) {
    var _a2;
    const choices = {};
    for (const tier of tiers) {
      if (tier.gift.kind !== "OR") {
        continue;
      }
      const pick = (_a2 = tier.gift.options.find((o) => o.available)) != null ? _a2 : tier.gift.options[0];
      if (pick !== void 0) {
        choices[tier.tierId] = pick.optionId;
      }
    }
    return choices;
  }

  // src/chooser.ts
  function buildChooserModel(config, state) {
    var _a2;
    if (config.status !== "active") {
      return null;
    }
    const unavailable = (_a2 = state.unavailableVariantIds) != null ? _a2 : /* @__PURE__ */ new Set();
    const isAvailable = (variantId, configAvailable) => configAvailable && !unavailable.has(variantId);
    const tiers = config.tiers.map((tier) => {
      if (tier.gift.kind === "AND") {
        const items = tier.gift.gifts.map((g) => ({
          ...g,
          available: isAvailable(g.variantId, g.available)
        }));
        return {
          kind: "and",
          tierId: tier.tierId,
          threshold: tier.threshold,
          items,
          incomplete: items.some((i) => !i.available)
        };
      }
      const options = tier.gift.options.map((o) => ({
        ...o,
        available: isAvailable(o.variantId, o.available)
      }));
      return {
        kind: "or",
        tierId: tier.tierId,
        threshold: tier.threshold,
        groups: groupGiftOptionsByProduct(options),
        selected: state.choices[tier.tierId]
      };
    });
    return { declineEnabled: config.declineEnabled, declined: state.declined, tiers };
  }
  function renderChooser(mount, config, state, handlers, currentTierId) {
    mount.textContent = "";
    const model = buildChooserModel(config, state);
    if (model === null) {
      return;
    }
    const root2 = document.createElement("div");
    root2.className = "fge-gift";
    const current = currentTierId === null ? null : model.tiers.find((t) => t.tierId === currentTierId);
    if (current === void 0 || current === null) {
      const hint = document.createElement("p");
      hint.className = "fge-gift__hint";
      hint.textContent = "Add a little more to your cart to unlock your free gift.";
      root2.append(hint);
      mount.append(root2);
      return;
    }
    const title = document.createElement("p");
    title.className = "fge-gift__title";
    title.textContent = current.kind === "or" ? "Choose your free gift" : "Your free gift";
    root2.append(title);
    if (current.kind === "or") {
      for (const group of current.groups) {
        for (const opt of group.options) {
          root2.append(
            renderOptionCard(current.tierId, opt, opt.optionId === current.selected, handlers)
          );
        }
      }
    } else {
      root2.append(renderBundle(current));
    }
    if (model.declineEnabled) {
      root2.append(renderDecline(model.declined, handlers));
    }
    mount.append(root2);
  }
  function giftImage(imageUrl, alt) {
    if (imageUrl !== null && imageUrl !== void 0 && imageUrl.length > 0) {
      const img = document.createElement("img");
      img.className = "fge-card__img";
      img.src = imageUrl;
      img.alt = alt;
      img.loading = "lazy";
      return img;
    }
    const ph = document.createElement("div");
    ph.className = "fge-card__img";
    return ph;
  }
  function renderOptionCard(tierId, opt, selected, handlers) {
    const available = opt.available;
    const card = document.createElement("label");
    card.className = "fge-card";
    if (selected) card.classList.add("is-selected");
    if (!available) card.classList.add("is-unavailable");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.className = "fge-card__radio";
    radio.name = `fge-tier-${tierId}`;
    radio.value = opt.optionId;
    radio.checked = selected;
    radio.disabled = !available;
    radio.addEventListener("change", () => handlers.onChoose(tierId, opt.optionId));
    const body = document.createElement("div");
    body.className = "fge-card__body";
    const name = document.createElement("div");
    name.className = "fge-card__name";
    name.textContent = opt.variantLabel;
    const status = document.createElement("div");
    status.className = "fge-card__status";
    if (!available) {
      status.classList.add("is-unavailable");
      status.textContent = "Currently unavailable";
    } else if (selected) {
      status.classList.add("is-unlocked");
      status.textContent = "Unlocked \xB7 added free";
    } else {
      status.textContent = "Choose this gift";
    }
    body.append(name, status);
    card.append(radio, giftImage(opt.imageUrl, opt.variantLabel), body);
    return card;
  }
  function renderBundle(tier) {
    const wrap = document.createElement("div");
    for (const item of tier.items) {
      const card = document.createElement("div");
      card.className = "fge-card";
      if (!item.available) card.classList.add("is-unavailable");
      const body = document.createElement("div");
      body.className = "fge-card__body";
      const name = document.createElement("div");
      name.className = "fge-card__name";
      name.textContent = item.variantLabel;
      const status = document.createElement("div");
      status.className = "fge-card__status";
      if (item.available) {
        status.classList.add("is-unlocked");
        status.textContent = "Unlocked \xB7 added free";
      } else {
        status.classList.add("is-unavailable");
        status.textContent = "Currently unavailable";
      }
      body.append(name, status);
      card.append(giftImage(item.imageUrl, item.variantLabel), body);
      wrap.append(card);
    }
    if (tier.incomplete) {
      const note = document.createElement("p");
      note.className = "fge-note--unavailable";
      note.textContent = "This gift can\u2019t be fully added right now \u2014 please check back.";
      wrap.append(note);
    }
    return wrap;
  }
  function renderDecline(declined2, handlers) {
    const label = document.createElement("label");
    label.className = "fge-decline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !declined2;
    cb.addEventListener("change", () => handlers.onDeclineToggle(!cb.checked));
    label.append(cb, document.createTextNode(" Add my free gift"));
    return label;
  }

  // src/configClient.ts
  var DEFAULT_CONFIG_PATH = "/apps/free-gift/config";
  async function getConfig(request, options = {}) {
    var _a2, _b2;
    const fetchFn = (_a2 = options.fetchFn) != null ? _a2 : fetch;
    const path = (_b2 = options.configPath) != null ? _b2 : DEFAULT_CONFIG_PATH;
    const params = new URLSearchParams({
      currency: request.presentmentCurrency,
      country: request.countryCode
    });
    const response = await fetchFn(`${path}?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      return { ok: false, httpStatus: response.status };
    }
    const body = await response.json();
    return { ok: true, config: body };
  }

  // src/progressGraph.ts
  function giftLabelFor(gift) {
    if (gift.kind === "AND") {
      return gift.gifts.map((g) => g.variantLabel).join(" + ");
    }
    if (gift.options.length <= 3) {
      return gift.options.map((o) => o.variantLabel).join(" / ");
    }
    return `Choose 1 of ${gift.options.length}`;
  }
  function buildProgressModel(config, lastResult2) {
    var _a2;
    if (config.status !== "active") {
      return null;
    }
    const subtotal = (lastResult2 == null ? void 0 : lastResult2.status) === "gift" ? lastResult2.subtotal : null;
    const currentTierId = (lastResult2 == null ? void 0 : lastResult2.status) === "gift" ? lastResult2.tierId : null;
    const tiers = config.tiers.map((tier) => ({
      tierId: tier.tierId,
      position: tier.position,
      threshold: tier.threshold,
      giftLabel: giftLabelFor(tier.gift),
      reached: subtotal !== null && subtotal.amountMinor >= tier.threshold.amountMinor,
      isCurrent: tier.tierId === currentTierId
    }));
    const ascending = [...tiers].sort((a, b) => a.threshold.amountMinor - b.threshold.amountMinor);
    const nextTier = (_a2 = ascending.find((t) => !t.reached)) != null ? _a2 : null;
    const next = nextTier === null ? null : {
      tierId: nextTier.tierId,
      threshold: nextTier.threshold,
      giftLabel: nextTier.giftLabel,
      spendMore: subtotal === null ? null : money(
        Math.max(0, nextTier.threshold.amountMinor - subtotal.amountMinor),
        config.currency
      )
    };
    return {
      currency: config.currency,
      subtotal,
      tiers,
      next,
      allUnlocked: next === null && tiers.length > 0
    };
  }
  var major = (m) => {
    var _a2;
    try {
      const digits = (_a2 = new Intl.NumberFormat(void 0, {
        style: "currency",
        currency: m.currency
      }).resolvedOptions().maximumFractionDigits) != null ? _a2 : 2;
      return m.amountMinor / 10 ** digits;
    } catch {
      return m.amountMinor / 100;
    }
  };
  function fmt(m, compact = false) {
    try {
      return new Intl.NumberFormat(void 0, {
        style: "currency",
        currency: m.currency,
        ...compact ? { maximumFractionDigits: 0 } : {}
      }).format(major(m));
    } catch {
      return `${m.amountMinor} ${m.currency}`;
    }
  }
  function stepperLayout(model) {
    const top = Math.max(...model.tiers.map((t) => t.threshold.amountMinor), 1);
    const fillPct = model.subtotal === null ? 0 : Math.max(0, Math.min(100, model.subtotal.amountMinor / top * 100));
    const nodes = model.tiers.map((t) => {
      const posPct = t.threshold.amountMinor / top * 100;
      const align = posPct <= 8 ? "start" : posPct >= 92 ? "end" : "center";
      return { tierId: t.tierId, posPct, align, reached: t.reached, isCurrent: t.isCurrent };
    });
    return { fillPct, nodes };
  }
  function renderProgress(mount, model) {
    var _a2;
    mount.textContent = "";
    if (model === null) {
      return;
    }
    const headline = document.createElement("p");
    headline.className = "fge-headline";
    if (model.allUnlocked) {
      headline.textContent = "Free gift unlocked";
    } else if (model.next !== null) {
      const amt = document.createElement("span");
      amt.className = "fge-amt";
      amt.textContent = fmt((_a2 = model.next.spendMore) != null ? _a2 : model.next.threshold);
      const verb = model.next.spendMore !== null ? "Spend " : "Reach ";
      const tail = model.next.spendMore !== null ? ` more to unlock ${model.next.giftLabel}` : ` to unlock ${model.next.giftLabel}`;
      headline.append(document.createTextNode(verb), amt, document.createTextNode(tail));
    }
    mount.append(headline);
    const { fillPct, nodes } = stepperLayout(model);
    const byTier = new Map(model.tiers.map((t) => [t.tierId, t]));
    const stepper = document.createElement("div");
    stepper.className = "fge-stepper";
    const track = document.createElement("div");
    track.className = "fge-stepper__track";
    const fill = document.createElement("div");
    fill.className = "fge-stepper__fill";
    fill.style.width = `${fillPct}%`;
    stepper.append(track, fill);
    for (const node of nodes) {
      const step = document.createElement("div");
      step.className = `fge-step fge-step--${node.align}`;
      if (node.reached) step.classList.add("is-reached");
      if (node.isCurrent) step.classList.add("is-current");
      step.style.left = `${node.posPct}%`;
      const dot = document.createElement("div");
      dot.className = "fge-step__dot";
      const label = document.createElement("div");
      label.className = "fge-step__label";
      label.textContent = fmt(byTier.get(node.tierId).threshold, true);
      step.append(dot, label);
      stepper.append(step);
    }
    mount.append(stepper);
    const subnote = document.createElement("p");
    subnote.className = "fge-subnote";
    subnote.textContent = "You receive the gift for your highest unlocked tier \u2014 not one per step.";
    mount.append(subnote);
  }

  // src/reconcileLoop.ts
  async function reconcileGiftCart(io, opts = {}) {
    var _a2, _b2, _c2;
    const maxPasses = (_a2 = opts.maxPasses) != null ? _a2 : 4;
    let appliedCode = (_b2 = opts.initialCode) != null ? _b2 : null;
    const addAttempted = /* @__PURE__ */ new Set();
    const failures = [];
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const { lines, currency } = await io.readCart();
      const result = await io.validate(lines, currency);
      if (result === null) {
        return { passes: pass, converged: false, appliedCode, failures };
      }
      const plan = reconcileGiftLines(lines, result);
      const add = plan.add.filter((a) => !addAttempted.has(a.variantId));
      const cartNeedsChange = add.length > 0 || plan.remove.length > 0 || plan.adjust.length > 0;
      const codeNeedsChange = plan.applyCode !== appliedCode;
      if (!cartNeedsChange && !codeNeedsChange) {
        return { passes: pass, converged: true, appliedCode, failures };
      }
      if (cartNeedsChange) {
        for (const a of add) {
          addAttempted.add(a.variantId);
        }
        const res = await applyCartPlan({ ...plan, add }, io.post);
        failures.push(...res.failures);
      }
      if (codeNeedsChange) {
        await io.setDiscount(plan.applyCode);
        appliedCode = plan.applyCode;
      }
      (_c2 = io.nudge) == null ? void 0 : _c2.call(io);
    }
    return { passes: maxPasses, converged: false, appliedCode, failures };
  }

  // src/styles.ts
  var FGE_STYLE_ID = "fge-styles";
  var FGE_CSS = `
.fge{
  --fge-ink:#111111; --fge-muted:#707070; --fge-subtle:#f5f5f5;
  --fge-line:#e3e3e3; --fge-brand:#111111; --fge-brand-strong:#000000; --fge-card-radius:10px;
  box-sizing:border-box; font-family:inherit; line-height:1.35;
}
.fge *{ box-sizing:border-box; }

/* --- top: COMPACT progress row (blended, no box/shadow). Deliberately slim: one small headline +
   a visible bar, so the cart items below keep real space and the theme's own "Your cart" header
   stays the top of the drawer. No eyebrow, no big headline competing with it. --- */
.fge-stepper-wrap{ padding:4px 2px 2px; color:var(--fge-ink); }

.fge-headline{ margin:0 0 2px; font-size:12px; font-weight:600; color:var(--fge-ink); }
.fge-headline .fge-amt{ color:var(--fge-brand-strong); font-weight:750; }
.fge-subnote{ margin:6px 0 0; font-size:10px; line-height:1.3; color:var(--fge-muted); }

/* --- the progress stepper: a clearly visible slim bar. Explicit px geometry (NOT inset:0 + parent
   height) so the track/fill/dots render reliably regardless of the host theme's resets. The bar area
   is 14px tall; the track is a 4px line centred in it; dots (12px) sit on the track; labels hang below. */
.fge-stepper{ position:relative; height:14px; margin:10px 6px 26px; }
.fge-stepper__track{
  position:absolute; left:0; right:0; top:5px; height:4px;
  background-color:var(--fge-line); border-radius:999px;
}
.fge-stepper__fill{
  position:absolute; left:0; top:5px; height:4px; min-width:0;
  background-color:var(--fge-brand); border-radius:999px; transition:width .35s ease;
}
.fge-step{ position:absolute; top:7px; transform:translate(-50%,-50%); }
.fge-step__dot{
  width:12px; height:12px; border-radius:50%; display:block;
  background-color:#ffffff; border:2px solid var(--fge-line);
}
.fge-step.is-reached .fge-step__dot{
  background-color:var(--fge-brand); border-color:var(--fge-brand);
}
.fge-step.is-current .fge-step__dot{
  background-color:var(--fge-brand); border-color:var(--fge-brand);
  box-shadow:0 0 0 4px rgba(17,17,17,.16);
}
.fge-step__label{
  position:absolute; top:13px; left:50%; transform:translateX(-50%);
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
  function injectStyles() {
    const doc = globalThis.document;
    if (doc === void 0 || doc.getElementById(FGE_STYLE_ID) !== null) {
      return;
    }
    const style = doc.createElement("style");
    style.id = FGE_STYLE_ID;
    style.textContent = FGE_CSS;
    doc.head.append(style);
  }

  // src/validateClient.ts
  var DEFAULT_PROXY_PATH = "/apps/free-gift/validate";
  async function postValidate(request, options = {}) {
    var _a2, _b2;
    const fetchFn = (_a2 = options.fetchFn) != null ? _a2 : fetch;
    const path = (_b2 = options.proxyPath) != null ? _b2 : DEFAULT_PROXY_PATH;
    const response = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    const body = await response.json();
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        error: body.error
      };
    }
    return { ok: true, result: body };
  }

  // src/storefront.ts
  var SOURCE = "free-gift-engine";
  var CART_UPDATE_EVENT = "cart-update";
  var DEBOUNCE_MS = 300;
  var w = window;
  var _a, _b, _c;
  var root = (_c = (_b = (_a = w.Shopify) == null ? void 0 : _a.routes) == null ? void 0 : _b.root) != null ? _c : "/";
  var toGid = (variantId) => `gid://shopify/ProductVariant/${variantId}`;
  var isGiftLine = (item) => item.properties != null && item.properties[GIFT_LINE_PROPERTY] != null;
  function readConfig() {
    var _a2, _b2, _c2;
    const el = document.querySelector("[data-fge-app-block]");
    if (el === null) {
      return null;
    }
    return {
      proxyPath: (_a2 = el.dataset["proxyPath"]) != null ? _a2 : "/apps/free-gift/validate",
      country: (_b2 = el.dataset["country"]) != null ? _b2 : "",
      presentmentCurrency: (_c2 = el.dataset["presentmentCurrency"]) != null ? _c2 : "",
      drawerSelector: el.dataset["drawerSelector"]
    };
  }
  async function getCart() {
    const res = await fetch(`${root}cart.js`, { headers: { Accept: "application/json" } });
    return await res.json();
  }
  var selfMutating = false;
  var running = false;
  var pending = false;
  var lastDiscount = null;
  var choiceState = {};
  var declined = false;
  var campaignConfig = null;
  var lastResult = null;
  var unavailableVariantIds = /* @__PURE__ */ new Set();
  var drawer = null;
  var graphEl = null;
  var chooserEl = null;
  var cartPost = (path, body) => fetch(`${root}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  async function postJson(path, body) {
    await cartPost(path, body);
  }
  async function readCartLines() {
    const cart = await getCart();
    const lines = cart.items.map((item) => ({
      id: item.key,
      variantId: toGid(item.variant_id),
      quantity: item.quantity,
      appAdded: isGiftLine(item)
    }));
    return { lines, currency: cart.currency };
  }
  async function reconcileOnce(config) {
    selfMutating = true;
    try {
      const outcome = await reconcileGiftCart(
        {
          readCart: readCartLines,
          // Server-authoritative: every line carries its app-added claim; the server EXCLUDES app-added
          // gift lines from the qualifying subtotal. Choices + decline are chooser-driven (same wire shape).
          validate: async (lines, currency) => {
            const request = {
              cart: lines.map((l) => ({
                variantId: l.variantId,
                quantity: l.quantity,
                appAdded: l.appAdded
              })),
              choices: choiceState,
              declined,
              presentmentCurrency: currency,
              countryCode: config.country
            };
            const response = await postValidate(request, { proxyPath: config.proxyPath });
            if (!response.ok) {
              return null;
            }
            lastResult = response.result;
            return response.result;
          },
          post: cartPost,
          setDiscount: (code) => postJson("cart/update.js", { discount: code != null ? code : "" }),
          // Nudge the theme to re-render its cart UI; tagged with our source so we ignore the echo.
          nudge: () => {
            var _a2;
            return (_a2 = w.publish) == null ? void 0 : _a2.call(w, CART_UPDATE_EVENT, { source: SOURCE });
          }
        },
        { initialCode: lastDiscount }
      );
      lastDiscount = outcome.appliedCode;
      for (const variantId of failedAddVariantIds(outcome.failures)) {
        unavailableVariantIds.add(variantId);
      }
      renderPerception(config);
    } finally {
      selfMutating = false;
    }
  }
  function renderPerception(config) {
    if (campaignConfig === null || graphEl === null || chooserEl === null) {
      return;
    }
    const currentTierId = (lastResult == null ? void 0 : lastResult.status) === "gift" ? lastResult.tierId : null;
    renderProgress(graphEl, buildProgressModel(campaignConfig, lastResult));
    renderChooser(
      chooserEl,
      campaignConfig,
      { choices: choiceState, declined, unavailableVariantIds },
      {
        onChoose: (tierId, optionId) => {
          choiceState = { ...choiceState, [tierId]: optionId };
          renderPerception(config);
          schedule(config);
        },
        onDeclineToggle: (next) => {
          declined = next;
          renderPerception(config);
          schedule(config);
        }
      },
      currentTierId
    );
    drawer == null ? void 0 : drawer.attach();
  }
  function schedule(config) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void reconcileOnce(config).catch(() => void 0).finally(() => {
      running = false;
      if (pending) {
        pending = false;
        schedule(config);
      }
    });
  }
  async function initPerception(config) {
    injectStyles();
    drawer = mountDrawerSections({ drawerSelector: config.drawerSelector });
    graphEl = drawer.stepperEl;
    chooserEl = drawer.chooserEl;
    const result = await getConfig({
      presentmentCurrency: config.presentmentCurrency,
      countryCode: config.country
    });
    if (!result.ok || result.config.status !== "active") {
      return;
    }
    campaignConfig = result.config;
    choiceState = defaultGiftChoices(campaignConfig.tiers);
    renderPerception(config);
  }
  function init() {
    var _a2;
    const config = readConfig();
    if (config === null) {
      return;
    }
    let timer;
    const trigger = (data) => {
      if (data !== null && typeof data === "object" && data.source === SOURCE) {
        return;
      }
      if (timer !== void 0) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => schedule(config), DEBOUNCE_MS);
    };
    (_a2 = w.subscribe) == null ? void 0 : _a2.call(w, CART_UPDATE_EVENT, trigger);
    const originalFetch = w.fetch.bind(w);
    w.fetch = async (input, init2) => {
      const result = await originalFetch(input, init2);
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!selfMutating && /\/cart\/(add|change|update|clear)(\.js)?/.test(url)) {
        trigger();
      }
      return result;
    };
    void initPerception(config).finally(() => schedule(config));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
