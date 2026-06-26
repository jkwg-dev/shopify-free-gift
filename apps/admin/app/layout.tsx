// Root layout for the embedded admin (Phase 3b Stage A). Owns the full document so it can place the
// App Bridge requirements in <head>: the `shopify-api-key` meta + the App Bridge CDN script (which
// exposes `window.shopify`, incl. `idToken()` for the session-token boundary). Polaris styles + the
// AppProvider wrap the UI. Route handlers (App Proxy /validate /config, OAuth, webhooks) do NOT render
// through this layout — they return Response directly — so they are unaffected.
import '@shopify/polaris/build/esm/styles.css';
import type { ReactNode } from 'react';
import { Providers } from './Providers.js';

export const metadata = { title: 'Free Gift Engine' };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  const apiKey = process.env['SHOPIFY_API_KEY'] ?? '';
  return (
    <html lang="en">
      <head>
        <meta name="shopify-api-key" content={apiKey} />
        {/* App Bridge must load in <head> before the app code; it reads the meta above. */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
