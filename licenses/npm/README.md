# Supplemental upstream npm licenses

`manifest.json` maps exact `package@version` identities to original upstream texts
and explicitly labeled canonical terms that the published npm package omitted.
`scripts/third-party-notices.mjs` reads these
files offline, verifies their SHA-256 digests, and retains their source URLs in the
generated attribution artifact. A different package version never inherits a
supplement automatically. Invalid or missing supplement files fail generation;
unresolved package versions retain `MISSING_LICENSE_TEXT` markers.

Each entry records exact npm release metadata and a full upstream source commit
or an integrity-pinned original npm source archive.
Some original maintainers added a license after publication; those entries record
source comparisons establishing that the license applies to the released code.
Chainsaw retains its author's original copyright and MIT-reference notice together
with the referenced canonical terms, rather than attributing those terms to a
file the author did not publish. Where a published package declares a recognized
standard license but omits its full text, the artifact preserves the exact
published declaration and author metadata alongside pinned canonical terms.
Canonical copyright placeholders are reference text, never reconstructed package
copyright notices. Drizzle Kit's conflicting published MIT declaration and
upstream Apache-2.0 text are both retained and explicitly identified.
Platform variants use their own release metadata
or an exact parent release's matching optional dependency declaration.

The group manifests retain the research evidence for the consolidated manifest.
When updating a dependency, inspect its actual package and upstream source first,
retrieve the original applicable license and any bundled third-party notices,
record the pinned provenance and byte digest, and update the consolidated mapping.
Never copy a neighboring package's copyright or invent a copyright holder or year.
For canonical terms, retain the exact license declaration, archive integrity,
original metadata and notices, and an explanation distinguishing reference terms
from original package license files. `sourceArchiveMember` identifies the exact
unmodified member of an integrity-verified npm tarball; `sourceEncoding: base64`
identifies Gitiles transport decoded before the recorded text digest is checked.
Run `pnpm test:licenses` after updating the files.

`unresolved.json` records remaining original-text gaps and license conflicts, with
their production-inventory scopes and paths observed in the local
`walden:public-cleanup` Docker image. These paths describe that inspected image,
not a guarantee about future builds. Scoped inventories include transitive
production dependencies and are still supersets of compiled browser code.

Web/API attribution uses `--filter=@walden/api --filter=@walden/web`; landing-only
attribution uses `--filter=@walden/landing`. Omitting filters inventories all
workspace production dependencies.

Native source/relinking and distribution obligations are tracked separately under
`licenses/native` and `THIRD_PARTY_NOTICES.md`. Vendored license texts alone do not
establish that all native distribution requirements have been met.
