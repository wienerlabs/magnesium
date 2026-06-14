#!/usr/bin/env bash
set -euo pipefail

# Builds the Magnesium worker container image used to isolate headless workers.
# Works with any Docker-compatible runtime (OrbStack is the recommended backend).

IMAGE="${MAGNESIUM_WORKER_IMAGE:-magnesium/worker:dev}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker CLI not found. Install OrbStack (recommended) or Docker." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon not reachable. Start OrbStack or Docker, then retry." >&2
  exit 1
fi

echo "Building Magnesium worker image: ${IMAGE}"
docker build -t "${IMAGE}" -f "${HERE}/Dockerfile" "${HERE}"
echo "Done. Worker image ready: ${IMAGE}"
