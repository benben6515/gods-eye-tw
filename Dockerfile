# Taiwan God's Eye — Cloud Run image (linux/amd64, single-stage so esbuild
# and all native binaries match the runtime arch exactly).
# Runs the production build under `vite preview`, which also mounts the
# server-side provider middleware (AIS/FIRMS/TomTom key brokering).
FROM node:24-slim

WORKDIR /app

# Build-time values baked into the client bundle (client-exposed by design)
ARG CESIUM_ION_TOKEN
ARG VITE_TAIWAN_API_BASE
ENV CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN \
    VITE_TAIWAN_API_BASE=$VITE_TAIWAN_API_BASE \
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Cloud Run injects PORT=8080; preview does not inherit server.port, so pin via CLI
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "8080"]
