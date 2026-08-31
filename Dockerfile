# Build stage
FROM oven/bun:1.4.0-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./
# Reference official lightpanda/browser image in build stage
COPY --from=lightpanda/browser:0.3.7 /usr/bin/lightpanda /usr/bin/lightpanda
RUN test -x /usr/bin/lightpanda

# Runtime stage: oven/bun slim (debian glibc, lightpanda links against glibc).
FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
# Copy binary from build stage
COPY --from=build /usr/bin/lightpanda /usr/bin/lightpanda

# Copy production artifacts
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

ENV PORT=8787
ENV HOST=0.0.0.0
ENV POOL_SIZE=2
ENV LIGHTPANDA_PATH=/usr/bin/lightpanda
ENV MODEL=moonshotai/kimi-k3

EXPOSE 8787

USER bun
CMD ["bun", "src/index.ts"]
