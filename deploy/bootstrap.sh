#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu server: installs Docker, then starts Stabledesk.
set -euo pipefail

echo "==> Installing Docker (if missing)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Opening the firewall for web + SSH (if ufw is active)…"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  || true
  ufw allow 80/tcp  || true
  ufw allow 443/tcp || true
fi

echo "==> Building and starting Stabledesk…"
docker compose up -d --build

echo ""
echo "==> Done. Follow the logs with:  docker compose logs -f"
echo "==> Once DNS points here, visit:  https://stabledesk.xyz"
