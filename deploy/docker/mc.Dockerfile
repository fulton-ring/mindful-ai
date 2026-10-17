FROM golang:1.24.8-bookworm AS build
WORKDIR /src
ADD https://github.com/minio/mc/archive/7394ce0dd2a80935aded936b09fa12cbb3cb8096.tar.gz /source.tar.gz
RUN tar -xzf /source.tar.gz --strip-components=1 -C /src \
 && CGO_ENABLED=0 GOMAXPROCS=2 go build -p 2 -trimpath -o /mc .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home minio
COPY --from=build /mc /usr/local/bin/mc
COPY MINIO-LICENSE /usr/share/licenses/mc/LICENSE
USER minio
ENTRYPOINT ["mc"]
