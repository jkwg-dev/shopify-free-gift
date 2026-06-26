// CSP for the embedded admin entry ("/"): Shopify renders the app inside an iframe, which the browser
// blocks unless `frame-ancestors` allows the shop + admin.shopify.com. Scoped to "/" ONLY (matcher) so
// the App-Proxy routes (/apps/free-gift/*), OAuth (/api/auth*), webhooks, and the admin API
// (/api/admin/*) are untouched — they are not framed.
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest): NextResponse {
  const shop = request.nextUrl.searchParams.get('shop');
  const ancestors =
    shop !== null ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com';
  const res = NextResponse.next();
  res.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors};`);
  return res;
}

export const config = { matcher: '/' };
