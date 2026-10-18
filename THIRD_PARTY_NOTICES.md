# Third-party licensing

Walden's [Apache-2.0 license](LICENSE) covers its original code and documentation. Dependencies, downloaded models, browser binaries, fonts, and container base images retain their own licenses. The project license does not relicense those materials or grant rights to third-party trademarks.

## Dependencies

The exact JavaScript dependency versions are recorded in `pnpm-lock.yaml`. Preserve upstream license files and notices when redistributing dependencies. Web and landing builds generate `dist/THIRD_PARTY_LICENSES.txt` from scoped `pnpm licenses list --prod --json` inventories and installed license, notice, copyright, and attribution files. The artifact also retains Walden's own `LICENSE` and `NOTICE`. The web inventory includes API and web production dependencies; the landing inventory includes its own production dependencies. Platform-specific dependencies follow the build host. It is served at `/THIRD_PARTY_LICENSES.txt`. The Docker runtime's `/app/THIRD_PARTY_LICENSES.txt` merges that inventory with every package in the image's deployed `node_modules/.pnpm` store; Walden workspace packages retain the repository `LICENSE`.

Some upstream packages omit license text from their published archives. Verified, exact-version supplements under `licenses/npm` retain the original upstream texts and provenance. When the published license declaration is the available grant, its original metadata and canonical terms are retained with that distinction explicitly labeled. Supplements are checked offline against SHA-256 hashes. Unknown omissions remain marked `MISSING_LICENSE_TEXT` and block image publication. The JavaScript artifact does not cover downloaded browser binaries, OS packages, model assets, or all libraries inside native binaries; those have separate artifacts below.

Notable components include:

| Component | License and attribution source |
| --- | --- |
| React, Hono, CodeMirror, TanStack, Radix UI, Three.js | MIT; see each installed package's license and copyright notices. |
| Vercel AI SDK and AWS SDK for JavaScript | Apache-2.0; see each installed package's license and notices. |
| Mastra | Apache-2.0 for the open-source portions, with separate terms for enterprise directories; see the section below. |
| Hugging Face Transformers.js | Apache-2.0; transitive native libraries retain separate licenses. |
| KaTeX and its bundled fonts | MIT; preserve the KaTeX license and font copyright notices from the installed `katex` package. |
| Lucide icons | ISC; preserve the installed `lucide-react` license, including the Feather-derived icon attribution. |
| Playwright | Apache-2.0; the copied seccomp profile's license is retained in [deploy/docker/PLAYWRIGHT-LICENSE](deploy/docker/PLAYWRIGHT-LICENSE). Chromium has additional third-party notices. |

This summary and the generated inventory are not a complete redistribution clearance. Retain the generated artifact with compiled assets, review missing texts, and meet the separate native, browser, model, and OS requirements below.

## Mastra enterprise files

The pinned `@mastra/core@1.78.0` package's `LICENSE.md` excludes directories named `ee/` from Apache-2.0. Designated enterprise features have separate terms under the [Mastra Enterprise License v2](https://github.com/mastra-ai/mastra/blob/6a465f9d1da730e179c44bfb4ef3e6ec398ba81f/ee/LICENSE). Package-level Apache-2.0 metadata does not relicense those features.

This release's ordinary agent implementation imports enterprise auth chunks and `auth/ee/fga-check.js`; removing the chunks breaks the import graph. [Upstream issue #22113](https://github.com/mastra-ai/mastra/issues/22113) describes publishing a Docker image with the complete package and no enterprise features enabled. A [Mastra maintainer responded that this use would be fine](https://github.com/mastra-ai/mastra/issues/22113#issuecomment-5405270073) and acknowledged unclear wording; [PR #22474](https://github.com/mastra-ai/mastra/pull/22474) subsequently clarified licensing documentation and package notices.

Walden retains the working dependency tree without enabling Mastra enterprise features or bypassing authorization/license checks. Based on that upstream clarification, bundled Mastra enterprise file presence is informational rather than an automatic publication blocker. This does not relicense enterprise code or grant permission to enable enterprise features; review their applicable terms before doing so. The image check cannot determine which features an application enables.

Before publishing an image, run `pnpm check:public-image YOUR_IMAGE`. This read-only check runs without network access. It reports bundled Mastra enterprise files as informational warnings, and rejects other enterprise payloads requiring review, unresolved license-text entries, and missing project/model/generated notice artifacts. The release workflow also verifies native notice checksums and publishes matching source companions. Passing the package check alone does not replace the native, browser, and OS requirements.

## Embedding model

Self-hosted setup downloads [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), revision `751bff37182d3f1213fa05d7196b954e230abad9`. Its model card declares Apache-2.0. The downloader retains the model card and records the revision, file checksums, and license identifier in `model-manifest.json`.

When redistributing model assets, include the Apache-2.0 license text and retain the upstream model card and attribution. See the model card for the original sentence-transformers model and provenance.

## Fonts and container components

The interface loads IBM Plex Sans and Source Serif 4 from Google Fonts; the landing page also loads Instrument Serif and Karla. These fonts are not vendored in this repository. If you package them locally, retain the applicable upstream font licenses and copyright notices.

Container distributions include Node.js, Debian Chromium, and native libraries such as libvips. The image retains Node's original license, installed Debian copyright files and common licenses, Chromium's embedded credits, and upstream native notices under `/app/notices`. The public image uses Debian Chromium rather than Google Chrome for Testing and its proprietary Widevine component. Local Playwright browser downloads remain a development dependency.

Each image release publishes matching, checksummed native and Debian source archives as separate assets. This includes the selected libvips library sources and build recipes, LGPL/GPL terms, relevant MPL sources and locked Rust dependency sources. [The source instructions and inventory](licenses/native/README.md) document the selected license options, provenance, rebuilding/relinking and split-archive verification. Large source archives stay outside the runtime image. Keep the matching source companions available when redistributing a release. Optional PostgreSQL, Valkey, and SeaweedFS services retain their own licenses independently of Walden.
