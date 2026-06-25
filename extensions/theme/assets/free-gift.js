"use strict";
(() => {
  // ../../packages/core/src/reconcile.ts
  var GIFT_LINE_PROPERTY = "_fge_gift";
  function reconcileGiftLines(cart, result) {
    const desired = result.status === "gift" ? result.giftVariantIds : [];
    const appAddedGiftLines = cart.filter((line) => line.appAdded);
    const presentVariantIds = new Set(appAddedGiftLines.map((line) => line.variantId));
    const remove = appAddedGiftLines.filter((line) => !desired.includes(line.variantId)).map((line) => ({ id: line.id, variantId: line.variantId }));
    const add = desired.filter((variantId) => !presentVariantIds.has(variantId)).map((variantId) => ({
      variantId,
      quantity: 1,
      properties: { [GIFT_LINE_PROPERTY]: "1" }
    }));
    return {
      add,
      remove,
      applyCode: result.status === "gift" ? result.code : null,
      status: result.status,
      reason: result.status === "no-gift" ? result.reason : null
    };
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
  var toNumericId = (gid) => Number(gid.split("/").pop());
  var isGiftLine = (item) => item.properties != null && item.properties[GIFT_LINE_PROPERTY] != null;
  function readConfig() {
    var _a2, _b2;
    const el = document.querySelector("[data-fge-app-block]");
    if (el === null) {
      return null;
    }
    let choices = {};
    const raw = el.dataset["defaultChoices"];
    if (raw !== void 0 && raw.trim().length > 0) {
      try {
        choices = JSON.parse(raw);
      } catch {
        choices = {};
      }
    }
    return {
      proxyPath: (_a2 = el.dataset["proxyPath"]) != null ? _a2 : "/apps/free-gift/validate",
      country: (_b2 = el.dataset["country"]) != null ? _b2 : "",
      choices
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
  async function postJson(path, body) {
    await fetch(`${root}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    });
  }
  async function reconcileOnce(config) {
    var _a2, _b2;
    const cart = await getCart();
    const request = {
      cart: cart.items.map((item) => ({
        variantId: toGid(item.variant_id),
        quantity: item.quantity,
        appAdded: isGiftLine(item)
      })),
      choices: config.choices,
      declined: false,
      // decline UI is 5b-2
      presentmentCurrency: cart.currency,
      countryCode: config.country
    };
    const response = await postValidate(request, { proxyPath: config.proxyPath });
    if (!response.ok) {
      return;
    }
    const lines = cart.items.map((item) => ({
      id: item.key,
      variantId: toGid(item.variant_id),
      quantity: item.quantity,
      appAdded: isGiftLine(item)
    }));
    const plan = reconcileGiftLines(lines, response.result);
    const hasCartMutations = plan.add.length > 0 || plan.remove.length > 0;
    const discountChanged = plan.applyCode !== lastDiscount;
    if (!hasCartMutations && !discountChanged) {
      return;
    }
    selfMutating = true;
    try {
      for (const removal of plan.remove) {
        await postJson("cart/change.js", { id: removal.id, quantity: 0 });
      }
      for (const addition of plan.add) {
        await postJson("cart/add.js", {
          items: [
            {
              id: toNumericId(addition.variantId),
              quantity: addition.quantity,
              properties: addition.properties
            }
          ]
        });
      }
      if (discountChanged) {
        await postJson("cart/update.js", { discount: (_a2 = plan.applyCode) != null ? _a2 : "" });
        lastDiscount = plan.applyCode;
      }
    } finally {
      selfMutating = false;
    }
    (_b2 = w.publish) == null ? void 0 : _b2.call(w, CART_UPDATE_EVENT, { source: SOURCE });
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
    schedule(config);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
