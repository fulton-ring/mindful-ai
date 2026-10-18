import type { APIRoute } from 'astro';
import { APP_URL } from '../site';

// A dynamic route lets Astro emit the reserved underscore-prefixed filename.
export const getStaticPaths = () => [{ params: { redirects: '_redirects' } }];

export const GET: APIRoute = () =>
  new Response(
    `/conversations/* ${APP_URL}/conversations/:splat 301
/notes/* ${APP_URL}/notes/:splat 301
/terms ${APP_URL}/terms 301
/privacy ${APP_URL}/privacy 301
/sign-in ${APP_URL}/ 302
`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
