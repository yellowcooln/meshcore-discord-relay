# Migration Guide: Bot -> Webhook

This guide covers migrating an existing bot-based setup to webhook delivery.

## What Changes

- Delivery mode switches from `bot` to `webhook`.
- You add a webhook routing file (`webhooks.yaml` or `webhooks.json`).
- Your channels file is still required for Mesh channel decryption keys.

## 1) Back Up Current Config

```bash
cp .env .env.bak
cp channels.yaml channels.yaml.bak 2>/dev/null || true
cp channels.json channels.json.bak 2>/dev/null || true
cp webhooks.yaml webhooks.yaml.bak 2>/dev/null || true
cp webhooks.json webhooks.json.bak 2>/dev/null || true
```

## 2) Keep/Prepare Channel Keys File

Keep using your existing channel key file (`channels.yaml` or `channels.json`).

- `secret` (or `hash`) values must be correct so messages decrypt.
- `discord_channel_id(s)` can stay; they are ignored in webhook mode.

## 3) Create Webhook Routing File

Recommended: `webhooks.yaml`

```yaml
default_webhook_url: ""
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    webhook_url: "https://discord.com/api/webhooks/ID/TOKEN"
  - name: "test"
    secret: "9cd8fcf22a47333b591d96a2b848b73f"
    webhook_url: "https://discord.com/api/webhooks/ID/TOKEN"
```

Notes:

- Use either `secret`, `hash`, or `name` matching.
- For `DISCORD_ROUTE_MODE=master`, set `default_webhook_url`.

## 4) Update `.env`

Set:

```dotenv
DISCORD_DELIVERY_MODE=webhook
CHANNELS_FILE=channels.yaml
WEBHOOKS_FILE=webhooks.yaml
```

Also:

- `DISCORD_TOKEN` may stay populated; it is ignored in webhook mode.
- Keep your existing MQTT settings unchanged.

## 5) Docker Compose File Mounts

If you use YAML (default), these should exist in `docker-compose.yaml`:

```yaml
environment:
  CHANNELS_FILE: /data/channels.yaml
  WEBHOOKS_FILE: /data/webhooks.yaml
volumes:
  - ./channels.yaml:/data/channels.yaml:ro
  - ./webhooks.yaml:/data/webhooks.yaml:ro
```

If you stay on JSON, use:

```yaml
environment:
  CHANNELS_FILE: /data/channels.json
  WEBHOOKS_FILE: /data/webhooks.json
volumes:
  - ./channels.json:/data/channels.json:ro
  - ./webhooks.json:/data/webhooks.json:ro
```

## 6) Restart And Verify

```bash
docker compose up -d --build
docker compose logs -f meshcore-discord-relay
```

Expected logs include:

- `Discord delivery mode: webhook`
- `Routing mode: per_channel` (or `master`)
- `MQTT connected (...)`

## 7) Rollback (If Needed)

```bash
cp .env.bak .env
docker compose up -d --build
```

If needed, also restore your backed up channel/webhook files.
