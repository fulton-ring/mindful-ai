// Set PUBLIC_APP_URL to point landing-page and legal links at your deployment.
// The default matches the standalone app started by `pnpm dev`.
export const APP_URL = (import.meta.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(
  /\/+$/,
  '',
);

// The policies live in the app (apps/web/src/features/legal/LegalPage.tsx) so there
// is one copy of each.
export const COMPANY = {
  name: 'Fulton Ring',
  site: 'https://fultonring.com',
  email: 'info@fultonring.com',
  terms: `${APP_URL}/terms`,
  privacy: `${APP_URL}/privacy`,
};
