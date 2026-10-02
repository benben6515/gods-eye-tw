#!/bin/bash

# Deploy Taiwan God's Eye (frontend + its key-brokering middleware) to Cloud Run.
#
# Reads keys from .env:
#   - Build-time (baked into client bundle): CESIUM_ION_TOKEN, VITE_TAIWAN_API_BASE
#   - Runtime secrets (server-side middleware only): AISSTREAM_API_KEY, FIRMS_MAP_KEY, TOMTOM_API_KEY
#
# Need run: `gcloud auth login` first; docker must be running.

set -e
source .env

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-gods-eye-tw}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
SHA="$(git rev-parse --short HEAD)"
IMAGE="us-central1-docker.pkg.dev/$PROJECT_ID/$AR_REPO/$SERVICE_NAME:$SHA"

if ! command -v gcloud &>/dev/null || ! command -v docker &>/dev/null; then
  echo "❌ gcloud and docker are required" >&2
  exit 1
fi

RUNNER_SA="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com"

ensure_secret() {
  local secret_name="$1" env_var="$2" value="${!2:-}"
  if [ -z "$value" ]; then
    echo "⚠️  $env_var not set in .env — skipping $secret_name" >&2
    return 1
  fi
  if ! gcloud secrets describe "$secret_name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "🔑 Creating secret $secret_name..." >&2
    printf %s "$value" | gcloud secrets create "$secret_name" \
      --data-file=- --project="$PROJECT_ID" --quiet >&2
    gcloud secrets add-iam-policy-binding "$secret_name" \
      --member "serviceAccount:$RUNNER_SA" \
      --role roles/secretmanager.secretAccessor \
      --project="$PROJECT_ID" --quiet >/dev/null 2>&1
  else
    echo "✓ $secret_name exists" >&2
  fi
}

echo "🔐 Ensuring middleware secrets..."
SECRET_FLAGS=""
for entry in "aisstream-api-key:AISSTREAM_API_KEY" "firms-map-key:FIRMS_MAP_KEY" "tomtom-api-key:TOMTOM_API_KEY"; do
  secret_name="${entry%%:*}"; env_var="${entry##*:}"
  if ensure_secret "$secret_name" "$env_var"; then
    SECRET_FLAGS+="${env_var}=${secret_name}:latest,"
  fi
done
SECRET_FLAGS="${SECRET_FLAGS%,}"

echo "🐳 Building $IMAGE (linux/amd64) ..."
docker build \
  --platform linux/amd64 \
  --build-arg "CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN" \
  --build-arg "VITE_TAIWAN_API_BASE=${VITE_TAIWAN_API_BASE:-}" \
  -t "$IMAGE" .

echo "📤 Pushing image..."
docker push "$IMAGE"

echo "🚀 Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --set-env-vars "HOST=0.0.0.0" \
  --set-env-vars "VITE_TAIWAN_API_BASE=${VITE_TAIWAN_API_BASE:-}" \
  --set-env-vars "TAIWAN_API_BASE=${VITE_TAIWAN_API_BASE:-}" \
  ${SECRET_FLAGS:+--set-secrets "$SECRET_FLAGS"} \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5 \
  --timeout 300

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format 'value(status.url)')

echo ""
echo "✅ Deployed: $SERVICE_URL"
echo ""
echo "⚠️  Remember (one-time, client-exposed keys):"
echo "   - Cesium ion token: add URL restriction for $SERVICE_URL/*"
echo "   - api backend CORS_ORIGIN must include $SERVICE_URL"
