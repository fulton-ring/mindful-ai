# Third-party licensing

Walden's [Apache-2.0 license](LICENSE) covers its original code and documentation. Dependencies, downloaded models, browser binaries, fonts, and container base images retain their own licenses. The project license does not relicense those materials or grant rights to third-party trademarks.

## Dependencies

The exact JavaScript dependency versions are recorded in `pnpm-lock.yaml`. Their packages include upstream license files and, where applicable, notices. Preserve those files when redistributing dependencies. After `pnpm install --frozen-lockfile`, `pnpm licenses list --prod` displays the installed production dependency license inventory; inspect the upstream license files as well as package metadata.

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

This summary is not an exhaustive set of redistribution notices. For compiled web assets or other releases that omit `node_modules`, include the license texts and copyright notices for the dependencies actually bundled in the release.

## Mastra enterprise files

The installed `@mastra/core` package's `LICENSE.md` excludes directories named `ee/` from Apache-2.0 and refers to Mastra's [enterprise license](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE). Walden does not directly import these enterprise modules. Package-level Apache-2.0 metadata must not be treated as permission to redistribute enterprise files.

The current Dockerfile copies the production dependency tree, which can include these files. Before publishing container images, resolve the redistribution terms applicable to the pinned package version or exclude the unused enterprise files and verify the resulting image. Adding Walden's license does not resolve this packaging requirement.

## Embedding model

Self-hosted setup downloads [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), revision `751bff37182d3f1213fa05d7196b954e230abad9`. Its model card declares Apache-2.0. The downloader retains the model card and records the revision, file checksums, and license identifier in `model-manifest.json`.

When redistributing model assets, include the Apache-2.0 license text and retain the upstream model card and attribution. See the model card for the original sentence-transformers model and provenance.

## Fonts and container components

The interface loads IBM Plex Sans and Source Serif 4 from Google Fonts; the landing page also loads Instrument Serif and Karla. These fonts are not vendored in this repository. If you package them locally, retain the applicable upstream font licenses and copyright notices.

Container distributions also include Node.js, Debian packages, Chromium, and potentially native libraries such as libvips. Preserve their notices and fulfill their own redistribution requirements, including applicable source availability obligations. Optional PostgreSQL, Valkey, and SeaweedFS services retain their own licenses independently of Walden.
