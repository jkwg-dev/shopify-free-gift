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
  var OVERLAY_Z = 2147482e3;
  var DRAWER_SELECTORS = [
    "cart-drawer",
    "#CartDrawer",
    ".cart-drawer",
    '[class*="cart-drawer" i]',
    ".drawer--cart",
    "cart-notification"
  ];
  var PANEL_SELECTORS = [".drawer__inner", ".cart-drawer__inner", '[role="dialog"]'];
  var OPEN_CLASSES = ["active", "is-open", "open", "drawer--active"];
  function findDrawer(selectorOverride) {
    const selectors = selectorOverride ? [selectorOverride, ...DRAWER_SELECTORS] : DRAWER_SELECTORS;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el !== null) {
        return el;
      }
    }
    return null;
  }
  function isOpen(drawer2, openClassOverride) {
    if (openClassOverride) {
      return drawer2.classList.contains(openClassOverride);
    }
    if (OPEN_CLASSES.some((c) => drawer2.classList.contains(c))) {
      return true;
    }
    if (drawer2.getAttribute("aria-hidden") === "false") {
      return true;
    }
    return drawer2.offsetParent !== null && drawer2.getBoundingClientRect().width > 0;
  }
  function mountDrawerOverlay(opts = {}) {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-fge-overlay", "");
    overlay.style.cssText = `position:fixed;z-index:${OVERLAY_Z};display:none;box-sizing:border-box;`;
    const container = document.createElement("div");
    container.setAttribute("data-fge-chooser", "");
    overlay.append(container);
    document.body.append(overlay);
    const drawer2 = findDrawer(opts.drawerSelector);
    const position = () => {
      var _a2;
      if (drawer2 === null) {
        overlay.style.cssText = `position:fixed;z-index:${OVERLAY_Z};left:0;right:0;bottom:0;display:block;box-sizing:border-box;max-height:50vh;overflow:auto;`;
        return;
      }
      const panel = (_a2 = PANEL_SELECTORS.map((s) => drawer2.querySelector(s)).find(
        (el) => el !== null
      )) != null ? _a2 : drawer2;
      const r = panel.getBoundingClientRect();
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.maxHeight = `${Math.max(120, r.height)}px`;
      overlay.style.overflow = "auto";
    };
    const refresh = () => {
      if (drawer2 === null) {
        position();
        return;
      }
      if (isOpen(drawer2, opts.openClass)) {
        overlay.style.display = "block";
        position();
      } else {
        overlay.style.display = "none";
      }
    };
    if (drawer2 !== null) {
      new MutationObserver(refresh).observe(drawer2, {
        attributes: true,
        attributeFilter: ["class", "style", "aria-hidden"]
      });
    }
    window.addEventListener("resize", refresh, { passive: true });
    window.addEventListener("scroll", refresh, { passive: true });
    refresh();
    return { container, refresh };
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
  function renderChooser(mount, config, state, handlers) {
    mount.textContent = "";
    const model = buildChooserModel(config, state);
    if (model === null) {
      return;
    }
    const root2 = document.createElement("div");
    root2.className = "fge-chooser";
    if (model.declineEnabled) {
      root2.append(renderDecline(model.declined, handlers));
    }
    for (const tier of model.tiers) {
      root2.append(tier.kind === "or" ? renderOrTier(tier, handlers) : renderAndTier(tier));
    }
    mount.append(root2);
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
  function tierFieldset(tier, legendText) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "fge-tier";
    fieldset.dataset["tierId"] = tier.tierId;
    const legend = document.createElement("legend");
    legend.textContent = legendText;
    fieldset.append(legend);
    const threshold = document.createElement("div");
    threshold.className = "fge-threshold";
    threshold.textContent = `Spend ${formatMoney(tier.threshold)}`;
    fieldset.append(threshold);
    return fieldset;
  }
  function renderOrTier(tier, handlers) {
    const fieldset = tierFieldset(tier, "Choose your free gift");
    for (const group of tier.groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "fge-group";
      for (const opt of group.options) {
        const label = document.createElement("label");
        label.className = "fge-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `fge-tier-${tier.tierId}`;
        radio.value = opt.optionId;
        radio.checked = opt.optionId === tier.selected;
        radio.disabled = !opt.available;
        radio.addEventListener("change", () => handlers.onChoose(tier.tierId, opt.optionId));
        if (!opt.available) {
          label.classList.add("is-unavailable");
        }
        const text = opt.available ? opt.variantLabel : `${opt.variantLabel} \u2014 currently unavailable`;
        label.append(radio, document.createTextNode(` ${text}`));
        groupEl.append(label);
      }
      fieldset.append(groupEl);
    }
    return fieldset;
  }
  function renderAndTier(tier) {
    const fieldset = tierFieldset(tier, "Your free gift");
    const list = document.createElement("div");
    list.className = "fge-bundle";
    const intro = document.createElement("span");
    intro.className = "fge-bundle-intro";
    intro.textContent = tier.items.length > 1 ? "Get all: " : "Get: ";
    list.append(intro);
    tier.items.forEach((item, i) => {
      if (i > 0) {
        list.append(document.createTextNode(" + "));
      }
      const span = document.createElement("span");
      span.className = "fge-bundle-item";
      if (!item.available) span.classList.add("is-unavailable");
      span.textContent = item.available ? item.variantLabel : `${item.variantLabel} (unavailable)`;
      list.append(span);
    });
    fieldset.append(list);
    if (tier.incomplete) {
      const note = document.createElement("p");
      note.className = "fge-note fge-note--unavailable";
      note.textContent = "This gift can\u2019t be fully added right now \u2014 please check back.";
      fieldset.append(note);
    }
    return fieldset;
  }
  function formatMoney(m) {
    var _a2;
    try {
      const fmt2 = new Intl.NumberFormat(void 0, { style: "currency", currency: m.currency });
      const digits = (_a2 = fmt2.resolvedOptions().maximumFractionDigits) != null ? _a2 : 2;
      return fmt2.format(m.amountMinor / 10 ** digits);
    } catch {
      return `${m.amountMinor} ${m.currency}`;
    }
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
  function fmt(m) {
    var _a2;
    try {
      const f = new Intl.NumberFormat(void 0, { style: "currency", currency: m.currency });
      const digits = (_a2 = f.resolvedOptions().maximumFractionDigits) != null ? _a2 : 2;
      return f.format(m.amountMinor / 10 ** digits);
    } catch {
      return `${m.amountMinor} ${m.currency}`;
    }
  }
  function renderProgress(mount, model) {
    mount.textContent = "";
    if (model === null) {
      return;
    }
    const root2 = document.createElement("div");
    root2.className = "fge-progress";
    const headline = document.createElement("p");
    headline.className = "fge-progress__headline";
    if (model.allUnlocked) {
      headline.textContent = "You\u2019ve unlocked your free gift";
    } else if (model.next !== null) {
      headline.textContent = model.next.spendMore !== null ? `Spend ${fmt(model.next.spendMore)} more to unlock ${model.next.giftLabel}` : `Spend ${fmt(model.next.threshold)} to unlock ${model.next.giftLabel}`;
    }
    root2.append(headline);
    const ladder = document.createElement("ol");
    ladder.className = "fge-progress__ladder";
    for (const tier of model.tiers) {
      const li = document.createElement("li");
      li.className = "fge-progress__tier";
      li.dataset["tierId"] = tier.tierId;
      if (tier.reached) li.classList.add("is-reached");
      if (tier.isCurrent) li.classList.add("is-current");
      const state = tier.isCurrent ? "\u2713 unlocked" : tier.reached ? "\u2713" : "\u{1F512}";
      li.textContent = `${state} ${fmt(tier.threshold)} \u2014 ${tier.giftLabel}`;
      ladder.append(li);
    }
    root2.append(ladder);
    mount.append(root2);
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
      drawerSelector: el.dataset["drawerSelector"],
      drawerOpenClass: el.dataset["drawerOpenClass"]
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
      }
    );
    drawer == null ? void 0 : drawer.refresh();
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
    drawer = mountDrawerOverlay({
      drawerSelector: config.drawerSelector,
      openClass: config.drawerOpenClass
    });
    graphEl = document.createElement("div");
    chooserEl = document.createElement("div");
    drawer.container.append(graphEl, chooserEl);
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
