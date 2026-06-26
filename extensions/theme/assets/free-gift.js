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

  // src/cartSections.ts
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
  var PAGE_HEADER_SELECTORS = ["h1.title--primary", ".title--primary"];
  var PAGE_ITEMS_SELECTORS = ["#main-cart-items", ".cart__items"];
  var PAGE_FOOTER_SELECTORS = ["#main-cart-footer"];
  function planInsertions(strategy, present) {
    const out = [];
    if (present.header) {
      out.push({ el: "stepper", mode: "afterend", anchor: "header" });
    } else if (!strategy.strict) {
      out.push({ el: "stepper", mode: "prepend", anchor: "panel" });
    } else {
      out.push({ el: "stepper", mode: "skip", anchor: "panel" });
    }
    if (strategy.chooserInsideItems) {
      if (present.items) {
        out.push({ el: "chooser", mode: "append", anchor: "items" });
      } else if (!strategy.strict && present.footer) {
        out.push({ el: "chooser", mode: "beforebegin", anchor: "footer" });
      } else if (!strategy.strict) {
        out.push({ el: "chooser", mode: "append", anchor: "panel" });
      } else {
        out.push({ el: "chooser", mode: "skip", anchor: "items" });
      }
    } else {
      if (present.items) {
        out.push({ el: "chooser", mode: "afterend", anchor: "items" });
      } else if (!strategy.strict) {
        out.push({ el: "chooser", mode: "append", anchor: "panel" });
      } else {
        out.push({ el: "chooser", mode: "skip", anchor: "items" });
      }
    }
    return out;
  }
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
  function doAttach(spec, stepperEl, chooserEl) {
    var _a2;
    const panel = spec.panelSelectors.length > 0 ? (_a2 = findFirst(spec.observeRoot, spec.panelSelectors)) != null ? _a2 : spec.observeRoot : spec.observeRoot;
    const anchors = {
      header: findFirst(panel, spec.headerSelectors),
      items: findFirst(panel, spec.itemsSelectors),
      footer: findFirst(panel, spec.footerSelectors),
      panel
    };
    const plan = planInsertions(
      { chooserInsideItems: spec.chooserInsideItems, strict: spec.strict },
      {
        header: anchors.header !== null,
        items: anchors.items !== null,
        footer: anchors.footer !== null
      }
    );
    for (const step of plan) {
      const el = step.el === "stepper" ? stepperEl : chooserEl;
      const anchor = anchors[step.anchor];
      if (anchor === null) {
        continue;
      }
      switch (step.mode) {
        case "skip":
          break;
        case "afterend":
          if (anchor.nextElementSibling !== el) {
            anchor.insertAdjacentElement("afterend", el);
          }
          break;
        case "beforebegin":
          if (anchor.previousElementSibling !== el) {
            anchor.insertAdjacentElement("beforebegin", el);
          }
          break;
        case "append":
          if (step.anchor === "items") {
            if (anchor.lastElementChild !== el) {
              anchor.append(el);
            }
          } else if (el.parentNode === null) {
            anchor.append(el);
          }
          break;
        case "prepend":
          if (el.parentNode === null) {
            anchor.prepend(el);
          }
          break;
      }
    }
  }
  function mountOne(spec) {
    const stepperEl = document.createElement("div");
    stepperEl.className = "fge fge-stepper-wrap";
    stepperEl.setAttribute("data-fge-stepper", "");
    const chooserEl = document.createElement("div");
    chooserEl.className = "fge";
    chooserEl.setAttribute("data-fge-chooser", "");
    let observer = null;
    const attach = () => {
      observer == null ? void 0 : observer.disconnect();
      try {
        doAttach(spec, stepperEl, chooserEl);
      } finally {
        if (observer !== null) {
          observer.takeRecords();
          observer.observe(spec.observeRoot, { childList: true, subtree: true });
        }
      }
    };
    observer = new MutationObserver(() => attach());
    observer.observe(spec.observeRoot, { childList: true, subtree: true });
    attach();
    return { context: spec.context, stepperEl, chooserEl, attach };
  }
  function mountCartContexts(opts = {}) {
    var _a2;
    const specs = [];
    const drawer = findDrawer(opts.drawerSelector);
    if (drawer !== null) {
      specs.push({
        context: "drawer",
        observeRoot: drawer,
        panelSelectors: PANEL_SELECTORS,
        headerSelectors: HEADER_SELECTORS,
        itemsSelectors: ITEMS_SELECTORS,
        footerSelectors: FOOTER_SELECTORS,
        chooserInsideItems: true,
        // scroll past the items to reach the chooser
        strict: false
        // keep the drawer's lenient fallbacks (unchanged behavior)
      });
    }
    const pageItems = findFirst(document, PAGE_ITEMS_SELECTORS);
    const pageSection = (_a2 = pageItems == null ? void 0 : pageItems.closest(".shopify-section")) != null ? _a2 : null;
    if (pageSection instanceof HTMLElement) {
      specs.push({
        context: "page",
        observeRoot: pageSection,
        panelSelectors: [],
        headerSelectors: PAGE_HEADER_SELECTORS,
        itemsSelectors: PAGE_ITEMS_SELECTORS,
        footerSelectors: PAGE_FOOTER_SELECTORS,
        chooserInsideItems: false,
        // a normal page: chooser AFTER the items, before the footer section
        strict: true
        // never inject in the wrong place on an unknown theme
      });
    }
    return specs.map(mountOne);
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
    renderGiftSection(root2, model, currentTierId, handlers);
    if (model.declineEnabled) {
      root2.append(renderDecline(model.declined, handlers));
    }
    mount.append(root2);
  }
  function renderGiftSection(root2, model, currentTierId, handlers) {
    if (model.declined) {
      root2.append(
        hint("Your free gift is removed. Re-check \u201CAdd my free gift\u201D below to add it back.")
      );
      return;
    }
    const current = currentTierId === null ? null : model.tiers.find((t) => t.tierId === currentTierId);
    if (current === void 0 || current === null) {
      root2.append(hint("Add a little more to your cart to unlock your free gift."));
      return;
    }
    const title = document.createElement("p");
    title.className = "fge-gift__title";
    title.textContent = current.kind === "or" ? "Choose your free gift" : "Your free gift";
    root2.append(title);
    if (current.kind === "or") {
      for (const group of current.groups) {
        root2.append(renderProductGroup(current.tierId, group, current.selected, handlers));
      }
    } else {
      root2.append(renderBundle(current));
    }
  }
  function hint(text) {
    const p = document.createElement("p");
    p.className = "fge-gift__hint";
    p.textContent = text;
    return p;
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
  function renderProductGroup(tierId, group, selectedOptionId, handlers) {
    var _a2, _b2, _c2, _d, _e;
    const options = group.options;
    if (options.length <= 1) {
      const opt = options[0];
      return renderOptionCard(tierId, opt, opt.optionId === selectedOptionId, handlers);
    }
    const productLabel = (_d = (_c2 = (_a2 = options[0]) == null ? void 0 : _a2.productLabel) != null ? _c2 : (_b2 = options[0]) == null ? void 0 : _b2.variantLabel) != null ? _d : "";
    const selectedOpt = options.find((o) => o.optionId === selectedOptionId);
    const productSelected = selectedOpt !== void 0;
    const anyAvailable = options.some((o) => o.available);
    const defaultPick = (_e = selectedOpt != null ? selectedOpt : options.find((o) => o.available)) != null ? _e : options[0];
    const card = document.createElement("label");
    card.className = "fge-card";
    if (productSelected) card.classList.add("is-selected");
    if (!anyAvailable) card.classList.add("is-unavailable");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.className = "fge-card__radio";
    radio.name = `fge-tier-${tierId}`;
    radio.value = defaultPick.optionId;
    radio.checked = productSelected;
    radio.disabled = !anyAvailable;
    radio.addEventListener("change", () => handlers.onChoose(tierId, defaultPick.optionId));
    const body = document.createElement("div");
    body.className = "fge-card__body";
    const name = document.createElement("div");
    name.className = "fge-card__name";
    name.textContent = productLabel;
    body.append(name);
    if (!anyAvailable) {
      const status = document.createElement("div");
      status.className = "fge-card__status is-unavailable";
      status.textContent = "Currently unavailable";
      body.append(status);
    } else if (productSelected) {
      body.append(renderVariantChips(tierId, options, selectedOptionId, productLabel, handlers));
    } else {
      const status = document.createElement("div");
      status.className = "fge-card__status";
      status.textContent = `Choose this gift \xB7 ${options.length} options`;
      body.append(status);
    }
    card.append(radio, giftImage((selectedOpt != null ? selectedOpt : defaultPick).imageUrl, productLabel), body);
    return card;
  }
  function renderVariantChips(tierId, options, selectedOptionId, productLabel, handlers) {
    const picker = document.createElement("div");
    picker.className = "fge-variants";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", `Choose a ${productLabel} option`);
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fge-variant";
      btn.textContent = opt.variantLabel;
      const isSel = opt.optionId === selectedOptionId;
      if (isSel) btn.classList.add("is-selected");
      btn.setAttribute("aria-pressed", String(isSel));
      if (!opt.available) {
        btn.disabled = true;
        btn.classList.add("is-unavailable");
      } else {
        btn.addEventListener("click", () => handlers.onChoose(tierId, opt.optionId));
      }
      picker.append(btn);
    }
    return picker;
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
      allUnlocked: next === null && tiers.length > 0,
      pending: lastResult2 === null
      // no server result yet → neutral headline (see ProgressModel)
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
    const ordered = [...model.tiers].sort(
      (a, b) => a.threshold.amountMinor - b.threshold.amountMinor
    );
    const n = ordered.length;
    const posAt = (i) => (i + 1) / (n + 1) * 100;
    const nodes = ordered.map((t, i) => {
      const posPct = posAt(i);
      const align = posPct <= 8 ? "start" : posPct >= 92 ? "end" : "center";
      return { tierId: t.tierId, posPct, align, reached: t.reached, isCurrent: t.isCurrent };
    });
    return { fillPct: fillToNodes(model.subtotal, ordered, posAt), nodes };
  }
  function fillToNodes(subtotal, ordered, posAt) {
    if (subtotal === null || ordered.length === 0) {
      return 0;
    }
    const s = subtotal.amountMinor;
    const t0 = ordered[0].threshold.amountMinor;
    if (s <= t0) {
      return t0 <= 0 ? posAt(0) : Math.max(0, s / t0 * posAt(0));
    }
    for (let i = 0; i < ordered.length - 1; i++) {
      const lo = ordered[i].threshold.amountMinor;
      const hi = ordered[i + 1].threshold.amountMinor;
      if (s < hi) {
        const frac = hi === lo ? 0 : (s - lo) / (hi - lo);
        return posAt(i) + (posAt(i + 1) - posAt(i)) * frac;
      }
    }
    return posAt(ordered.length - 1);
  }
  function ensureSkeleton(mount, nodes) {
    var _a2;
    const key = nodes.map((n) => n.tierId).join("|");
    const existing = mount.querySelector(".fge-stepper");
    if (existing !== null && mount.dataset["fgeTiers"] === key) {
      const steps2 = /* @__PURE__ */ new Map();
      for (const el of existing.querySelectorAll(".fge-step")) {
        steps2.set((_a2 = el.dataset["tier"]) != null ? _a2 : "", {
          el,
          label: el.querySelector(".fge-step__label")
        });
      }
      return {
        headline: mount.querySelector(".fge-headline"),
        fill: existing.querySelector(".fge-stepper__fill"),
        steps: steps2
      };
    }
    mount.textContent = "";
    const headline = document.createElement("p");
    headline.className = "fge-headline";
    const stepper = document.createElement("div");
    stepper.className = "fge-stepper";
    const track = document.createElement("div");
    track.className = "fge-stepper__track";
    const fill = document.createElement("div");
    fill.className = "fge-stepper__fill";
    stepper.append(track, fill);
    const steps = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const step = document.createElement("div");
      step.className = "fge-step";
      step.dataset["tier"] = node.tierId;
      step.style.left = `${node.posPct}%`;
      const dot = document.createElement("div");
      dot.className = "fge-step__dot";
      const label = document.createElement("div");
      label.className = "fge-step__label";
      step.append(dot, label);
      stepper.append(step);
      steps.set(node.tierId, { el: step, label });
    }
    const subnote = document.createElement("p");
    subnote.className = "fge-subnote";
    subnote.textContent = "You receive the gift for your highest unlocked tier \u2014 not one per step.";
    mount.append(headline, stepper, subnote);
    mount.dataset["fgeTiers"] = key;
    return { headline, fill, steps };
  }
  function setHeadline(headline, model) {
    var _a2;
    headline.textContent = "";
    if (model.pending) {
      headline.textContent = "Loading your free gift\u2026";
      return;
    }
    if (model.allUnlocked) {
      headline.textContent = "You\u2019ve unlocked your free gift";
      return;
    }
    if (model.next === null) {
      return;
    }
    const amt = document.createElement("span");
    amt.className = "fge-amt";
    amt.textContent = fmt((_a2 = model.next.spendMore) != null ? _a2 : model.next.threshold);
    const spend = model.next.spendMore !== null;
    headline.append(
      document.createTextNode(spend ? "Spend " : "Reach "),
      amt,
      document.createTextNode(
        spend ? ` more to unlock ${model.next.giftLabel}` : ` to unlock ${model.next.giftLabel}`
      )
    );
  }
  function renderProgress(mount, model) {
    if (model === null) {
      mount.textContent = "";
      delete mount.dataset["fgeTiers"];
      return;
    }
    const { fillPct, nodes } = stepperLayout(model);
    const byTier = new Map(model.tiers.map((t) => [t.tierId, t]));
    const ui = ensureSkeleton(mount, nodes);
    setHeadline(ui.headline, model);
    ui.fill.style.width = `${fillPct}%`;
    for (const node of nodes) {
      const step = ui.steps.get(node.tierId);
      if (step === void 0) {
        continue;
      }
      step.el.className = `fge-step fge-step--${node.align}` + (node.reached ? " is-reached" : "") + (node.isCurrent ? " is-current" : "");
      step.el.style.left = `${node.posPct}%`;
      step.label.textContent = fmt(byTier.get(node.tierId).threshold, true);
    }
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

/* --- top: a compact BANNER CARD (subtle outline + light fill, no heavy shadow). The headline is
   only "Spend CA$X more to unlock <gift>" (or "You've unlocked\u2026"); the theme's own "Your cart" drawer
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
   fill, each tier dot, and the no-image card placeholder are intentionally EMPTY visual divs \u2014 without
   this they vanish and only the text labels survive. !important beats the theme's :empty rule. */
.fge-stepper__track,
.fge-stepper__fill,
.fge-step__dot,
.fge-card__img{ display:block !important; }

/* THEME-OVERRIDE: Dawn renders TWO "Your cart" titles inside the drawer \u2014 the H2.drawer__heading
   (header) and the H1.title--primary (cart section title, normally suppressed). Our injected layout
   surfaces both, so we hide the section-title duplicate \u2014 SCOPED to drawer containers only, so the
   cart PAGE's own H1.title--primary is untouched. No-op on themes where it isn't present. */
cart-drawer .title--primary,
#CartDrawer .title--primary,
.drawer__inner .title--primary{ display:none !important; }

/* --- gift panel: lives INSIDE the drawer's scrollable items region, after the line items, so it
   scrolls with the cart (no inner max-height/scroll \u2014 that would nest a scrollbar and pin it). --- */
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

.fge-decline{
  display:flex; align-items:center; gap:8px; margin:12px 0 0; padding-top:11px;
  border-top:1px solid var(--fge-line); font-size:13px; color:var(--fge-ink); cursor:pointer;
}
.fge-decline input{ accent-color:var(--fge-brand); width:16px; height:16px; }

@media (prefers-reduced-motion: reduce){
  .fge-stepper__fill, .fge-step, .fge-step__dot{ transition:none; }
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
  var sections = [];
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
            renderSteppers();
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
  function renderSteppers() {
    if (campaignConfig === null || sections.length === 0) {
      return;
    }
    const model = buildProgressModel(campaignConfig, lastResult);
    for (const section of sections) {
      renderProgress(section.stepperEl, model);
      section.attach();
    }
  }
  function renderPerception(config) {
    if (campaignConfig === null || sections.length === 0) {
      return;
    }
    const currentTierId = (lastResult == null ? void 0 : lastResult.status) === "gift" ? lastResult.tierId : null;
    const model = buildProgressModel(campaignConfig, lastResult);
    const handlers = {
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
    };
    for (const section of sections) {
      renderProgress(section.stepperEl, model);
      renderChooser(
        section.chooserEl,
        campaignConfig,
        { choices: choiceState, declined, unavailableVariantIds },
        handlers,
        currentTierId
      );
      section.attach();
    }
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
    sections = mountCartContexts({ drawerSelector: config.drawerSelector });
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
