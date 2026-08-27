# Auth Service Dockerfile - Node.js ARM64
# Validates: Requirements 7.2

FROM --platform=linux/arm64 node:20-slim AS builder

WORKDIR /app

# Use China npm mirror for faster installs
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production stage ---
FROM --platform=linux/arm64 node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --production

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
