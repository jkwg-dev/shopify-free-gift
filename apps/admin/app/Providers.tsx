'use client';

// Client boundary for Polaris' AppProvider (Polaris components are client-only). Kept separate so the
// root layout can stay a server component (reads env for the App Bridge meta).
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }): ReactNode {
  return <AppProvider i18n={enTranslations}>{children}</AppProvider>;
}
