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

## 4. Configure `.env`

Edit `.env` and set at minimum:

- `DISCORD_DELIVERY_MODE` (`bot` or `webhook`)
- `DISCORD_TOKEN` (required when `DISCORD_DELIVERY_MODE=bot`)
- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_USERNAME` / `MQTT_PASSWORD` (if required)
- `MQTT_TOPIC` (for example `meshcore/BOS/#`)
- `MQTT_TRANSPORT` (`tcp` or `websockets`)
- `MQTT_TLS` (`true` if your broker uses TLS)

Routing mode:

- `DISCORD_ROUTE_MODE=per_channel` to route by `CHANNELS_FILE` (`channels.yaml` by default)
- `DISCORD_ROUTE_MODE=master` to send everything to one channel
  - bot mode: set `DISCORD_MASTER_CHANNEL_ID`
  - webhook mode: set `default_webhook_url` in your webhook config file

Optional:

- `RELAY_SHOW_PATH=true` to append path line
- `RELAY_EMBED_COLOR="#1e2938"` for embed color
- `MQTT_OBSERVER_ALLOWLIST=name1,name2` to require observer match

## 5. Configure `channels.yaml`

Add your Mesh channel secrets and Discord channel IDs.

Example:

```yaml
default_channel_id: "123456789012345678"
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    discord_channel_ids:
      - "123456789012345678"
```

Notes:

- Keep secrets as hex strings.
- If a channel key is missing, encrypted messages for that channel are skipped.
- In `master` mode, `CHANNELS_FILE` is still used for decryption keys.
- JSON is also supported (`channels.json`) if preferred.

## 5b. Configure `webhooks.yaml` (Webhook Mode Only)

If `DISCORD_DELIVERY_MODE=webhook`, configure webhook routing in `webhooks.yaml` (or `webhooks.json`).

Example:

```yaml
default_webhook_url: ""
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    webhook_url: "https://discord.com/api/webhooks/123456789012345678/replace-with-token"
```

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

## 10. Stop The Relay

```bash
docker compose down
```
