FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

RUN mkdir -p /data/media && chown -R node:node /data
USER node

ENV PORT=3211 \
    MEDIA_ROOT=/data/media \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe \
    WATCH_LITE_VCODEC=libx264
EXPOSE 3211
CMD ["node", "src/server.js"]
