# Native attribution and corresponding source

The runtime collector retains the installed Debian package copyright files and
common license texts, Chromium's embedded `chrome://credits`, and the upstream
Node.js, libvips dependency, and Canvas Rust notices in this directory. The
application's npm attribution also contains ONNX Runtime, Skia, and C++ runtime
notices. These are original license texts, including copyright and patent
notices, rather than a list of license identifiers.

`sources.json` pins the exact sharp-libvips 1.3.3 build recipe, its source
archives and patches, and librsvg's Rust crate archives from the shipped
`Cargo.lock`. It also includes exact Canvas 1.0.11, LibSQL 0.5.29, Lightning CSS 1.33.0,
and Rollup 4.63.3 source trees and locked Rust crate archives.
SHA256 values for Rust archives come from each upstream `Cargo.lock`; the other
archives and patches were downloaded and hashed when this manifest was created.
The six excluded crates are macOS dependencies or Windows import libraries that
are not built into the Linux native libraries. Original license text missing
from published Rust archives was recovered from their Cargo VCS commits; difflib
uses a pinned upstream commit whose `src/lib.rs` matches the published crate.

LibSQL includes MPL-2.0 webpki-roots source; Lightning CSS and several
dependencies use MPL-2.0. Their exact published source archives are included.
Rollup sources and crate notices are retained as a conservative superset.

ONNX Runtime sources include the exact Eigen MPL-2.0 archive pinned by the
node and web builds, plus their original source patches and CMake recipes.

The upstream sharp-libvips notice elects LGPLv3 through the “or later” option for
several libraries, including libvips, GLib, libheif, librsvg, and Pango. It also
identifies Cairo as MPL-2.0. Their sources and build patches must accompany
public distribution; package metadata and license text do not replace source.
The native addon loads the libvips shared library dynamically. The container
must permit users to replace that library; it must not introduce restrictions
on modification or reverse engineering for debugging those modifications.
See the original [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html) and
[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) terms.

Debian's GPL/LGPL programs and libraries, including Chromium, are collected
separately using the exact installed source package names and versions. Keep
Debian source repositories and authenticated apt metadata available in the
source collection stage. The collector downloads every source package rather
than making an incomplete license-name heuristic. It verifies that each source
package has a `.dsc` and every file listed by its `Checksums-Sha256` field.

Run from the repository root:

```sh
node scripts/container-notices.mjs runtime /out/notices
node scripts/container-notices.mjs sources /out/sources/native
node scripts/container-notices.mjs debian-sources /out/notices/debian-packages.tsv /out/sources/debian
node scripts/container-notices.mjs verify /out/sources/native
node scripts/container-notices.mjs verify /out/sources/debian
```

`runtime` runs inside the final Linux filesystem after production modules have
been copied. It verifies Node and all native source-covered npm package versions against the
pins and fails if any installed Debian package lacks a readable copyright file.
`CHROMIUM_EXECUTABLE_PATH` defaults to `/usr/bin/chromium`.
`WALDEN_NATIVE_LICENSES_DIR` can point to this directory when the script is
copied outside the repository; `WALDEN_NODE_MODULES_DIR` defaults to
`/app/node_modules`. Browser credits extraction uses `--no-sandbox` only for the
short-lived build-time extraction process, before processing user content.
Application browser sandbox settings are separate.

Use `sources.json` to associate each archive with its upstream URL and hash.
The sharp-libvips packaging archive contains `build.sh`, `build/posix.sh`,
platform Dockerfiles, and version definitions. These specify how to rebuild
libvips and its combined dependencies. The four source patches are archived
separately with pinned contents. For an offline build, map the recipe's download
URLs to the corresponding local files in the source manifest. The normal
upstream build recipe uses the network to fetch its toolchain and build tools.

Publish the complete source companion with the image release and retain it
while binaries are distributed. For release hosts with per-file limits:

```sh
tar -cf /out/walden-sources.tar -C /out/sources .
node scripts/container-notices.mjs split /out/walden-sources.tar /out/release-parts
node scripts/container-notices.mjs verify /out/release-parts
```

The parts are at most 1,500,000,000 bytes. The parts manifest records their
individual hashes and the complete archive hash. Recipients can concatenate
parts in filename order, verify the complete archive hash, extract it, and run
offline verification against each nested manifest. Publish that manifest with
the parts. A successful collector run establishes archive integrity and
attribution presence; it is not a legal clearance or an assertion that arbitrary
upstream binaries have redistribution permission.

The container uses Debian Chromium. The former Playwright download was Google
Chrome for Testing and included Widevine under a license expressly prohibiting
redistribution without a separate Google agreement. It must not be reintroduced
on the assumption that the Chromium source license applies to those binaries.
The unused Playwright FFmpeg download is also excluded. Its static binary had
additional LGPL source obligations.

Original license files omitted from published crates were recovered from their
exact Cargo VCS commits where available. `RUST-PUBLISHED-LICENSE-DECLARATIONS.txt`
preserves the exact published Cargo.toml, including author and license metadata,
for crates lacking separate license files. It supplies separately labeled
canonical SPDX terms for their explicit declarations. Those reference terms are
not represented as original crate license files; no copyright holder or year
has been invented. Some SWC crate VCS URLs are unavailable, some projects have
no separate license file at their published commit, and the original SeaHash
GitLab endpoint was unavailable during this review. The original published
source archives and declarations remain available and checksummed.

Rust standard library notices include original LICENSE-MIT, LICENSE-APACHE, and
COPYRIGHT files from exact toolchain commits identified in shipped native
binary source paths. The manifest records the observed platform and method; it
does not assert identical build provenance for other architectures. Canvas
GNU C++ runtime build provenance also has an upstream limitation: its build
uses a mutable LLVM-major-version package and builder image, so the exact
patch-level build cannot be established from its source recipe alone. Original
LLVM runtime license text is retained with npm attribution.

The Linux x64 GNU store additionally contains `@napi-rs/lzma-linux-x64-gnu@1.5.1`
through Rollup's optional dependencies in the API production closure. Its exact
upstream source archive is pinned in `sources.json`. This addon uses pure-Rust
`lzma-rust2` 0.16.5 (Apache-2.0), rather than the liblzma/xz C library. Binary
source paths also identify N-API 3.10.5, N-API sys 3.2.3, Tokio 1.52.3, and
libloading 0.9.0; the compiler records Rust 1.97.0 commit
`2d8144b7880597b6e6d3dfd63a9a9efae3f533d3`. The original Apache, MIT, ISC,
and Rust standard-library license texts for these observations are already
retained byte for byte in the native notices. `platformNativeAddons` records
original source URLs, archive/binary hashes, and the retained notice paths.

The LZMA release does not publish Cargo.lock. The exact resolved Mimalloc
wrapper/native-library versions therefore remain unproven. A conservative check
of all 40 compatible releases published before this npm version found only two
distinct original MIT notices; both are already retained in the Rollup native
notices. This check establishes notice coverage without claiming an original
build lock or substituting the addon's MIT declaration for embedded licenses.
The observed native dependencies are permissively licensed; no new liblzma/xz
corresponding-source requirement was identified. This platform-specific record
is informational and does not require the x64 package on arm64.
