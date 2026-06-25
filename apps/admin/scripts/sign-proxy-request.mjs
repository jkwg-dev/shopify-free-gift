// Exercise /validate with a properly SIGNED App Proxy request and print the status + body.
//
// IMPORTANT — who signs: per Shopify's docs, the CLIENT never signs an app-proxy request. Shopify
// computes the `signature` when it FORWARDS a storefront request to your app. So a self-signed
// request must go to the APP ORIGIN directly — it reproduces, byte-for-byte, what Shopify forwards
// (shop, path_prefix, timestamp, [logged_in_customer_id], signature). Self-signing and POSTing to
// the storefront proxy URL would NOT work: Shopify would append its own signature (two `signature`
// params -> our verifier rejects), and a client signature can't bypass a password-protected
// storefront. To test the REAL Shopify->proxy path you must publish the Online Store channel (then
// you do NOT sign — Shopify does).
//
// Signature scheme (matches verifyAppProxyHmac): hex SHA-256 HMAC over the OTHER query params,
// rendered `key=value`, sorted by key, concatenated with NO separator, keyed by SHOPIFY_API_SECRET
// (the shpss_ Client secret).
//
//   SHOPIFY_API_SECRET=<client secret> APP_URL=https://<your-app>.vercel.app \
//   SHOP=greentee-dev.myshopify.com \
//   BODY='{"cart":[...],"choices":{"<tierId>":"a"},"declined":false,"presentmentCurrency":"CAD","countryCode":"CA"}' \
//   [CUSTOMER=42] node apps/admin/scripts/sign-proxy-request.mjs
import { createHmac } from 'node:crypto';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const secret = requireEnv('SHOPIFY_API_SECRET');
const appUrl = requireEnv('APP_URL').replace(/\/$/, ''); // app origin (Vercel), NOT the storefront
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

console.log(`POST ${url}\n`);

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);
