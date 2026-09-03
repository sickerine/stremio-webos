FROM alpine:3.22 AS subtitle_extract

ARG SUBTITLE_EXTRACT_VERSION=7.0.0.0
ARG SUBTITLE_EXTRACT_RELEASE=v7
ARG SUBTITLE_EXTRACT_SHA256=1e7c5f0d97b22cbf6a9a71274321202abc28a1f901a9e1bfad11388b3f1373d2

RUN apk add --no-cache curl unzip \
    && curl --fail --location --silent --show-error \
      "https://github.com/jellyfin/jellyfin-plugin-subtitleextract/releases/download/${SUBTITLE_EXTRACT_RELEASE}/subtitle-extract_${SUBTITLE_EXTRACT_VERSION}.zip" \
      --output /tmp/subtitle-extract.zip \
    && echo "${SUBTITLE_EXTRACT_SHA256}  /tmp/subtitle-extract.zip" | sha256sum -c - \
    && mkdir -p /plugin \
    && unzip -q /tmp/subtitle-extract.zip -d /plugin

FROM node:22-alpine AS jellyfin_web

COPY --from=jellyfin/jellyfin:10.11.11 /jellyfin/jellyfin-web/ /jellyfin-web/
COPY patch-hls-profile.mjs /tmp/patch-hls-profile.mjs

RUN node /tmp/patch-hls-profile.mjs /jellyfin-web

FROM jellyfin/jellyfin:10.11.11

COPY --from=jellyfin_web /jellyfin-web/ /jellyfin/jellyfin-web/
COPY --from=subtitle_extract /plugin/ /opt/subtitle-extract/
COPY subtitle-extract.xml /opt/subtitle-extract/Jellyfin.Plugin.SubtitleExtract.xml
COPY entrypoint.sh /usr/local/bin/watch-party-jellyfin-entrypoint

RUN chmod 0755 /usr/local/bin/watch-party-jellyfin-entrypoint

ENTRYPOINT ["/usr/local/bin/watch-party-jellyfin-entrypoint"]
