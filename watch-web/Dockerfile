# The browser handles movie streams; the relay also serves mounted comparison
# clips. Install the tested dependency versions, including Linux optional deps.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
# ffmpeg grabs the TV's current frame for /tv/screenshot (Debian build has zscale + tonemap).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
USER node
ENV PORT=3211
EXPOSE 3211
CMD ["node", "server/server.js"]
