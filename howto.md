# Linux Deployment How-To

This guide walks through deploying `meshcore-discord-relay` on Linux from scratch.

## 1. Prerequisites

- A Linux host with internet access
- Docker Engine + Docker Compose plugin installed
- A Discord bot token (for bot delivery mode) or Discord webhook URLs (for webhook delivery mode)
- MQTT broker host/port/credentials
- Mesh channel secrets (for decrypting GroupText)

## 2. Clone The Repo

The published Docker image is:

```text
yellowcooln/meshcore-discord-relay:latest
```

Clone the repo if you want the included examples and compose file.

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
- `RELAY_BOT_MESSAGE_MODE=simple` or `detailed` for bot output style (`detailed` adds receiver/metrics/path fields)
- `RELAY_EMBED_COLOR="#1e2938"` for embed color
- `MQTT_OBSERVER_ALLOWLIST=name1,name2` to require observer match

### Optional message scopes

Set `RELAY_SHOW_SCOPE=true` to show scope only when a message uses MeshCore
`TransportFlood` or `TransportDirect` routing. Simple bot and webhook messages
get a `Scope: ...` line; detailed bot embeds get a **Scope** field. This is
independent of path display and survives delayed sends and bot path-update edits.
Unscoped messages have no scope label, and display is off by default.

To recognize public hashtag regions, optionally configure candidates:

```dotenv
RELAY_SHOW_SCOPE=true
RELAY_SCOPE_NAMES="Test,#Local"
```

Names are trimmed, get a leading `#` if missing, and are deduplicated without
changing case: `#Local` and `#local` are different key material. Up to 64 unique
names are kept, each at most 64 UTF-8 bytes including `#`; empty, bare `#`,
control-containing and overlong entries are ignored. Quote `.env` values
containing `#` so dotenv does not treat them as comments.

The relay checks each candidate using the packet's payload type and raw encrypted
payload with the decoder's MeshCore region-transport algorithm. A transport code
is **payload-specific**, not a fixed scope ID and not a reversible name. An
unmatched/private scope is shown as e.g. `0x1234` (including `0x0000`), and multiple
matching candidates are explicitly marked `ambiguous`. These are 16-bit matches,
not proof of a unique scope name or sender authentication. Only the first
transport code is the scope; the second return/home code is never shown as scope.

Dedupe and path tracking distinguish unscoped messages from different scope
codes, even with display off. Copies with the same scope code still dedupe across
transport flood/direct and return/home-code changes. No scope-based routing or
filtering is added.

## 5. Choose Delivery Mode

Pick exactly one mode below. Keep the shared settings from Step 4, then apply either Option A or Option B.

Quick mode summary:

- Bot mode: uses one bot token, supports editing previously sent messages when path updates arrive.
- Webhook mode: posts with per-sender display names/avatars, but cannot edit previously sent webhook messages.

### Option A: Bot Mode

Set these in `.env`:

- `DISCORD_DELIVERY_MODE=bot`
- `DISCORD_TOKEN=...` (required)
- Optional: `RELAY_BOT_MESSAGE_MODE=simple` (default) or `detailed`
  - `simple`: compact sender/message embed
  - `detailed`: sender title + message body + receiver/metrics/path fields
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

Use the published image compose example:

```bash
cp docker-compose.image.yaml.example docker-compose.yaml
```

Run with Docker Compose:

```bash
docker compose up -d
```

For local development, keep the repo `docker-compose.yaml` and build from source:

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
- In bot mode: `Bot message mode: simple` or `Bot message mode: detailed`
- In webhook mode: `Discord delivery mode: webhook`
- `Routing mode: per_channel` or `Routing mode: master (...)`
- `MQTT connected (...)`

Then send a Mesh message and confirm it appears in Discord.

## 8. Update / Restart

Pull the latest published image:

```bash
docker compose pull
```

Restart:

```bash
docker compose up -d
```

If you are running from a local source checkout, pull latest code and rebuild:

```bash
git pull origin main
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
