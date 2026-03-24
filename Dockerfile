# Pin exact Alpine digest for reproducible builds
FROM node:20.19.0-alpine3.21 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.19.0-alpine3.21 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Run as non-root user for security
RUN addgroup -S fedlex && adduser -S fedlex -G fedlex
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public ./public
RUN chown -R fedlex:fedlex /app
USER fedlex

EXPOSE 3000

# Graceful shutdown: use dumb-init or handle SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js", "--http"]
