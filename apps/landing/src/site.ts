// Where the landing page sends people, and who runs Walden. Set PUBLIC_APP_URL
// (e.g. in .env) to point the links at another deployment of the app. Without it,
// `astro dev` links to the local web app (apps/web's Vite server) and builds link
// to production.

const fallback = import.meta.env.DEV ? 'http://localhost:5173' : 'https://chat.withwalden.app';

export const APP_URL = (import.meta.env.PUBLIC_APP_URL || fallback).replace(/\/+$/, '');

// The policies live in the app (apps/web/src/features/legal/LegalPage.tsx) so there
// is one copy of each.
export const COMPANY = {
  name: 'Fulton Ring',
  email: 'info@fultonring.com',
  terms: `${APP_URL}/terms`,
  privacy: `${APP_URL}/privacy`,
};
