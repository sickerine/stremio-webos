# The relay is pure Node: it resolves redirects and relays TV state. No media, no
# ffmpeg. The browser does all the media work, so this image is tiny.
# node:22-slim (glibc), and we install without the host lockfile so npm fetches the
# container's own platform-native optional deps (rolldown/vite binding).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
ENV PORT=3211
EXPOSE 3211
CMD ["node", "server/server.js"]
