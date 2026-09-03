FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

RUN mkdir -p /data/media && chown -R node:node /data

USER node

ENV MEDIA_ROOT=/data/media
ENV PORT=3210

EXPOSE 3210

CMD ["node", "src/server.js"]
