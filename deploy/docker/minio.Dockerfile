# Local S3 test dependency, built from the upstream source-only distribution.
FROM golang:1.24.8-bookworm AS build
WORKDIR /src
ADD https://github.com/minio/minio/archive/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a.tar.gz /source.tar.gz
RUN tar -xzf /source.tar.gz --strip-components=1 -C /src \
 && CGO_ENABLED=0 GOMAXPROCS=2 go build -p 2 -trimpath -o /minio .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home minio \
 && mkdir /data && chown minio:minio /data
COPY --from=build /minio /usr/local/bin/minio
COPY MINIO-LICENSE /usr/share/licenses/minio/LICENSE
USER minio
VOLUME ["/data"]
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
