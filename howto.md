# Linux Deployment How-To

This guide walks through deploying `meshcore-discord-relay` on Linux from scratch.

## 1. Prerequisites

- A Linux host with internet access
- Docker Engine + Docker Compose plugin installed
- A Discord bot token
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
cp channels.example.json channels.json
```

## 4. Configure `.env`

Edit `.env` and set at minimum:

- `DISCORD_TOKEN`
- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_USERNAME` / `MQTT_PASSWORD` (if required)
- `MQTT_TOPIC` (for example `meshcore/BOS/#`)
- `MQTT_TRANSPORT` (`tcp` or `websockets`)
- `MQTT_TLS` (`true` if your broker uses TLS)

Routing mode:

- `DISCORD_ROUTE_MODE=per_channel` to route by `channels.json`
- `DISCORD_ROUTE_MODE=master` to send everything to one channel
  - set `DISCORD_MASTER_CHANNEL_ID`

Optional:

- `RELAY_SHOW_PATH=true` to append path line
- `RELAY_EMBED_COLOR="#1e2938"` for embed color
- `MQTT_OBSERVER_ALLOWLIST=name1,name2` to require observer match

## 5. Configure `channels.json`

Add your Mesh channel secrets and Discord channel IDs.

Example:

```json
{
  "default_channel_id": "123456789012345678",
  "channels": [
    {
      "name": "public",
      "secret": "8b3387e9c5cdea6ac9e5edbaa115cd72",
      "discord_channel_ids": [
        "123456789012345678"
      ]
    }
  ]
}
```

Notes:

- Keep secrets as hex strings.
- If a channel key is missing, encrypted messages for that channel are skipped.
- In `master` mode, `channels.json` is still used for decryption keys.

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

- `Discord logged in as ...`
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
  - Token missing/invalid in `.env`.
- Messages not decrypted:
  - Missing or wrong `secret`/`hash` in `channels.json`.
- No messages routed in `master` mode:
  - Set `DISCORD_MASTER_CHANNEL_ID` (or `DISCORD_DEFAULT_CHANNEL_ID` fallback).
- Embed color not applied:
  - Quote hex in `.env` like `RELAY_EMBED_COLOR="#1e2938"`.

## 10. Stop The Relay

```bash
docker compose down
```
