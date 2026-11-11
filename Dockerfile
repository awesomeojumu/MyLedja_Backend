# Multi-stage Dockerfile for MyLedja Backend (NestJS + Fastify)

# -----------------------------------------------------------------------------
# Stage 1: Build
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies if needed
COPY package*.json ./

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Copy TypeScript configs and source code
COPY tsconfig*.json ./
COPY src ./src

# Build TypeScript to dist/
RUN npm run build

# Prune development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: Production Runner
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Install ca-certificates for outbound TLS (Mongo Atlas, Resend, Cloudinary, Mono)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Run container as unprivileged node user
USER node

# Copy runtime assets and dependencies from builder
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

EXPOSE 4000

# Healthcheck checking the root or health endpoint if configured
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/ || exit 0

CMD ["node", "dist/src/main.js"]
