// App entry "/" — the embedded admin (Phase 3b). Reuses the pure install gate (resolveRootEntry):
// no shop → a "open from admin" message; invalid shop → 400-ish message; not installed → redirect
// into OAuth begin; installed → render the embedded admin app (list + editor).
// Server component (Node runtime: isShopInstalled uses Prisma + crypto).
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { resolveRootEntry } from '../src/install/rootEntry.js';
import { isShopInstalled } from '../src/validate/composition.js';
import { AdminApp } from './AdminApp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const sp = await searchParams;
  const shopParam = sp['shop'];
  const shop = typeof shopParam === 'string' ? shopParam : null;

  const entry = await resolveRootEntry(shop, { isInstalled: isShopInstalled });
  if (entry.kind === 'redirect') {
    redirect(entry.location); // not installed → OAuth begin
  }
  if (entry.kind === 'bad-request' || shop === null) {
    return <main style={{ padding: 24 }}>{entry.body}</main>;
  }
  // The editor enters thresholds in the shop's single BASE currency (multi-currency is FX-converted on
  // a separate track). Read it server-side and pass it down so the client never guesses the currency.
  const baseCurrency = process.env['SHOPIFY_BASE_CURRENCY'] ?? 'CAD';
  return <AdminApp baseCurrency={baseCurrency} />;
}
