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

## Moving the app to chat.withwalden.app

withwalden.app and www.withwalden.app are attached to the `walden` Worker today. A custom domain belongs to one Worker at a time, so the order matters:

1. In `apps/api/wrangler.jsonc`, add `chat.withwalden.app` as a custom domain and add `https://chat.withwalden.app` to `CLERK_AUTHORIZED_PARTIES`. Deploy the API, then check sign-in at chat.withwalden.app.
2. In the Clerk production instance, add chat.withwalden.app wherever withwalden.app is listed as an allowed origin or redirect URL.
3. Remove withwalden.app and www.withwalden.app from the API's routes and authorized parties, and deploy the API.
4. Deploy this app right away so it takes over withwalden.app and www.withwalden.app.
