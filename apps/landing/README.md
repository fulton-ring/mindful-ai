# Landing page

Astro builds this marketing site as static HTML. React (`@astrojs/react`) is available for interactive islands. The portable Wrangler example serves the build as an assets-only Worker named `walden-landing`; the app lives in `apps/api`.

```sh
pnpm --filter @walden/landing dev      # http://localhost:4321
pnpm --filter @walden/landing build    # astro check + static build into dist/
pnpm --filter @walden/landing preview  # serve dist/ with Wrangler, including _redirects
```

Set `PUBLIC_APP_URL` to your app URL and `PUBLIC_SITE_URL` to the canonical landing-page URL, either in the shell or in `apps/landing/.env` (see `.env.example`). Shell values take precedence. App links default to `http://localhost:3000`, matching `pnpm dev`; the canonical site defaults to `http://localhost:4321`.

The build generates `dist/_redirects` from the same `PUBLIC_APP_URL` used by the page links. Old app paths (`/conversations/*`, `/notes/*`, `/terms`, `/privacy`, `/sign-in`) redirect to your configured app. Terms and Privacy pages live in the app.

## Deployment

Builds do not deploy. Configure your own account, resources and optional custom-domain routes in a private Wrangler profile. See [credential and deployment setup](../../docs/runbooks/credentials.md) for explicit deployment commands.

GitHub deploys are manual `workflow_dispatch` runs on `main`, gated by verification and standalone integration checks. The `production` environment requires the deployment token, the selected Worker's raw private Wrangler config secret, and public URL variables. Missing settings fail the job. Main pushes run checks without deploying; see [the workflow](../../.github/workflows/ci.yml).
