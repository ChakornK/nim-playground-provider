# Build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
# Reference official lightpanda/browser image in build stage
COPY --from=lightpanda/browser /usr/bin/lightpanda /usr/bin/lightpanda
RUN test -x /usr/bin/lightpanda

# Runtime stage (glibc-based; lightpanda binary links against glibc, not musl)
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Copy binary from build stage
COPY --from=build /usr/bin/lightpanda /usr/bin/lightpanda
RUN test -x /usr/bin/lightpanda

# Copy production artifacts
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

ENV PORT=8787
ENV HOST=0.0.0.0
ENV POOL_SIZE=2
ENV LIGHTPANDA_PATH=/usr/bin/lightpanda
ENV MODEL=z-ai/glm-5.2

EXPOSE 8787

CMD ["node", "--experimental-strip-types", "--max-old-space-size=96", "src/index.ts"]