"use strict";
(() => {
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
    if (config.status !== "active") {
      return null;
    }
    const tiers = config.tiers.map((tier) => {
      if (tier.gift.kind === "AND") {
        return {
          kind: "and",
          tierId: tier.tierId,
          threshold: tier.threshold,
          items: tier.gift.gifts
        };
      }
      return {
        kind: "or",
        tierId: tier.tierId,
        threshold: tier.threshold,
        groups: groupGiftOptionsByProduct(tier.gift.options),
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
        const text = opt.available ? opt.variantLabel : `${opt.variantLabel} (out of stock)`;
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
      span.textContent = item.available ? item.variantLabel : `${item.variantLabel} (out of stock)`;
      list.append(span);
    });
    fieldset.append(list);
    return fieldset;
  }
  function formatMoney(m) {
    var _a2;
    try {
      const fmt = new Intl.NumberFormat(void 0, { style: "currency", currency: m.currency });
      const digits = (_a2 = fmt.resolvedOptions().maximumFractionDigits) != null ? _a2 : 2;
      return fmt.format(m.amountMinor / 10 ** digits);
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
  function logFailure(message, body) {
    var _a2;
    const c = globalThis.console;
    (_a2 = c == null ? void 0 : c.warn) == null ? void 0 : _a2.call(c, `[free-gift] ${message}`, body.slice(0, 300));
  }

  // src/reconcileLoop.ts
  async function reconcileGiftCart(io, opts = {}) {
    var _a2, _b2, _c2;
    const maxPasses = (_a2 = opts.maxPasses) != null ? _a2 : 4;
    let appliedCode = (_b2 = opts.initialCode) != null ? _b2 : null;
    const blockedAdds = /* @__PURE__ */ new Set();
    const failures = [];
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const { lines, currency } = await io.readCart();
      const result = await io.validate(lines, currency);
      if (result === null) {
        return { passes: pass, converged: false, appliedCode, failures };
      }
      const plan = reconcileGiftLines(lines, result);
      const add = plan.add.filter((a) => !blockedAdds.has(a.variantId));
      const cartNeedsChange = add.length > 0 || plan.remove.length > 0 || plan.adjust.length > 0;
      const codeNeedsChange = plan.applyCode !== appliedCode;
      if (!cartNeedsChange && !codeNeedsChange) {
        return { passes: pass, converged: true, appliedCode, failures };
      }
      if (cartNeedsChange) {
        const res = await applyCartPlan({ ...plan, add }, io.post);
        for (const f of res.failures) {
          failures.push(f);
          if (f.kind === "add") {
            blockedAdds.add(f.variantId);
          }
        }
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
      presentmentCurrency: (_c2 = el.dataset["presentmentCurrency"]) != null ? _c2 : ""
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
            return response.ok ? response.result : null;
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
    } finally {
      selfMutating = false;
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
  async function initChooser(config) {
    const result = await getConfig({
      presentmentCurrency: config.presentmentCurrency,
      countryCode: config.country
    });
    if (!result.ok || result.config.status !== "active") {
      return;
    }
    const campaignConfig = result.config;
    choiceState = defaultGiftChoices(campaignConfig.tiers);
    const mount = document.querySelector("[data-fge-chooser]");
    if (mount === null) {
      return;
    }
    renderChooser(
      mount,
      campaignConfig,
      { choices: choiceState, declined },
      {
        onChoose: (tierId, optionId) => {
          choiceState = { ...choiceState, [tierId]: optionId };
          schedule(config);
        },
        onDeclineToggle: (next) => {
          declined = next;
          schedule(config);
        }
      }
    );
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
    void initChooser(config).finally(() => schedule(config));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
