# Repository Guidelines

## Project Structure & Module Organization
- `src/index.js` wires Discord/webhook delivery, MQTT subscription, packet decoding, and relay flow.
- `src/config.js` loads `.env` plus channel/webhook config files (JSON or YAML), validates secrets/hashes, and builds routing maps.
- `src/packet-extract.js` extracts MeshCore packet hex from MQTT payloads (JSON, hex, base64, or binary).
- `Dockerfile` and `docker-compose.yaml` define the container build/runtime.

## Build, Test, and Development Commands
- `docker compose up -d --build` builds and runs the relay.
- `docker compose logs -f meshcore-discord-relay` tails logs.

## Coding Style & Naming Conventions
- Node ESM (`"type": "module"` in `package.json`).
- Use 2-space indentation.
- Prefer small helpers for parsing/normalization; keep logging concise.

## Configuration & Operations
- `.env` supplies Discord and MQTT config; use `.env.example` as a template.
- Channel config (`CHANNELS_FILE`, default `channels.yaml`) maps MeshCore channel secrets to Discord channel IDs.
- Webhook config (`WEBHOOKS_FILE`, default `webhooks.yaml`) maps MeshCore channel secrets/hashes to Discord webhooks.
- Secrets/hashes are hex; channel hash is the first byte of SHA256(secret).
- Messages are deduped by message hash per `RELAY_DEDUPE_SECONDS`.

## Feature Notes
- Only MeshCore GroupText payloads are relayed (text chat).
- Messages are posted as `node: message` when the sender is available.
- If a channel key is missing, messages stay encrypted and are skipped.

## Commit & Pull Request Guidelines
- Use short, imperative commit messages.
- Note behavioral changes in PR descriptions.
