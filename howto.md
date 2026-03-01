# Linux Deployment How-To

This guide walks through deploying `meshcore-discord-relay` on Linux from scratch.

## 1. Prerequisites

- A Linux host with internet access
- Docker Engine + Docker Compose plugin installed
- A Discord bot token (for bot delivery mode) or Discord webhook URLs (for webhook delivery mode)
- MQTT broker host/port/credentials
- Mesh channel secrets (for decrypting GroupText)

## 2. Clone The Repo

```bash
git clone https://github.com/yellowcooln/meshcore-discord-relay.git
cd meshcore-discord-relay
```

## 3. Create Config Files

```bash
cp .env.example .env
cp channels.yaml.example channels.yaml
cp webhooks.yaml.example webhooks.yaml
```

## 4. Configure Shared `.env` Values

Edit `.env` and set the shared settings first (these apply to both modes):

- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_USERNAME` / `MQTT_PASSWORD` (if required)
- `MQTT_TOPIC` (for example `meshcore/BOS/#`)
- `MQTT_TRANSPORT` (`tcp` or `websockets`)
- `MQTT_TLS` (`true` if your broker uses TLS)
- `DISCORD_ROUTE_MODE` (`per_channel` or `master`)

MQTT host tips:

- If Mosquitto runs on the same Linux host (outside Docker), set `MQTT_HOST=host.docker.internal`.
- If Mosquitto runs in Docker, place both containers on the same Docker network and use the Mosquitto service/container name as `MQTT_HOST`.

Optional:

- `RELAY_SHOW_PATH=true` to append path line
- `RELAY_EMBED_COLOR="#1e2938"` for embed color
- `MQTT_OBSERVER_ALLOWLIST=name1,name2` to require observer match

## 5. Choose Delivery Mode

Pick exactly one mode below. Keep the shared settings from Step 4, then apply either Option A or Option B.

Quick mode summary:

- Bot mode: uses one bot token, supports editing previously sent messages when path updates arrive.
- Webhook mode: posts with per-sender display names/avatars, but cannot edit previously sent webhook messages.

### Option A: Bot Mode

Set these in `.env`:

- `DISCORD_DELIVERY_MODE=bot`
- `DISCORD_TOKEN=...` (required)
- If using `DISCORD_ROUTE_MODE=master`, set `DISCORD_MASTER_CHANNEL_ID` (or fallback `DISCORD_DEFAULT_CHANNEL_ID`)
- `WEBHOOKS_FILE` is optional and ignored in bot mode

Use `channels.yaml` for decrypt keys and channel routing.

```yaml
default_channel_id: "123456789012345678"
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    discord_channel_ids:
      - "123456789012345678"
```

### Option B: Webhook Mode

Set these in `.env`:

- `DISCORD_DELIVERY_MODE=webhook`
- `DISCORD_TOKEN` can stay populated but is ignored in webhook mode
- If using `DISCORD_ROUTE_MODE=master`, set `default_webhook_url` in `webhooks.yaml`
- `CHANNELS_FILE` is still required for channel decrypt keys

Use `webhooks.yaml` for webhook routing.

```yaml
default_webhook_url: ""
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    webhook_url: "https://discord.com/api/webhooks/123456789012345678/replace-with-token"
```

Notes for both modes:

- Keep secrets as hex strings.
- If a channel key is missing, encrypted messages for that channel are skipped.
- In `master` mode, `CHANNELS_FILE` is still used for decryption keys.
- JSON is also supported (`channels.json`, `webhooks.json`) if preferred.

Recommended startup defaults:

- Start with `DISCORD_ROUTE_MODE=per_channel` while testing.
- Switch to `master` only after you confirm channel decrypt keys are working.

## 6. Start The Relay

```bash
docker compose up -d --build
```

Check status:

```bash
docker compose ps
```

Check logs:

```bash
docker compose logs -f meshcore-discord-relay
```

## 7. Verify It Works

Expected startup log lines include:

- In bot mode: `Discord logged in as ...`
- In webhook mode: `Discord delivery mode: webhook`
- `Routing mode: per_channel` or `Routing mode: master (...)`
- `MQTT connected (...)`

Then send a Mesh message and confirm it appears in Discord.

## 8. Update / Restart

Pull latest code:

```bash
git pull origin main
```

Rebuild + restart:

```bash
docker compose up -d --build
```

## 9. Common Issues

- `Missing Permissions` in logs:
  - Bot needs `View Channel`, `Send Messages`, `Read Message History`.
- `DISCORD_TOKEN is required`:
  - Bot token missing/invalid while `DISCORD_DELIVERY_MODE=bot`.
- Messages not decrypted:
  - Missing or wrong `secret`/`hash` in your channel config file (`channels.yaml` by default).
- No messages routed in `master` mode:
  - Bot mode: set `DISCORD_MASTER_CHANNEL_ID` (or `DISCORD_DEFAULT_CHANNEL_ID` fallback).
  - Webhook mode: set `default_webhook_url` in your webhook config file.
- Embed color not applied:
  - Quote hex in `.env` like `RELAY_EMBED_COLOR="#1e2938"`.
- MQTT unreachable when broker is on same host:
  - Use `MQTT_HOST=host.docker.internal` (the compose file maps this to the host gateway).

## 10. Stop The Relay

```bash
docker compose down
```
