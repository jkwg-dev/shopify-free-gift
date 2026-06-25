// Build a signed App Proxy request so you can call /validate directly during the smoke walk
// (the discount code is only minted when /validate is hit). Mirrors verifyAppProxyHmac: a hex
// SHA-256 HMAC of the other query params, sorted and concatenated as `key=value` with NO
// separator, keyed by SHOPIFY_API_SECRET (the app's Client secret).
//
//   SHOPIFY_API_SECRET=... APP_URL=https://your-app.vercel.app \
//   SHOP=our-dev-store.myshopify.com \
//   BODY='{"cart":[{"variantId":"gid://shopify/ProductVariant/123","quantity":1,"appAdded":false}],"choices":{},"declined":false,"presentmentCurrency":"CAD","countryCode":"CA"}' \
//   [CUSTOMER=42] node apps/admin/scripts/sign-proxy-request.mjs
//
// Prints a ready-to-run curl command (and the signed URL). The same request that Shopify would
// forward through the App Proxy — useful for testing the deployed route without the storefront.
import { createHmac } from 'node:crypto';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const secret = requireEnv('SHOPIFY_API_SECRET');
const appUrl = requireEnv('APP_URL').replace(/\/$/, '');
const shop = requireEnv('SHOP');
const body = requireEnv('BODY');
const customer = process.env['CUSTOMER'];

const params = {
  shop,
  path_prefix: '/apps/free-gift',
  timestamp: String(Math.floor(Date.now() / 1000)),
};
if (customer) {
  params.logged_in_customer_id = customer;
}

const message = Object.keys(params)
  .sort()
  .map((key) => `${key}=${params[key]}`)
  .join('');
const signature = createHmac('sha256', secret).update(message).digest('hex');

const qs = new URLSearchParams({ ...params, signature }).toString();
const url = `${appUrl}/apps/free-gift/validate?${qs}`;

console.log('Signed URL:\n' + url + '\n');
console.log('curl command:');
console.log(`curl -sS -X POST '${url}' -H 'content-type: application/json' -d '${body}'`);
