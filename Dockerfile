FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY conf/webssh_config.json ./defaults/webssh_config.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.cjs"]
