# Build stage
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=peer
COPY src ./src
COPY tsconfig.json ./
# Reference official lightpanda/browser image in build stage
COPY --from=lightpanda/browser /usr/bin/lightpanda /usr/bin/lightpanda
RUN test -x /usr/bin/lightpanda

# Runtime stage: distroless bundles node 26 and CA certificates, and lightpanda
# links against glibc (debian 13 is trixie).
FROM gcr.io/distroless/nodejs26-debian13 AS runtime
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

LABEL org.opencontainers.image.title="NVIDIA NIM Playground Provider" \
      org.opencontainers.image.description="Free access to frontier open models via NVIDIA's AI chat, through an OpenAI-compatible API" \
      org.opencontainers.image.source="https://github.com/ChakornK/nim-playground-provider" \
      org.opencontainers.image.authors="ChakornK <chakornk2007@gmail.com>" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 8787

# The distroless image sets ENTRYPOINT to node; remaining args go to node.
# Node measured 127-152MB RSS / 38-43MB heap under load
CMD ["--experimental-strip-types", "--max-old-space-size=256", "src/index.ts"]
