# Third-party licensing

Walden's [Apache-2.0 license](LICENSE) covers its original code and documentation. Dependencies, downloaded models, browser binaries, fonts, and container base images retain their own licenses. The project license does not relicense those materials or grant rights to third-party trademarks.

## Dependencies

The exact JavaScript dependency versions are recorded in `pnpm-lock.yaml`. Preserve upstream license files and notices when redistributing dependencies. Web and landing builds generate `dist/THIRD_PARTY_LICENSES.txt` from `pnpm licenses list --prod --json` and installed license, notice, copyright, and attribution files. This artifact includes a superset of workspace production dependencies, including platform-specific dependencies installed on the build host. It is served at `/THIRD_PARTY_LICENSES.txt`; the Docker runtime also retains a copy at `/app/THIRD_PARTY_LICENSES.txt`.

Some upstream packages omit license text from their published archives. The generator retains their README when available and marks these entries `MISSING_LICENSE_TEXT`. Those entries require review and the appropriate upstream texts before public redistribution; a declared license identifier alone is insufficient. The artifact does not cover downloaded browser binaries, OS packages, model assets, or all libraries inside native binaries.

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

The pinned `@mastra/core@1.78.0` package's `LICENSE.md` excludes directories named `ee/` from Apache-2.0. The corresponding upstream release commit uses the [Mastra Enterprise License v2](https://github.com/mastra-ai/mastra/blob/6a465f9d1da730e179c44bfb4ef3e6ec398ba81f/ee/LICENSE), which requires a separate agreement for redistribution. Package-level Apache-2.0 metadata must not be treated as permission to redistribute enterprise files.

Although Walden does not directly import enterprise APIs, this release's ordinary agent implementation imports enterprise auth chunks and `auth/ee/fga-check.js`. Deleting those files breaks the import graph; simple bundling still retains enterprise chunks. The Dockerfile preserves the working production dependency tree. Public image publication remains blocked until upstream provides redistribution permission or a compatible open-source-only package is verified. No license-check or authorization shim is applied.

Before publishing an image, run `pnpm check:public-image YOUR_IMAGE`. This read-only check runs without network access and rejects enterprise directories/chunks, unresolved license-text entries, and missing project/model/generated notice artifacts. It is an explicit release check rather than a prerequisite for existing private Docker builds. Passing it does not replace review of native, browser, and OS licensing. The repository has no automated public-image publication step.

## Embedding model

Self-hosted setup downloads [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), revision `751bff37182d3f1213fa05d7196b954e230abad9`. Its model card declares Apache-2.0. The downloader retains the model card and records the revision, file checksums, and license identifier in `model-manifest.json`.

When redistributing model assets, include the Apache-2.0 license text and retain the upstream model card and attribution. See the model card for the original sentence-transformers model and provenance.

## Fonts and container components

The interface loads IBM Plex Sans and Source Serif 4 from Google Fonts; the landing page also loads Instrument Serif and Karla. These fonts are not vendored in this repository. If you package them locally, retain the applicable upstream font licenses and copyright notices.

Container distributions also include Node.js, Debian packages, Chromium, and potentially native libraries such as libvips. Preserve their notices and fulfill their own redistribution requirements, including applicable source availability obligations. Optional PostgreSQL, Valkey, and SeaweedFS services retain their own licenses independently of Walden.
