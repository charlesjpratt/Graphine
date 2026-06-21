#!/bin/bash
set -e

IMAGE="graphine-windows-builder"
OUTPUT_DIR="$(cd "$(dirname "$0")" && pwd)/dist"

echo "Building Docker image..."
docker build -f Dockerfile.windows -t "$IMAGE" .

echo "Extracting Windows build artifacts..."
CONTAINER_ID=$(docker create "$IMAGE")
docker cp "$CONTAINER_ID:/project/dist/." "$OUTPUT_DIR"
docker rm "$CONTAINER_ID"

echo "Done. Windows installers are in: $OUTPUT_DIR"
