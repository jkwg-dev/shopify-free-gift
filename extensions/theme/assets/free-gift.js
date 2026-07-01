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
    var _a2;
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
      if (((_a2 = line.finalLinePrice) != null ? _a2 : 0) > 0) {
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
    '.cart-drawer:not(button):not([class*="__trigger"])',
    ".drawer--cart",
    "cart-notification"
  ];
  var PANEL_SELECTORS = [".drawer__inner", ".cart-drawer__inner", '[role="dialog"]'];
  var HEADER_SELECTORS = [
    ".drawer__header",
    ".cart-drawer__header",
    ".cart-drawer__head",
    '[class*="drawer__header" i]'
  ];
  var ITEMS_SELECTORS = [
    "#CartDrawer-CartItems",
    ".drawer__contents",
    ".js-contents",
    ".cart-items",
    '[class*="cart-items" i]'
  ];
  var FOOTER_SELECTORS = [
    ".drawer__footer",
    ".cart-drawer__footer",
    ".cart-drawer__bottom",
    '[class*="drawer__footer" i]'
  ];
  var PAGE_HEADER_SELECTORS = [
    ".cart__main-header",
    ".cart__title",
    "h1.title--primary",
    ".title--primary"
  ];
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
      var _a2;
      observer == null ? void 0 : observer.disconnect();
      try {
        doAttach(spec, stepperEl, chooserEl);
        if (spec.onReattach !== void 0) {
          const panel = spec.panelSelectors.length > 0 ? (_a2 = findFirst(spec.observeRoot, spec.panelSelectors)) != null ? _a2 : spec.observeRoot : spec.observeRoot;
          spec.onReattach(spec.context, findFirst(panel, spec.itemsSelectors));
        }
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
    var _a2, _b2;
    const specs = [];
    const drawer = findDrawer(opts.drawerSelector);
    if (drawer !== null) {
      const sectionRoot = (_a2 = drawer.closest(".shopify-section")) != null ? _a2 : drawer;
      specs.push({
        context: "drawer",
        observeRoot: sectionRoot,
        panelSelectors: PANEL_SELECTORS,
        headerSelectors: HEADER_SELECTORS,
        itemsSelectors: ITEMS_SELECTORS,
        footerSelectors: FOOTER_SELECTORS,
        chooserInsideItems: true,
        // scroll past the items to reach the chooser
        strict: false,
        // keep the drawer's lenient fallbacks (unchanged behavior)
        onReattach: opts.onReattach
      });
    }
    const pageItems = findFirst(document, PAGE_ITEMS_SELECTORS);
    const pageSection = (_b2 = pageItems == null ? void 0 : pageItems.closest(".shopify-section")) != null ? _b2 : null;
    if (pageSection instanceof HTMLElement) {
      specs.push({
        context: "page",
        observeRoot: pageSection,
        panelSelectors: [],
        headerSelectors: PAGE_HEADER_SELECTORS,
        itemsSelectors: PAGE_ITEMS_SELECTORS,
        footerSelectors: PAGE_FOOTER_SELECTORS,
        chooserInsideItems: true,
        // append inside #main-cart-items so the chooser stays in the main column (below line items), not in the sidebar summary
        strict: true,
        // never inject in the wrong place on an unknown theme
        onReattach: opts.onReattach
      });
    }
    return specs.map(mountOne);
  }

  // src/cartGrouping.ts
  function isZeroedByOurCode(line, ourCode) {
    return line.finalLinePrice === 0 && ourCode !== null && line.allocationTitles.includes(ourCode);
  }
  function classifyAndGroup(lines, ourCode) {
    const zeroedVariantIds = /* @__PURE__ */ new Set();
    for (const line of lines) {
      if (isZeroedByOurCode(line, ourCode)) {
        zeroedVariantIds.add(line.variantId);
      }
    }
    const gets = [];
    const lingering = [];
    for (const line of lines) {
      if (isZeroedByOurCode(line, ourCode)) {
        gets.push({ index: line.index, key: line.key, variantId: line.variantId });
      } else if (line.marked && !zeroedVariantIds.has(line.variantId)) {
        lingering.push({ index: line.index, key: line.key, variantId: line.variantId });
      }
    }
    return {
      gets,
      lingering,
      hasGifts: gets.length > 0 || lingering.length > 0,
      lineCount: lines.length
    };
  }

  // src/groupingTransform.ts
  var LINE_SELECTORS = [
    ".cart-item",
    '[id^="CartDrawer-Item-"]',
    '[id^="CartItem-"]',
    "cart-item",
    ".cart__row"
  ];
  var QTY_INPUT_SELECTORS = [
    ".quantity__input",
    'input[name="updates[]"]',
    'input[name*="quantity" i]',
    'input[type="number"]'
  ];
  var LINE_TOTAL_SELECTORS = [".cart-item__actions--price", ".cart-item__total-price"];
  var DEC_BTN_SELECTOR = '.quantity__button[name="decrement"], .quantity__button[name="minus"]';
  var INC_BTN_SELECTOR = '.quantity__button[name="increment"], .quantity__button[name="plus"]';
  var MARK = "data-fge-grouped";
  var HIDDEN_MARK = "data-fge-gift-hidden";
  var MERGE_PRIMARY_ATTR = "data-fge-merge-primary";
  var MERGE_KEYS_ATTR = "data-fge-merge-keys";
  var MERGE_HIDDEN_MARK = "data-fge-merge-hidden";
  var DISCOUNT_LIST_SELECTOR = ".cart-item__discounts";
  var DISCOUNT_HIDDEN_MARK = "data-fge-discount-hidden";
  function findFirst2(root2, selectors) {
    for (const sel of selectors) {
      const el = root2.querySelector(sel);
      if (el !== null) return el;
    }
    return null;
  }
  function findLineNodes(itemsEl) {
    for (const sel of LINE_SELECTORS) {
      const found = Array.from(itemsEl.querySelectorAll(sel));
      if (found.length > 0) return found;
    }
    return [];
  }
  function resetGiftHides(lineNodes) {
    for (const node of lineNodes) {
      if (node.hasAttribute(HIDDEN_MARK)) {
        node.style.display = "";
        node.removeAttribute(HIDDEN_MARK);
      }
    }
  }
  function applyGiftLineHiding(itemsEl, plan) {
    var _a2;
    if (itemsEl === null) return false;
    if (plan.lineCount === 0) return false;
    const lineNodes = findLineNodes(itemsEl);
    if (lineNodes.length !== plan.lineCount) return false;
    resetGiftHides(lineNodes);
    ((_a2 = itemsEl.closest("cart-drawer-items, cart-items")) != null ? _a2 : itemsEl).setAttribute(MARK, "");
    for (const ref of [...plan.gets, ...plan.lingering]) {
      const node = lineNodes[ref.index];
      if (node != null) {
        node.style.display = "none";
        node.setAttribute(HIDDEN_MARK, "");
      }
    }
    return true;
  }
  function applyDiscountBadgeHiding(itemsEl, hideIndices, totalLines) {
    if (itemsEl === null) return false;
    const lineNodes = findLineNodes(itemsEl);
    if (lineNodes.length !== totalLines) return false;
    for (const node of lineNodes) {
      node.querySelectorAll(`[${DISCOUNT_HIDDEN_MARK}]`).forEach((el) => {
        el.style.display = "";
        el.removeAttribute(DISCOUNT_HIDDEN_MARK);
      });
    }
    const hide = new Set(hideIndices);
    for (let i = 0; i < lineNodes.length; i++) {
      if (!hide.has(i)) continue;
      lineNodes[i].querySelectorAll(DISCOUNT_LIST_SELECTOR).forEach((el) => {
        el.style.display = "none";
        el.setAttribute(DISCOUNT_HIDDEN_MARK, "");
      });
    }
    return true;
  }
  function setPrimaryQuantity(node, total) {
    const input = findFirst2(node, QTY_INPUT_SELECTORS);
    if (!(input instanceof HTMLInputElement)) return;
    const value = String(total);
    if (input.value !== value) {
      input.value = value;
      input.setAttribute("value", value);
    }
    const min = input.min !== "" ? Number.parseInt(input.min, 10) : null;
    const max = input.max !== "" ? Number.parseInt(input.max, 10) : null;
    const dec = node.querySelector(DEC_BTN_SELECTOR);
    const inc = node.querySelector(INC_BTN_SELECTOR);
    if (dec !== null && min !== null) {
      const atMin = total <= min;
      dec.classList.toggle("disabled", atMin);
      dec.disabled = atMin;
    }
    if (inc !== null && max !== null) {
      const atMax = total >= max;
      inc.classList.toggle("disabled", atMax);
      inc.disabled = atMax;
    }
  }
  function setLineTotalPrice(node, formatted) {
    var _a2;
    for (const sel of LINE_TOTAL_SELECTORS) {
      const container = node.querySelector(sel);
      if (container === null) continue;
      const priceEl = (_a2 = container.querySelector(".cart-item__price")) != null ? _a2 : container;
      priceEl.textContent = formatted;
    }
  }
  function resetMergeMarks(lineNodes) {
    for (const node of lineNodes) {
      if (node.hasAttribute(MERGE_HIDDEN_MARK)) {
        node.style.display = "";
        node.removeAttribute(MERGE_HIDDEN_MARK);
      }
      node.removeAttribute(MERGE_PRIMARY_ATTR);
      node.removeAttribute(MERGE_KEYS_ATTR);
    }
  }
  function applyLineMerge(itemsEl, plan, totalLines, formatTotal) {
    if (itemsEl === null) return false;
    const lineNodes = findLineNodes(itemsEl);
    if (lineNodes.length !== totalLines) return false;
    resetMergeMarks(lineNodes);
    for (const group of plan.groups) {
      const primary = lineNodes[group.primaryIndex];
      if (primary == null) continue;
      primary.setAttribute(MERGE_PRIMARY_ATTR, "");
      primary.setAttribute(MERGE_KEYS_ATTR, JSON.stringify(group.keys));
      setPrimaryQuantity(primary, group.totalQuantity);
      setLineTotalPrice(primary, formatTotal(group.totalFinalPrice));
      for (const idx of group.hiddenIndices) {
        const node = lineNodes[idx];
        if (node != null) {
          node.style.display = "none";
          node.setAttribute(MERGE_HIDDEN_MARK, "");
        }
      }
    }
    return true;
  }
  function shouldSkipNativeQtySync(itemsEl, actualQuantities) {
    if (itemsEl === null) return false;
    const lineNodes = findLineNodes(itemsEl);
    if (lineNodes.length !== actualQuantities.length) return false;
    for (let i = 0; i < lineNodes.length; i++) {
      const node = lineNodes[i];
      if (isFgeManagedRow(node)) continue;
      const input = findFirst2(node, QTY_INPUT_SELECTORS);
      if (!(input instanceof HTMLInputElement)) continue;
      const domQty = Number.parseInt(input.value, 10);
      if (Number.isNaN(domQty)) continue;
      if (domQty > actualQuantities[i]) return true;
    }
    return false;
  }
  function isFgeManagedRow(node) {
    return node.hasAttribute(HIDDEN_MARK) || node.hasAttribute(MERGE_HIDDEN_MARK) || node.hasAttribute(MERGE_PRIMARY_ATTR);
  }
  function syncNativeInputs(itemsEl, actualQuantities) {
    if (itemsEl === null) return;
    const lineNodes = findLineNodes(itemsEl);
    if (lineNodes.length !== actualQuantities.length) return;
    for (let i = 0; i < lineNodes.length; i++) {
      const node = lineNodes[i];
      if (isFgeManagedRow(node)) continue;
      const input = findFirst2(node, QTY_INPUT_SELECTORS);
      if (input instanceof HTMLInputElement) {
        const actual = String(actualQuantities[i]);
        if (input.value !== actual) {
          input.value = actual;
          input.setAttribute("value", actual);
        }
      }
    }
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
    if (plan.remove.length > 0) {
      const updates = {};
      for (const r of plan.remove) updates[r.id] = 0;
      const res = await post("cart/update.js", { updates });
      if (res.ok) {
        removed.push(...plan.remove.map((r) => r.id));
      } else {
        const body = await res.text();
        logFailure(`cart/update.js atomic gift removal failed (${res.status})`, body);
        for (const r of plan.remove) {
          failures.push({ kind: "remove", variantId: r.variantId, status: res.status, body });
        }
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

  // src/debug.ts
  function fgeDebugEnabled() {
    try {
      if (typeof window !== "undefined" && window.FGE_DEBUG === true) {
        return true;
      }
      if (typeof localStorage !== "undefined" && localStorage.getItem("fge_debug") === "1") {
        return true;
      }
    } catch {
    }
    return false;
  }
  function fgeLog(...args) {
    if (fgeDebugEnabled()) {
      console.log("[FGE]", ...args);
    }
  }

  // src/discountAllocation.ts
  function lineHasRealDiscount(discounts) {
    return (discounts != null ? discounts : []).some((d) => {
      var _a2;
      return ((_a2 = d.amount) != null ? _a2 : 0) > 0;
    });
  }

  // src/lineMerge.ts
  function isMergeable(line) {
    return !line.isGift && line.finalLinePrice === line.originalLinePrice;
  }
  function planLineMerge(lines) {
    const buckets = /* @__PURE__ */ new Map();
    for (const line of lines) {
      if (!isMergeable(line)) continue;
      const bucketKey = `${line.variantId}\0${line.propertiesKey}`;
      const existing = buckets.get(bucketKey);
      if (existing) existing.push(line);
      else buckets.set(bucketKey, [line]);
    }
    const groups = [];
    for (const bucket of buckets.values()) {
      if (bucket.length <= 1) continue;
      const sorted = [...bucket].sort((a, b) => a.index - b.index);
      const primary = sorted[0];
      groups.push({
        primaryIndex: primary.index,
        hiddenIndices: sorted.slice(1).map((l) => l.index),
        totalQuantity: sorted.reduce((n, l) => n + l.quantity, 0),
        totalFinalPrice: sorted.reduce((n, l) => n + l.finalLinePrice, 0),
        keys: sorted.map((l) => l.key)
      });
    }
    groups.sort((a, b) => a.primaryIndex - b.primaryIndex);
    return { groups };
  }

  // src/money.ts
  var AMOUNT_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/;
  function themeMoneyFormat() {
    var _a2, _b2;
    const fmt2 = (_b2 = (_a2 = window.theme) == null ? void 0 : _a2.settings) == null ? void 0 : _b2.money_format;
    return fmt2 !== void 0 && fmt2 !== "" ? fmt2 : "${{amount}}";
  }
  function themeLocale() {
    var _a2;
    return (_a2 = window.Shopify) == null ? void 0 : _a2.locale;
  }
  function formatMoney(cents, format = themeMoneyFormat()) {
    const match = format.match(AMOUNT_PLACEHOLDER);
    const option = match !== null ? match[1] : "amount";
    const amount = cents / 100;
    const locale = themeLocale();
    let value;
    switch (option) {
      case "amount_no_decimals":
        value = String(Math.round(amount));
        break;
      case "amount_with_comma_separator":
        value = amount.toFixed(2).replace(".", ",");
        break;
      case "amount_no_decimals_with_comma_separator":
        value = new Intl.NumberFormat(locale).format(Math.round(amount)).replace(/\./g, ",");
        break;
      case "amount":
      default:
        value = new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(amount);
        break;
    }
    return format.replace(AMOUNT_PLACEHOLDER, value);
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
  function groupAndGiftsByProduct(gifts) {
    const order = [];
    const byProduct = /* @__PURE__ */ new Map();
    for (const gift of gifts) {
      const existing = byProduct.get(gift.productId);
      if (existing === void 0) {
        order.push(gift.productId);
        byProduct.set(gift.productId, [gift]);
      } else {
        existing.push(gift);
      }
    }
    return order.map((productId) => {
      var _a2, _b2, _c2;
      const variants = (_a2 = byProduct.get(productId)) != null ? _a2 : [];
      return { productId, productLabel: (_c2 = (_b2 = variants[0]) == null ? void 0 : _b2.productLabel) != null ? _c2 : "", variants };
    });
  }
  function choicesFromCart(tiers, cartGiftVariantIds) {
    const choices = {};
    for (const tier of tiers) {
      if (tier.gift.kind === "OR") {
        const picked = tier.gift.options.find((o) => cartGiftVariantIds.has(o.variantId));
        if (picked !== void 0) {
          choices[tier.tierId] = picked.optionId;
        }
      } else {
        for (const gift of tier.gift.gifts) {
          if (cartGiftVariantIds.has(gift.variantId)) {
            choices[`${tier.tierId}:${gift.productId}`] = gift.variantId;
          }
        }
      }
    }
    return choices;
  }
  function defaultGiftChoices(tiers) {
    var _a2;
    const choices = {};
    for (const tier of tiers) {
      if (tier.gift.kind === "OR") {
        const pick = (_a2 = tier.gift.options.find((o) => o.available)) != null ? _a2 : tier.gift.options[0];
        if (pick !== void 0) {
          choices[tier.tierId] = pick.optionId;
        }
      } else {
        const byProduct = /* @__PURE__ */ new Map();
        for (const gift of tier.gift.gifts) {
          if (byProduct.has(gift.productId)) continue;
          byProduct.set(gift.productId, gift);
        }
        for (const gift of tier.gift.gifts) {
          const current = byProduct.get(gift.productId);
          if (!current.available && gift.available) {
            byProduct.set(gift.productId, gift);
          }
        }
        for (const [productId, gift] of byProduct) {
          choices[`${tier.tierId}:${productId}`] = gift.variantId;
        }
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
        const groups = groupAndGiftsByProduct(items);
        const selections = {};
        for (const g of groups) {
          const key = `${tier.tierId}:${g.productId}`;
          const chosen = state.choices[key];
          if (chosen !== void 0) selections[g.productId] = chosen;
        }
        return {
          kind: "and",
          tierId: tier.tierId,
          threshold: tier.threshold,
          items,
          groups,
          selections,
          hasChoice: groups.some((g) => g.variants.length > 1),
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
  function renderChooser(mount, config, state, handlers, currentTierId, pending2 = false) {
    mount.textContent = "";
    const model = buildChooserModel(config, state);
    if (model === null) {
      return;
    }
    const root2 = document.createElement("div");
    root2.className = "fge-gift";
    if (pending2) {
      root2.classList.add("is-pending");
      root2.setAttribute("aria-busy", "true");
    }
    renderGiftSection(root2, model, currentTierId, handlers);
    if (pending2) {
      const heading = root2.querySelector(".fge-gift__title, .fge-gift__hint");
      heading == null ? void 0 : heading.append(spinner());
    }
    if (model.declineEnabled) {
      root2.append(renderDecline(model.declined, handlers));
    }
    mount.append(root2);
  }
  function spinner() {
    const s = document.createElement("span");
    s.className = "fge-spinner";
    s.setAttribute("aria-hidden", "true");
    return s;
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
    if (current.kind === "and") {
      if (!current.hasChoice) return;
      renderAndTierSection(root2, current, handlers);
      return;
    }
    const optionCount = current.groups.reduce((n, g) => n + g.options.length, 0);
    if (optionCount <= 1) return;
    const title = document.createElement("p");
    title.className = "fge-gift__title";
    title.textContent = "Choose your free gift";
    root2.append(title);
    const group = document.createElement("div");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Choose your free gift");
    for (const g of current.groups) {
      group.append(renderProductGroup(current.tierId, g, current.selected, handlers));
    }
    root2.append(group);
  }
  function hint(text) {
    const p = document.createElement("p");
    p.className = "fge-gift__hint";
    p.textContent = text;
    return p;
  }
  function giftImage(imageUrl) {
    if (imageUrl !== null && imageUrl !== void 0 && imageUrl.length > 0) {
      const img = document.createElement("img");
      img.className = "fge-card__img";
      img.src = imageUrl;
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      img.loading = "lazy";
      return img;
    }
    const ph = document.createElement("div");
    ph.className = "fge-card__img";
    ph.setAttribute("aria-hidden", "true");
    return ph;
  }
  function renderAndTierSection(root2, tier, handlers) {
    const title = document.createElement("p");
    title.className = "fge-gift__title";
    title.textContent = "Your free gifts";
    root2.append(title);
    const container = document.createElement("div");
    container.className = "fge-and-gifts";
    for (const group of tier.groups) {
      container.append(
        renderAndProductCard(tier.tierId, group, tier.selections[group.productId], handlers)
      );
    }
    root2.append(container);
  }
  function renderAndProductCard(tierId, group, selectedVariantId, handlers) {
    var _a2;
    const card = document.createElement("div");
    card.className = "fge-card is-selected";
    card.addEventListener("click", (e) => e.stopPropagation());
    const anyAvailable = group.variants.some((v) => v.available);
    if (!anyAvailable) card.classList.add("is-unavailable");
    const selected = (_a2 = group.variants.find((v) => v.variantId === selectedVariantId)) != null ? _a2 : group.variants[0];
    card.append(giftImage(selected == null ? void 0 : selected.imageUrl));
    const body = document.createElement("div");
    body.className = "fge-card__body";
    const name = document.createElement("div");
    name.className = "fge-card__name";
    name.textContent = group.productLabel;
    body.append(name);
    if (!anyAvailable) {
      const status = document.createElement("div");
      status.className = "fge-card__status is-unavailable";
      status.textContent = "Currently unavailable";
      body.append(status);
    } else if (group.variants.length > 1) {
      const compoundKey = `${tierId}:${group.productId}`;
      body.append(
        renderAndVariantChips(
          compoundKey,
          group.variants,
          selectedVariantId,
          group.productLabel,
          handlers
        )
      );
    }
    card.append(body);
    return card;
  }
  function renderAndVariantChips(compoundKey, variants, selectedVariantId, productLabel, handlers) {
    const picker = document.createElement("div");
    picker.className = "fge-variants";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", `Choose a ${productLabel} option`);
    for (const v of variants) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fge-variant";
      btn.textContent = v.variantLabel;
      const isSel = v.variantId === selectedVariantId;
      if (isSel) btn.classList.add("is-selected");
      btn.setAttribute("aria-pressed", String(isSel));
      if (!v.available) {
        btn.disabled = true;
        btn.classList.add("is-unavailable");
        btn.setAttribute("aria-label", `${v.variantLabel} (currently unavailable)`);
      } else {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          handlers.onChoose(compoundKey, v.variantId);
        });
      }
      picker.append(btn);
    }
    return picker;
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
    radio.setAttribute("aria-label", productLabel);
    card.addEventListener("click", (e) => e.stopPropagation());
    radio.addEventListener("change", (e) => {
      e.stopPropagation();
      handlers.onChoose(tierId, defaultPick.optionId);
    });
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
    card.append(radio, giftImage((selectedOpt != null ? selectedOpt : defaultPick).imageUrl), body);
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
        btn.setAttribute("aria-label", `${opt.variantLabel} (currently unavailable)`);
      } else {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          handlers.onChoose(tierId, opt.optionId);
        });
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
    card.addEventListener("click", (e) => e.stopPropagation());
    radio.addEventListener("change", (e) => {
      e.stopPropagation();
      handlers.onChoose(tierId, opt.optionId);
    });
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
    card.append(radio, giftImage(opt.imageUrl), body);
    return card;
  }
  function renderDecline(declined2, handlers) {
    const label = document.createElement("label");
    label.className = "fge-decline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !declined2;
    label.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      handlers.onDeclineToggle(!cb.checked);
    });
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
    if (request.presentmentRate !== void 0) {
      params.set("rate", request.presentmentRate);
    }
    const response = await fetchFn(`${path}?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      return { ok: false, httpStatus: response.status };
    }
    const body = await response.json();
    return { ok: true, config: body };
  }

  // src/pending.ts
  var PENDING_MIN_MS = 500;
  var PENDING_MAX_MS = 8e3;
  function pendingShouldClear(workDone, minElapsed) {
    return workDone && minElapsed;
  }
  var CHECKOUT_SELECTORS = [
    "#CartDrawer-Checkout",
    "#checkout",
    'button[name="checkout"]',
    '[name="checkout"]',
    ".cart__checkout-button"
  ];
  var CHECKOUT_LOCK_CLASS = "fge-checkout-pending";
  var LIVE_REGION_ID = "fge-live";
  function announcePending(message) {
    var _a2;
    const doc = globalThis.document;
    if (doc === void 0) {
      return;
    }
    let live = doc.getElementById(LIVE_REGION_ID);
    if (live === null) {
      live = doc.createElement("span");
      live.id = LIVE_REGION_ID;
      live.className = "fge-sr-only";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      (_a2 = doc.body) == null ? void 0 : _a2.append(live);
    }
    live.textContent = message;
  }
  function setCheckoutLocked(locked) {
    var _a2;
    const doc = globalThis.document;
    if (doc === void 0) {
      return;
    }
    (_a2 = doc.body) == null ? void 0 : _a2.classList.toggle(CHECKOUT_LOCK_CLASS, locked);
    for (const el of Array.from(doc.querySelectorAll(CHECKOUT_SELECTORS.join(", ")))) {
      if (locked) {
        el.setAttribute("aria-disabled", "true");
        el.disabled = true;
      } else {
        el.removeAttribute("aria-disabled");
        el.disabled = false;
      }
    }
  }

  // src/progressGraph.ts
  function productName(g) {
    return g.productLabel !== void 0 && g.productLabel !== "" ? g.productLabel : g.variantLabel;
  }
  function giftLabelFor(gift) {
    if (gift.kind === "AND") {
      const names = [...new Set(gift.gifts.map(productName))];
      return names.join(" + ");
    }
    if (gift.options.length <= 3) {
      const names = [...new Set(gift.options.map(productName))];
      return names.join(" / ");
    }
    return `Choose 1 of ${gift.options.length}`;
  }
  function buildProgressModel(config, lastResult2) {
    var _a2, _b2;
    if (config.status !== "active") {
      return null;
    }
    const subtotal = (lastResult2 == null ? void 0 : lastResult2.status) === "gift" ? lastResult2.subtotal : (lastResult2 == null ? void 0 : lastResult2.status) === "no-gift" ? (_a2 = lastResult2.subtotal) != null ? _a2 : null : null;
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
    const nextTier = (_b2 = ascending.find((t) => !t.reached)) != null ? _b2 : null;
    const anyReached = tiers.some((t) => t.reached);
    const next = nextTier === null ? null : {
      tierId: nextTier.tierId,
      threshold: nextTier.threshold,
      giftLabel: nextTier.giftLabel,
      spendMore: subtotal === null || !anyReached ? null : money(
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
  var STEPPER_HEADROOM = 4 / 3;
  var STEPPER_FALLBACK_MAX = 1;
  function stepperLayout(model) {
    var _a2;
    const ordered = [...model.tiers].sort(
      (a, b) => a.threshold.amountMinor - b.threshold.amountMinor
    );
    const highest = (_a2 = ordered[ordered.length - 1]) == null ? void 0 : _a2.threshold;
    const fillMax = highest !== void 0 && major(highest) > 0 ? major(highest) * STEPPER_HEADROOM : STEPPER_FALLBACK_MAX;
    const pct = (m) => Math.max(0, Math.min(100, major(m) / fillMax * 100));
    const fillPct = model.subtotal === null ? 0 : pct(model.subtotal);
    const nodes = ordered.map((t) => {
      const posPct = pct(t.threshold);
      const align = posPct <= 8 ? "start" : posPct >= 92 ? "end" : "center";
      return { tierId: t.tierId, posPct, align, reached: t.reached, isCurrent: t.isCurrent };
    });
    return { fillPct, nodes };
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
    stepper.setAttribute("aria-hidden", "true");
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
    const fullPriceNote = document.createElement("p");
    fullPriceNote.className = "fge-fullprice-note";
    fullPriceNote.textContent = "Only full-price & non-promotional items count toward your gift tier.";
    mount.append(headline, stepper, fullPriceNote, subnote);
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
  function reconcileSettled(expected, applied) {
    return applied.failed === 0 && applied.added === expected.adds && applied.removed === expected.removes && applied.adjusted === expected.adjusts;
  }
  async function reconcileGiftCart(io, opts = {}) {
    var _a2, _b2, _c2, _d;
    const maxPasses = (_a2 = opts.maxPasses) != null ? _a2 : 4;
    let appliedCode = (_b2 = opts.initialCode) != null ? _b2 : null;
    const addAttempted = /* @__PURE__ */ new Set();
    const failures = [];
    let wroteCart = false;
    let mutatedGiftLines = false;
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const { lines, currency } = await io.readCart();
      const result = await io.validate(lines, currency);
      if (result === null) {
        return { passes: pass, converged: false, appliedCode, failures, wroteCart, mutatedGiftLines };
      }
      const plan = reconcileGiftLines(lines, result);
      const hasRemoveAdjust = plan.remove.length > 0 || plan.adjust.length > 0;
      let codeNeedsChange = plan.applyCode !== appliedCode;
      fgeLog(`pass ${pass}`, {
        status: result.status,
        reason: "reason" in result ? result.reason : void 0,
        lines: lines.map((l) => ({
          v: l.variantId,
          qty: l.quantity,
          appAdded: l.appAdded,
          finalLinePrice: l.finalLinePrice,
          hasDiscountAllocation: l.hasDiscountAllocation
        })),
        plan: {
          add: plan.add.map((a) => a.variantId),
          remove: plan.remove.map((r) => r.variantId),
          adjust: plan.adjust.map((a) => a.variantId),
          applyCode: plan.applyCode
        },
        appliedCode,
        codeNeedsChange
      });
      const hasChargedGift = lines.some((l) => {
        var _a3;
        return l.appAdded && ((_a3 = l.finalLinePrice) != null ? _a3 : 0) > 0;
      });
      let add = plan.add.filter((a) => !addAttempted.has(a.variantId));
      if (!hasRemoveAdjust && add.length === 0 && !codeNeedsChange && !hasChargedGift) {
        return { passes: pass, converged: true, appliedCode, failures, wroteCart, mutatedGiftLines };
      }
      const removed = [];
      const adjusted = [];
      const added = [];
      const passFailures = [];
      if (hasRemoveAdjust) {
        wroteCart = true;
        mutatedGiftLines = true;
        const res = await applyCartPlan({ ...plan, add: [] }, io.post);
        removed.push(...res.removed);
        adjusted.push(...res.adjusted);
        passFailures.push(...res.failures);
        for (const r of plan.remove) {
          if (removed.includes(r.id)) {
            addAttempted.delete(r.variantId);
          }
        }
        add = plan.add.filter((a) => !addAttempted.has(a.variantId));
      }
      if (result.status === "gift" && add.length > 0) {
        codeNeedsChange = true;
      }
      if (codeNeedsChange) {
        wroteCart = true;
        const ok = await io.setDiscount(plan.applyCode);
        fgeLog(`pass ${pass}: setDiscount`, plan.applyCode, "ok?", ok);
        if (ok) {
          appliedCode = plan.applyCode;
        } else {
          (_c2 = io.nudge) == null ? void 0 : _c2.call(io);
          continue;
        }
      }
      if (add.length > 0) {
        wroteCart = true;
        mutatedGiftLines = true;
        for (const a of add) {
          addAttempted.add(a.variantId);
        }
        const res = await applyCartPlan({ ...plan, remove: [], adjust: [], add }, io.post);
        added.push(...res.added);
        passFailures.push(...res.failures);
        if (res.added.length > 0) {
          const verify = await io.readCart();
          for (const variantId of res.added) {
            const settledGift = verify.lines.some(
              (l) => {
                var _a3;
                return l.variantId === variantId && l.appAdded && ((_a3 = l.finalLinePrice) != null ? _a3 : 0) === 0;
              }
            );
            if (!settledGift) {
              addAttempted.delete(variantId);
            }
          }
        }
      }
      failures.push(...passFailures);
      (_d = io.nudge) == null ? void 0 : _d.call(io);
      const settled = reconcileSettled(
        { adds: add.length, removes: plan.remove.length, adjusts: plan.adjust.length },
        {
          added: added.length,
          removed: removed.length,
          adjusted: adjusted.length,
          failed: passFailures.length
        }
      );
      if (settled) {
        const postCart = await io.readCart();
        const charged = postCart.lines.filter((l) => {
          var _a3;
          return l.appAdded && ((_a3 = l.finalLinePrice) != null ? _a3 : 0) > 0;
        });
        if (charged.length > 0) {
          fgeLog(`pass ${pass}: charged-gift sweep (removing full-price gift lines)`, {
            charged: charged.map((l) => ({ v: l.variantId, finalLinePrice: l.finalLinePrice }))
          });
          const updates = {};
          for (const l of charged) updates[l.id] = 0;
          wroteCart = true;
          mutatedGiftLines = true;
          await io.post("cart/update.js", { updates });
          for (const l of charged) addAttempted.delete(l.variantId);
          continue;
        }
        return { passes: pass, converged: true, appliedCode, failures, wroteCart, mutatedGiftLines };
      }
    }
    return {
      passes: maxPasses,
      converged: false,
      appliedCode,
      failures,
      wroteCart,
      mutatedGiftLines
    };
  }

  // src/styles.ts
  var FGE_STYLE_ID = "fge-styles";
  var FGE_CSS = `
.fge{
  --fge-ink:rgb(var(--color-foreground,17,17,17));
  --fge-muted:rgb(var(--color-secondary-text,101,112,110));
  --fge-subtle:#f5f5f5;
  --fge-line:rgba(var(--color-border,235,235,235),var(--alpha-border,1));
  --fge-brand:#111111; --fge-brand-strong:#000000; --fge-card-radius:10px;
  --fge-drawer-pad:36px;
  box-sizing:border-box; font-family:var(--font-body-family,inherit); line-height:1.35;
}
.fge *{ box-sizing:border-box; }

/* --- top: a compact BANNER CARD (subtle outline + light fill, no heavy shadow). The headline is
   only "Spend CA$X more to unlock <gift>" (or "You've unlocked\u2026"); the theme's own "Your cart" drawer
   header sits separately above and is NOT restated here. Kept slim so cart items below keep space. --- */
.fge-stepper-wrap{
  margin:0 0 12px; padding:11px var(--fge-drawer-pad) 8px; color:var(--fge-ink);
  border-bottom:0.1rem solid var(--fge-line); background-color:transparent;
}

.fge-headline{ margin:0 0 2px; font-size:var(--font-size-static-sm,1.2rem); font-weight:600; color:var(--fge-ink); }
.fge-headline .fge-amt{ color:var(--fge-brand-strong); font-weight:750; }
.fge-fullprice-note{ margin:6px 0 0; font-size:var(--font-size-static-xs,1rem); line-height:1.3; color:#c41e3a; font-weight:600; }
.fge-subnote{ margin:6px 0 0; font-size:var(--font-size-static-xs,1rem); line-height:1.3; color:var(--fge-muted); }

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

/* THEME-OVERRIDE: hide per-line totals on HIDDEN (merged-away) rows only. Visible buy rows keep
   their native price display so the merged total is shown. Gift rows are hidden entirely by the
   grouping transform (display:none on the whole row), so their prices never show. Discount-code
   tags that Dawn renders inside the price cell are hidden on grouped rows to avoid stale labels. */
[data-fge-merged-hidden] .cart-item__totals,
[data-fge-merged-hidden] .cart-item__actions--price{ display:none !important; }

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
  border-top:0.1rem solid var(--fge-line); padding:16px var(--fge-drawer-pad) 0; margin-top:8px;
}
.fge-gift__title{ margin:0 0 8px; font-family:var(--font-heading-family,inherit); font-size:var(--font-size-static-sm,1.2rem); font-weight:600; letter-spacing:.01em; }
.fge-gift__hint{ margin:0; font-size:var(--font-size-static-sm,1.2rem); color:var(--fge-muted); }

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
   (inline-block / position), NEVER transform \u2014 so fge-spin owns transform purely for rotation and the
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
  content:"Updating your free gift\u2026"; position:absolute; inset:0; display:flex;
  align-items:center; justify-content:center; color:#fff; font-size:13px;
  letter-spacing:normal; text-transform:none;
}

@media (prefers-reduced-motion: reduce){
  .fge-stepper__fill, .fge-step, .fge-step__dot, .fge-gift.is-pending .fge-card,
  .fge-gift.is-pending .fge-variants{ transition:none; }
  .fge-spinner,
  [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native])::after,
  body.fge-checkout-pending [data-fge-grouped]::after,
  body.fge-checkout-pending #CartDrawer-Checkout::before,
  body.fge-checkout-pending #checkout::before,
  body.fge-checkout-pending [name="checkout"]::before,
  body.fge-checkout-pending .cart__checkout-button::before{ animation:none; }
}

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

/* --- Loading states. TWO distinct phases, so the free-gift line is NEVER shown as a raw cart line:
   (1) UNGROUPED (data-fge-pending, not yet data-fge-grouped): FGE has not classified buys vs the $0
       gift line yet, so the rows are HIDDEN (visibility:hidden \u2014 layout kept) with a spinner. HIDING
       (not dimming) here is what stops a just-added gift line from flashing in before grouping marks
       it display:none \u2014 we cannot safely tell a gift line from a full-price duplicate pre-grouping.
   (2) GROUPED + reconcile running (data-fge-grouped + body.fge-checkout-pending): the gift/get lines
       are already display:none, so the visible BUY rows are DIMMED + DISABLED (opacity,
       pointer-events:none) with a spinner overlaid \u2014 the "updating" look over the real items.
   ATTRIBUTE-based so BOTH the drawer (cart-drawer-items) and the /cart page host (#main-cart-items \u2014 a
   plain div on Dawn-derived themes) are covered. The fail-safe (ensureUnmasked) sets data-fge-grouped
   to lift phase 1; clearGiftPending drops body.fge-checkout-pending to lift phase 2. Sidebar
   (#main-cart-footer), FGE widgets, and checkout stay visible/interactive; min-height reserves room. --- */
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]){
  position:relative; min-height:120px;
}
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]) .cart-item,
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]) [id^="CartDrawer-Item-"],
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]) [id^="CartItem-"],
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]) cart-item,
body.fge-active [data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native]) .cart__row{
  visibility:hidden;
}
body.fge-checkout-pending [data-fge-grouped]{ position:relative; min-height:120px; }
body.fge-checkout-pending [data-fge-grouped] .cart-item,
body.fge-checkout-pending [data-fge-grouped] [id^="CartDrawer-Item-"],
body.fge-checkout-pending [data-fge-grouped] [id^="CartItem-"],
body.fge-checkout-pending [data-fge-grouped] cart-item,
body.fge-checkout-pending [data-fge-grouped] .cart__row{
  opacity:.4; pointer-events:none; transition:opacity .2s ease;
}
[data-fge-pending]:not([data-fge-grouped]):not([data-fge-empty-native])::after,
body.fge-checkout-pending [data-fge-grouped]::after{
  content:""; box-sizing:border-box; position:absolute; z-index:3;
  top:50%; left:50%; margin:-14px 0 0 -14px;
  width:28px; height:28px; border:2.5px solid var(--fge-line,#e3e3e3);
  border-top-color:var(--fge-ink,#111111); border-radius:50%;
  animation:fge-spin .7s linear infinite;
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

  // src/drawerRefresh.ts
  var DRAWER_SUMMARY_SELECTORS = [
    ".cart-drawer__summary",
    "#cart-summary",
    "#CartDrawer-FormSummary",
    ".cart-drawer__footer",
    "[data-cart-footer]",
    ".cart__footer",
    ".drawer__footer"
  ];
  var SUBTOTAL_SELECTORS = [
    ".cart-drawer__total-price",
    ".totals__subtotal-value",
    ".cart-drawer__subtotal .price",
    ".totals__total-value",
    "[data-cart-subtotal]"
  ];
  var BADGE_SELECTORS = [
    ".cart-count-badge",
    ".cart-drawer__title-counter",
    '.cart-count-bubble span[aria-hidden="true"]',
    "[data-cart-count]"
  ];
  function warn(msg, ...data) {
    console.warn(`[FGE-DRAWERFIX] ${msg}`, ...data);
  }
  function overwritePriceFromMinorUnits(el, minorUnits) {
    var _a2;
    const text = (_a2 = el.textContent) != null ? _a2 : "";
    const m = text.match(/\d[\d.,\u00A0\u202F' ]*\d|\d/);
    if (m === null) return;
    const token = m[0];
    const lastDot = token.lastIndexOf(".");
    const lastComma = token.lastIndexOf(",");
    const decPos = Math.max(lastDot, lastComma);
    let decimals = 0;
    let decimalSep = ".";
    if (decPos !== -1 && /^\d{1,3}$/.test(token.slice(decPos + 1))) {
      decimals = token.length - decPos - 1;
      decimalSep = token.charAt(decPos);
    }
    const intText = decimals > 0 ? token.slice(0, decPos) : token;
    const gMatch = intText.match(/[.,\u00A0\u202F' ]/);
    const groupSep = gMatch !== null ? gMatch[0] : decimalSep === "." ? "," : ".";
    const fixed = (minorUnits / Math.pow(10, decimals)).toFixed(decimals);
    const dot = fixed.indexOf(".");
    const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
    const fracPart = dot === -1 ? "" : fixed.slice(dot + 1);
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
    const num = decimals > 0 ? `${grouped}${decimalSep}${fracPart}` : grouped;
    el.textContent = text.replace(token, num);
  }
  function stampAuthoritativeCart(cart) {
    let subtotalTargetsFound = 0;
    for (const sel of SUBTOTAL_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        overwritePriceFromMinorUnits(el, cart.total_price);
        subtotalTargetsFound++;
      });
    }
    let badgeTargetsFound = 0;
    for (const sel of BADGE_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.textContent = String(cart.item_count);
        badgeTargetsFound++;
      });
    }
    if (subtotalTargetsFound === 0) {
      warn("stamp: no subtotal target found", SUBTOTAL_SELECTORS);
    }
    if (badgeTargetsFound === 0) {
      warn("stamp: no badge target found", BADGE_SELECTORS);
    }
    return { subtotalTargetsFound, badgeTargetsFound };
  }
  function replaceDrawerFooter(drawerHtml) {
    const parsed = new DOMParser().parseFromString(drawerHtml, "text/html");
    for (const sel of DRAWER_SUMMARY_SELECTORS) {
      const newBlock = parsed.querySelector(sel);
      const liveBlock = document.querySelector(sel);
      if (newBlock !== null && liveBlock !== null) {
        liveBlock.innerHTML = newBlock.innerHTML;
        return true;
      }
    }
    warn("footer: no summary target found", DRAWER_SUMMARY_SELECTORS);
    return false;
  }

  // src/storefront.ts
  var SOURCE = "free-gift-engine";
  var CART_UPDATE_EVENT = "cart-update";
  var DEBOUNCE_MS = 300;
  var w = window;
  var _a, _b, _c;
  var root = (_c = (_b = (_a = w.Shopify) == null ? void 0 : _a.routes) == null ? void 0 : _b.root) != null ? _c : "/";
  var DRAWER_PANEL_SELECTOR = 'cart-drawer, #CartDrawer, .cart-drawer:not(button):not([class*="__trigger"]), .drawer--cart';
  var presentmentRate = () => {
    var _a2, _b2;
    return (_b2 = (_a2 = w.Shopify) == null ? void 0 : _a2.currency) == null ? void 0 : _b2.rate;
  };
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
  var lastPlan = null;
  var lastMergePlan = { groups: [] };
  var lastDiscountHideIndices = [];
  var displayReconcileInFlight = null;
  function toGroupingLines(cart) {
    return cart.items.map((item, index) => {
      var _a2, _b2, _c2;
      return {
        index,
        key: item.key,
        variantId: item.variant_id,
        quantity: item.quantity,
        finalLinePrice: (_a2 = item.final_line_price) != null ? _a2 : 0,
        originalLinePrice: (_b2 = item.original_line_price) != null ? _b2 : 0,
        marked: isGiftLine(item),
        allocationTitles: ((_c2 = item.discounts) != null ? _c2 : []).map((d) => {
          var _a3;
          return (_a3 = d.title) != null ? _a3 : "";
        }).filter((t) => t !== "")
      };
    });
  }
  function discountBadgeHideIndices(cart) {
    const indices = [];
    cart.items.forEach((item, index) => {
      var _a2;
      const discounts = (_a2 = item.discounts) != null ? _a2 : [];
      if (discounts.length > 0 && !lineHasRealDiscount(discounts)) indices.push(index);
    });
    return indices;
  }
  function toMergeLines(cart) {
    return cart.items.map((item, index) => {
      var _a2, _b2, _c2;
      return {
        index,
        key: item.key,
        variantId: item.variant_id,
        propertiesKey: serializeProperties(item.properties),
        quantity: item.quantity,
        isGift: isGiftLine(item),
        // Absent price fields (older theme/cart) default so final === original: the line reads as
        // full-price and is eligible to merge with an identical sibling (the safe default here).
        finalLinePrice: (_a2 = item.final_line_price) != null ? _a2 : 0,
        originalLinePrice: (_c2 = (_b2 = item.original_line_price) != null ? _b2 : item.final_line_price) != null ? _c2 : 0
      };
    });
  }
  var lastCartQuantities = [];
  function domVariantIds(itemsEl) {
    if (itemsEl === null) return [];
    const ids = [];
    const nodes = itemsEl.querySelectorAll(
      '.cart-item, [id^="CartDrawer-Item-"], [id^="CartItem-"], cart-item, .cart__row'
    );
    for (const node of nodes) {
      const link = node.querySelector('a[href*="variant="]');
      if (link !== null) {
        const m = link.href.match(/variant=(\d+)/);
        if (m !== null) ids.push(Number(m[1]));
      }
    }
    return ids.sort((a, b) => a - b);
  }
  function domMatchesCart(itemsEl, cart) {
    const domIds = domVariantIds(itemsEl);
    const cartIds = cart.items.map((item) => item.variant_id).sort((a, b) => a - b);
    if (domIds.length !== cartIds.length) return false;
    for (let i = 0; i < domIds.length; i++) {
      if (domIds[i] !== cartIds[i]) return false;
    }
    return true;
  }
  function sectionIdForElement(el) {
    const section = el.closest('[id^="shopify-section-"]');
    return section !== null ? section.id.replace("shopify-section-", "") : null;
  }
  function presentCartItemsHosts() {
    const hosts = [];
    for (const el of cartHostElements()) {
      const sectionId = sectionIdForElement(el);
      if (sectionId === null) continue;
      hosts.push({ el, sectionId, isDrawer: el.closest(DRAWER_PANEL_SELECTOR) !== null });
    }
    return hosts;
  }
  function replaceHostInner(liveHost, parsed) {
    const byId = liveHost.id !== "" ? parsed.querySelector(`[id="${liveHost.id}"]`) : null;
    const match = byId != null ? byId : parsed.querySelector(liveHost.tagName.toLowerCase());
    if (match === null) return false;
    liveHost.innerHTML = match.innerHTML;
    return true;
  }
  function pruneStrayLineNodes(host, cart) {
    const cartVariants = new Set(cart.items.map((item) => item.variant_id));
    const nodes = host.querySelectorAll(
      '.cart-item, [id^="CartDrawer-Item-"], [id^="CartItem-"], cart-item, .cart__row'
    );
    for (const node of nodes) {
      const link = node.querySelector('a[href*="variant="]');
      if (link === null) continue;
      const m = link.href.match(/variant=(\d+)/);
      if (m !== null && !cartVariants.has(Number(m[1]))) node.remove();
    }
    console.warn("[FGE-DRAWERFIX] section refresh could not converge; pruned stale nodes", {
      domKeys: domVariantIds(host),
      cartKeys: cart.items.map((i) => i.variant_id)
    });
  }
  async function refreshItemsBody(cart) {
    const hosts = presentCartItemsHosts();
    let drawerHtml;
    let allOk = hosts.length > 0;
    for (const host of hosts) {
      let converged = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt > 1) await new Promise((r) => setTimeout(r, 200));
          const res = await fetch(`${root}?sections=${host.sectionId}`, {
            headers: { Accept: "application/json" }
          });
          if (!res.ok) continue;
          const data = await res.json();
          const html = data[host.sectionId];
          if (html === void 0) continue;
          if (host.isDrawer) drawerHtml = html;
          const parsed = new DOMParser().parseFromString(html, "text/html");
          if (!replaceHostInner(host.el, parsed)) continue;
          if (domMatchesCart(host.el, cart)) {
            converged = true;
            break;
          }
        } catch {
        }
      }
      if (!converged) {
        allOk = false;
        pruneStrayLineNodes(host.el, cart);
      }
    }
    return drawerHtml !== void 0 ? { ok: allOk, drawerHtml } : { ok: allOk };
  }
  async function doVerifiedDisplayReconcile(cartMutated, existingCart, forceItemsRefresh = false) {
    var _a2;
    const cart = existingCart != null ? existingCart : await getCart();
    lastPlan = classifyAndGroup(toGroupingLines(cart), lastDiscount);
    lastMergePlan = planLineMerge(toMergeLines(cart));
    lastDiscountHideIndices = discountBadgeHideIndices(cart);
    lastCartQuantities = cart.items.map((item) => item.quantity);
    for (const section of sections) section.attach();
    const giftQty = cart.items.filter(isGiftLine).reduce((n, item) => n + item.quantity, 0);
    const buyOnlyCount = ((_a2 = cart.item_count) != null ? _a2 : 0) - giftQty;
    if (cart.total_price !== void 0 && cart.item_count !== void 0) {
      stampAuthoritativeCart({ total_price: cart.total_price, item_count: buyOnlyCount });
    }
    const anyDiverged = cartHostElements().some((el) => !domMatchesCart(el, cart));
    let prefetchedDrawerHtml;
    if (forceItemsRefresh || anyDiverged) {
      if (forceItemsRefresh && !anyDiverged) {
        console.warn(
          "[FGE-DRAWERFIX] refreshing items body after FGE cart write (line keys may be stale)"
        );
      } else if (anyDiverged) {
        console.warn("[FGE-DRAWERFIX] DOM/cart divergence detected, forcing body refetch");
      }
      const bodyRefresh = await refreshItemsBody(cart);
      prefetchedDrawerHtml = bodyRefresh.drawerHtml;
      for (const section of sections) section.attach();
      for (const el of cartHostElements()) {
        if (!shouldSkipNativeQtySync(el, lastCartQuantities)) syncNativeInputs(el, lastCartQuantities);
      }
    }
    const anyAhead = cartHostElements().some((el) => shouldSkipNativeQtySync(el, lastCartQuantities));
    if (!anyAhead) {
      const freshCart = await getCart();
      lastCartQuantities = freshCart.items.map((item) => item.quantity);
      for (const el of cartHostElements()) {
        if (!shouldSkipNativeQtySync(el, lastCartQuantities)) syncNativeInputs(el, lastCartQuantities);
      }
    }
    if (cartMutated) {
      await refreshDawnTotals(prefetchedDrawerHtml);
    }
  }
  function verifiedDisplayReconcile(cartMutated = false, existingCart, forceItemsRefresh = false) {
    if (displayReconcileInFlight !== null) {
      return displayReconcileInFlight;
    }
    displayReconcileInFlight = doVerifiedDisplayReconcile(
      cartMutated,
      existingCart,
      forceItemsRefresh
    ).catch(() => void 0).finally(() => {
      displayReconcileInFlight = null;
    });
    return displayReconcileInFlight;
  }
  var giftPendingActive = false;
  var giftPendingWorkDone = false;
  var giftPendingMinElapsed = false;
  var giftPendingMinTimer;
  var giftPendingSafetyTimer;
  var perceptionConfig = null;
  var cartPost = (path, body) => fetch(`${root}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  async function readCartLines() {
    const cart = await getCart();
    const lines = cart.items.map((item) => {
      var _a2;
      return {
        id: item.key,
        variantId: toGid(item.variant_id),
        quantity: item.quantity,
        appAdded: isGiftLine(item),
        finalLinePrice: (_a2 = item.final_line_price) != null ? _a2 : 0,
        // Only a discount that ACTUALLY reduces the line price excludes it from the qualifying subtotal.
        // A BXGY gift code stamps a $0 "entitled" allocation on the full-price BUY lines too, which must
        // NOT exclude the qualifying products (see lineHasRealDiscount for the full failure mode).
        hasDiscountAllocation: lineHasRealDiscount(item.discounts)
      };
    });
    return { lines, currency: cart.currency };
  }
  function serializeProperties(properties) {
    if (properties == null) return "";
    return Object.keys(properties).sort().map((k) => `${k}=${String(properties[k])}`).join("&");
  }
  async function writeMergedGroup(keys, total) {
    const updates = {};
    keys.forEach((key, i) => {
      updates[key] = i === 0 ? total : 0;
    });
    fgeLog("merged-group write", { keys, total, updates });
    if (cartHasFgeLines()) maskAllCartHosts();
    await cartPost("cart/update.js", { updates });
  }
  function mergeKeysFor(el) {
    if (!(el instanceof HTMLElement)) return null;
    const node = el.closest(`[${MERGE_PRIMARY_ATTR}]`);
    if (node === null) return null;
    const raw = node.getAttribute(MERGE_KEYS_ATTR);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) {
        return parsed;
      }
    } catch {
    }
    return null;
  }
  function installMergeInterceptors() {
    document.addEventListener(
      "change",
      (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.name !== "updates[]") return;
        const keys = mergeKeysFor(input);
        if (keys === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const total = Math.max(0, Number.parseInt(input.value, 10) || 0);
        void writeMergedGroup(keys, total);
      },
      true
    );
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const removeBtn = target.closest("cart-remove-button");
        if (removeBtn === null) return;
        const keys = mergeKeysFor(removeBtn);
        if (keys === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void writeMergedGroup(keys, 0);
      },
      true
    );
  }
  async function reconcileOnce(config) {
    selfMutating = true;
    beginGiftPending();
    const lastPriorCode = lastDiscount;
    try {
      const outcome = await reconcileGiftCart(
        {
          readCart: readCartLines,
          // Server-authoritative: every line carries its app-added claim; the server EXCLUDES app-added
          // gift lines from the qualifying subtotal. Choices + decline are chooser-driven (same wire shape).
          validate: async (lines, currency) => {
            const rate = presentmentRate();
            const request = {
              cart: lines.map((l) => {
                var _a2;
                return {
                  variantId: l.variantId,
                  quantity: l.quantity,
                  appAdded: l.appAdded,
                  hasDiscountAllocation: (_a2 = l.hasDiscountAllocation) != null ? _a2 : false
                };
              }),
              choices: choiceState,
              declined,
              presentmentCurrency: currency,
              countryCode: config.country,
              ...rate !== void 0 ? { presentmentRate: rate } : {}
            };
            fgeLog("validate request", {
              cart: request.cart,
              choices: request.choices,
              declined: request.declined,
              currency: request.presentmentCurrency
            });
            const response = await postValidate(request, { proxyPath: config.proxyPath });
            if (!response.ok) {
              fgeLog("validate FAILED (leaving cart untouched)", response);
              return null;
            }
            fgeLog("validate result", response.result);
            lastResult = response.result;
            renderSteppers();
            return response.result;
          },
          post: cartPost,
          // Return whether the discount write actually succeeded. A concurrent Dawn cart/change.js can
          // 422 this cart/update.js (the AJAX cart serializes writes); the loop retries on false so the
          // gift code is never left detached (the "not attached until I edit again" bug).
          setDiscount: async (code) => {
            const res = await cartPost("cart/update.js", { discount: code != null ? code : "" });
            return res.ok;
          },
          // Nudge the theme to re-render its cart UI; tagged with our source so we ignore the echo.
          nudge: () => {
            var _a2;
            return (_a2 = w.publish) == null ? void 0 : _a2.call(w, CART_UPDATE_EVENT, { source: SOURCE });
          }
        },
        { initialCode: lastDiscount }
      );
      fgeLog("reconcile outcome", {
        passes: outcome.passes,
        converged: outcome.converged,
        appliedCode: outcome.appliedCode,
        priorCode: lastPriorCode,
        mutatedGiftLines: outcome.mutatedGiftLines,
        wroteCart: outcome.wroteCart,
        failures: outcome.failures
      });
      lastDiscount = outcome.appliedCode;
      for (const variantId of failedAddVariantIds(outcome.failures)) {
        unavailableVariantIds.add(variantId);
      }
      renderPerception(config);
      const cartMutated = outcome.passes > 1 || outcome.appliedCode !== lastPriorCode;
      const cart = await getCart();
      await verifiedDisplayReconcile(cartMutated, cart, outcome.mutatedGiftLines);
    } finally {
      markGiftWorkDone();
      selfMutating = false;
    }
  }
  function beginGiftPending() {
    giftPendingWorkDone = false;
    if (giftPendingActive || campaignConfig === null || sections.length === 0) {
      return;
    }
    giftPendingActive = true;
    giftPendingMinElapsed = false;
    setCheckoutLocked(true);
    announcePending("Updating your free gift\u2026");
    if (perceptionConfig !== null) {
      renderPerception(perceptionConfig);
    }
    giftPendingMinTimer = setTimeout(() => {
      giftPendingMinElapsed = true;
      giftPendingMinTimer = void 0;
      maybeClearGiftPending();
    }, PENDING_MIN_MS);
    giftPendingSafetyTimer = setTimeout(() => clearGiftPending(), PENDING_MAX_MS);
  }
  function markGiftWorkDone() {
    giftPendingWorkDone = true;
    maybeClearGiftPending();
  }
  function maybeClearGiftPending() {
    if (giftPendingActive && pendingShouldClear(giftPendingWorkDone, giftPendingMinElapsed)) {
      clearGiftPending();
    }
  }
  function clearGiftPending() {
    if (!giftPendingActive) {
      return;
    }
    giftPendingActive = false;
    if (giftPendingMinTimer !== void 0) {
      clearTimeout(giftPendingMinTimer);
      giftPendingMinTimer = void 0;
    }
    if (giftPendingSafetyTimer !== void 0) {
      clearTimeout(giftPendingSafetyTimer);
      giftPendingSafetyTimer = void 0;
    }
    setCheckoutLocked(false);
    announcePending("");
    if (perceptionConfig !== null) {
      renderPerception(perceptionConfig);
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
        currentTierId,
        giftPendingActive
      );
      section.attach();
    }
  }
  function cartHost(itemsEl) {
    var _a2;
    return (_a2 = itemsEl == null ? void 0 : itemsEl.closest("cart-drawer-items, cart-items")) != null ? _a2 : itemsEl;
  }
  var CART_HOST_SELECTORS = "cart-drawer-items, cart-items, #main-cart-items, .cart__items";
  function cartHostElements() {
    const all = Array.from(document.querySelectorAll(CART_HOST_SELECTORS));
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }
  var MASK_ATTR = "data-fge-pending";
  var GROUPED_ATTR = "data-fge-grouped";
  var EMPTY_NATIVE_ATTR = "data-fge-empty-native";
  var MASK_TIMEOUT_MS = 1e3;
  var maskTimer;
  function cartHasFgeLines() {
    return lastPlan === null || lastPlan.lineCount > 0;
  }
  function showNativeEmptyCart(host) {
    if (host === null) return;
    host.removeAttribute(GROUPED_ATTR);
    host.removeAttribute(MASK_ATTR);
    host.setAttribute(EMPTY_NATIVE_ATTR, "");
  }
  function maskCartHost(host) {
    if (host === null) return;
    host.removeAttribute(EMPTY_NATIVE_ATTR);
    host.removeAttribute(GROUPED_ATTR);
    host.setAttribute(MASK_ATTR, "");
    if (maskTimer === void 0) {
      maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
    }
  }
  function maskAllCartHosts() {
    cartHostElements().forEach((el) => {
      maskCartHost(el);
    });
  }
  function applyFgeCartDisplay(itemsEl) {
    if (lastPlan === null) return;
    if (lastPlan.lineCount === 0) {
      showNativeEmptyCart(cartHost(itemsEl));
      return;
    }
    if (applyGiftLineHiding(itemsEl, lastPlan)) {
      applyLineMerge(
        itemsEl,
        lastMergePlan,
        lastPlan.lineCount,
        (minorUnits) => formatMoney(minorUnits)
      );
      applyDiscountBadgeHiding(itemsEl, lastDiscountHideIndices, lastPlan.lineCount);
      return;
    }
    maskCartHost(cartHost(itemsEl));
  }
  function observeDrawerOpen() {
    const drawer = document.querySelector(DRAWER_PANEL_SELECTOR);
    if (drawer === null) return;
    new MutationObserver(() => {
      if (drawer.classList.contains("active")) {
        if (cartHasFgeLines()) {
          maskAllCartHosts();
        } else {
          cartHostElements().forEach((el) => showNativeEmptyCart(el));
        }
        void verifiedDisplayReconcile();
      }
    }).observe(drawer, { attributes: true, attributeFilter: ["class"] });
  }
  function schedule(config) {
    if (running) {
      pending = true;
      if (cartHasFgeLines()) {
        maskAllCartHosts();
      }
      return;
    }
    if (cartHasFgeLines()) {
      maskAllCartHosts();
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
  var cachedDrawerSectionId = null;
  function detectDrawerSectionId() {
    var _a2, _b2, _c2, _d;
    if (cachedDrawerSectionId !== null) return cachedDrawerSectionId;
    const itemsAnchors = [
      "#CartDrawer-Body",
      "cart-drawer-items",
      ".cart-drawer__items",
      "[data-cart-body]",
      "[data-cart-items]"
    ];
    for (const sel of itemsAnchors) {
      const el = document.querySelector(sel);
      if (el !== null) {
        const section = el.closest('[id^="shopify-section-"]');
        if (section !== null) {
          cachedDrawerSectionId = section.id.replace("shopify-section-", "");
          return cachedDrawerSectionId;
        }
      }
    }
    const drawer = document.querySelector(DRAWER_PANEL_SELECTOR);
    if (drawer !== null) {
      const section = (_a2 = drawer.closest('[id^="shopify-section-"]')) != null ? _a2 : drawer.querySelector('[id^="shopify-section-"]');
      if (section !== null) {
        const id = section.id.replace("shopify-section-", "");
        if (section.querySelector(".cart-item, #CartDrawer-Body, cart-drawer-items") !== null) {
          cachedDrawerSectionId = id;
          return id;
        }
        console.warn("[FGE-DRAWERFIX] drawer section misdetected ->", id);
      }
      const dataId = (_d = (_b2 = drawer.closest("[data-section-id]")) == null ? void 0 : _b2.dataset["sectionId"]) != null ? _d : (_c2 = drawer.dataset) == null ? void 0 : _c2["sectionId"];
      if (dataId !== void 0 && dataId !== "") {
        cachedDrawerSectionId = dataId;
        return dataId;
      }
    }
    return "cart-drawer";
  }
  function detectBadgeSectionId() {
    const bubble = document.getElementById("cart-icon-bubble");
    if (bubble !== null) {
      const section = bubble.closest('[id^="shopify-section-"]');
      if (section !== null) return section.id.replace("shopify-section-", "");
    }
    return "cart-icon-bubble";
  }
  async function refreshDawnTotals(prefetchedDrawerHtml) {
    try {
      const drawerSectionId = detectDrawerSectionId();
      const badgeSectionId = detectBadgeSectionId();
      const pageFooterEl = document.getElementById("main-cart-footer");
      const pageFooterSection = pageFooterEl == null ? void 0 : pageFooterEl.dataset["id"];
      const sectionIds = [badgeSectionId];
      if (pageFooterSection !== void 0 && pageFooterSection !== "") {
        sectionIds.push(pageFooterSection);
      }
      if (prefetchedDrawerHtml === void 0) {
        sectionIds.unshift(drawerSectionId);
      }
      const res = await fetch(`${root}?sections=${sectionIds.join(",")}`, {
        headers: { Accept: "application/json" }
      });
      if (!res.ok) return;
      const data = await res.json();
      applyBadgeAndPageFooter(data, badgeSectionId, pageFooterEl, pageFooterSection);
      const drawerHtml = prefetchedDrawerHtml != null ? prefetchedDrawerHtml : data[drawerSectionId];
      if (drawerHtml !== void 0) replaceDrawerFooter(drawerHtml);
    } catch {
    }
  }
  function applyPageFooter(data, pageFooterEl, pageFooterSection) {
    if (pageFooterEl === null) return;
    const footerHtml = data[pageFooterSection];
    if (footerHtml === void 0) return;
    const parsed = new DOMParser().parseFromString(footerHtml, "text/html");
    const newContent = parsed.querySelector(".js-contents");
    const liveContent = pageFooterEl.querySelector(".js-contents");
    if (newContent !== null && liveContent !== null) {
      liveContent.innerHTML = newContent.innerHTML;
    }
  }
  function applyBadgeAndPageFooter(data, badgeSectionId, pageFooterEl, pageFooterSection) {
    var _a2;
    const badgeHtml = data[badgeSectionId];
    if (badgeHtml !== void 0) {
      const liveBadge = document.getElementById("cart-icon-bubble");
      if (liveBadge !== null) {
        const parsed = new DOMParser().parseFromString(badgeHtml, "text/html");
        const newBadge = parsed.querySelector(".shopify-section");
        if (newBadge !== null) {
          ((_a2 = liveBadge.querySelector(".shopify-section")) != null ? _a2 : liveBadge).innerHTML = newBadge.innerHTML;
        }
      }
    }
    if (pageFooterSection !== void 0 && pageFooterSection !== "") {
      applyPageFooter(data, pageFooterEl, pageFooterSection);
    }
  }
  function applyInitialMask() {
    cartHostElements().forEach((el) => {
      el.setAttribute(MASK_ATTR, "");
    });
    maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
  }
  function ensureUnmasked() {
    if (maskTimer !== void 0) {
      clearTimeout(maskTimer);
      maskTimer = void 0;
    }
    if (running || pending) {
      maskTimer = setTimeout(ensureUnmasked, MASK_TIMEOUT_MS);
      return;
    }
    if (lastPlan !== null && lastPlan.lineCount === 0) {
      document.querySelectorAll(`[${MASK_ATTR}]`).forEach((el) => {
        el.removeAttribute(MASK_ATTR);
      });
      cartHostElements().forEach((el) => showNativeEmptyCart(el));
      return;
    }
    document.querySelectorAll(`[${MASK_ATTR}]`).forEach((el) => {
      el.setAttribute(GROUPED_ATTR, "");
      el.removeAttribute(MASK_ATTR);
    });
    cartHostElements().filter((el) => !el.hasAttribute(GROUPED_ATTR) && !el.hasAttribute(EMPTY_NATIVE_ATTR)).forEach((el) => {
      el.setAttribute(GROUPED_ATTR, "");
    });
  }
  async function loadCampaignConfig(config) {
    const rate = presentmentRate();
    const result = await getConfig({
      presentmentCurrency: config.presentmentCurrency,
      countryCode: config.country,
      ...rate !== void 0 ? { presentmentRate: rate } : {}
    });
    if (!result.ok || result.config.status !== "active") {
      return;
    }
    campaignConfig = result.config;
    const cartGiftVariantIds = new Set(
      (await getCart()).items.filter(isGiftLine).map((item) => toGid(item.variant_id))
    );
    choiceState = {
      ...defaultGiftChoices(campaignConfig.tiers),
      ...choicesFromCart(campaignConfig.tiers, cartGiftVariantIds)
    };
    renderPerception(config);
    schedule(config);
  }
  function init() {
    var _a2;
    const config = readConfig();
    if (config === null) {
      return;
    }
    perceptionConfig = config;
    injectStyles();
    document.body.classList.add("fge-active");
    let timer;
    sections = mountCartContexts({
      drawerSelector: config.drawerSelector,
      onReattach: (_context, itemsEl) => {
        const host = cartHost(itemsEl);
        if (lastPlan !== null && lastPlan.lineCount === 0) {
          showNativeEmptyCart(host);
          return;
        }
        if (host !== null) {
          host.removeAttribute(EMPTY_NATIVE_ATTR);
        }
        if (lastPlan !== null) {
          applyFgeCartDisplay(itemsEl);
        } else if (host !== null) {
          host.removeAttribute(GROUPED_ATTR);
          maskCartHost(host);
        }
      }
    });
    applyInitialMask();
    observeDrawerOpen();
    installMergeInterceptors();
    const trigger = (data) => {
      if (data !== null && typeof data === "object" && data.source === SOURCE) {
        return;
      }
      if (cartHasFgeLines()) {
        maskAllCartHosts();
      }
      if (timer !== void 0) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = void 0;
        schedule(config);
      }, DEBOUNCE_MS);
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
    void loadCampaignConfig(config);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
