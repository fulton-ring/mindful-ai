# Landing page

The marketing site at withwalden.app. Astro builds static HTML; React (`@astrojs/react`) is available for interactive islands. It deploys as an assets-only Worker, `walden-landing`. The app is the `walden` Worker in `apps/api`, served at chat.withwalden.app.

```sh
pnpm --filter @walden/landing dev      # http://localhost:4321
pnpm --filter @walden/landing build    # astro check + static build into dist/
pnpm --filter @walden/landing preview  # serve dist/ with wrangler, including _redirects
pnpm --filter @walden/landing deploy   # explicit request only
```

Set `PUBLIC_APP_URL` (see `.env.example`) to point "Open Walden", "Start thinking" and the Terms/Privacy links at another deployment of the app; it defaults to http://localhost:5173 (the local web app) under `dev` and to https://chat.withwalden.app in builds. The Terms of Service and Privacy Policy live in the app, at `/terms` and `/privacy`.

`public/_redirects` sends the app's old paths (`/conversations/*`, `/notes/*`) to chat.withwalden.app.

## Domains and deploys

withwalden.app and www.withwalden.app are custom domains on this Worker; the app is the `walden` Worker at chat.withwalden.app. Pushes to `main` deploy each Worker after checks pass, and only when its files changed (`.github/workflows/ci.yml`). That needs a `CLOUDFLARE_API_TOKEN` repository secret; without it the deploy jobs skip.
