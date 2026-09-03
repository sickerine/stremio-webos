FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /media && chown -R node:node /media

USER node

ENV PORT=3211
EXPOSE 3211

CMD ["node", "src/server.js"]
