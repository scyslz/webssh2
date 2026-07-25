FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY conf/webssh_config.json ./defaults/webssh_config.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
