# MeshCore Discord Relay Deployment Guide

[Project overview and quick start](./README.md) · [Configuration template](./.env.example) · [Changelog](./CHANGELOG.md)

For a published-image install without cloning, use the README quick start. The steps below use a checkout to provide all examples locally.

This guide walks through deploying `meshcore-discord-relay` on Linux from scratch.

## 1. Prerequisites

- A Linux host with internet access
- Docker Engine + Docker Compose plugin installed
- A Discord bot token (for bot delivery mode) or Discord webhook URLs (for webhook delivery mode)
- MQTT broker host/port/credentials
- Mesh channel secrets (for decrypting GroupText)

## 2. Get the examples

The published Docker image is:

```text
yellowcooln/meshcore-discord-relay:latest
```

Clone the repo if you want the included examples and compose file.

```bash
git clone https://github.com/yellowcooln/meshcore-discord-relay.git
cd meshcore-discord-relay
```

## 3. Create config files

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
- `MQTT_TOPIC` (for example `meshcore/BOS/#`, or comma-separated `meshcore/BOS/#,meshcore/PVD/#` for multiple regions)
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
put metadata after a blank line, with inline-code scope and optional path on one
line (no `Scope:` prefix):

```text
message body

`#northbridge` · [`97`]
```

Scope alone shows only the inline-code scope; path alone shows only the existing
path format, both after a blank line. Neither leaves the message unchanged.
Backticks inside scope names display as `ˋ` to prevent breaking out of inline
code; matching uses the original names. Detailed bot embeds keep a separate
**Scope** field. Scope display is independent of path display and survives
delayed sends and bot path-update edits. Unscoped messages have no scope label,
and scope display is off by default.

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

## 5. Choose delivery mode

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
- Channel secrets can be supplied in `webhooks.yaml`. `channels.yaml` can also supply shared decryption keys; keep both files present for the supplied Compose mounts.

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
- In `master` mode, channel secrets still need to be configured. Bot mode reads `channels.yaml`; webhook mode can also read secrets from `webhooks.yaml`.
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

## 8. Updates and configuration changes

Back up `.env`, your Compose file, and your channel/webhook configuration before updates. Do not replace working configuration with the example files.

For published-image installations:

```bash
docker compose pull meshcore-discord-relay
docker compose up -d --no-build meshcore-discord-relay
```

After `.env` edits, recreate the service with the intended image already pulled:

```bash
docker compose up -d --no-build --pull never --force-recreate meshcore-discord-relay
```

A plain `docker compose restart` does not reload environment-file values. Recreating also reloads channel/webhook mappings, including files replaced atomically by an editor.

For source-build installations, update to your intended revision while preserving local configuration, then build and recreate:

```bash
git pull --ff-only origin main
docker compose build meshcore-discord-relay
docker compose up -d --no-build --pull never --force-recreate meshcore-discord-relay
```

Check the logs and delivery mode after the update. Rebuilding or pulling an image alone does not replace the running container.

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

## Configuration reference


- `DISCORD_DELIVERY_MODE`: Relay output mode. Use `bot` or `webhook`.
- `DISCORD_TOKEN`: Discord bot token (required only when `DISCORD_DELIVERY_MODE=bot`).
- `DISCORD_ROUTE_MODE`: Discord routing mode. Use `per_channel` (default) to route by Mesh channel mapping, or `master` to send all relayed messages to one channel.
- `DISCORD_MASTER_CHANNEL_ID`: Master Discord channel used when `DISCORD_ROUTE_MODE=master` (falls back to `DISCORD_DEFAULT_CHANNEL_ID` if unset).
- `DISCORD_DEFAULT_CHANNEL_ID`: Fallback Discord channel if a Mesh channel hash is not mapped in `CHANNELS_FILE` (also fallback for master mode).
- `MQTT_HOST`: MQTT broker host (for same-host Linux Mosquitto from Docker, use `host.docker.internal`).
- `MQTT_PORT`: MQTT broker port.
- `MQTT_USERNAME`: MQTT username (optional).
- `MQTT_PASSWORD`: MQTT password (optional).
- `MQTT_TOPIC`: MQTT topic subscription (for example `meshcore/#` or `meshcore/BOS/#`). Accepts a comma-separated list to subscribe to several filters, e.g. `meshcore/BOS/#,meshcore/PVD/#`; invalid filters are skipped with a warning and an empty value falls back to `meshcore/#`.
- `MQTT_TLS`: Set `true` for TLS (`mqtts`/`wss`), else `false`.
- `MQTT_TLS_INSECURE`: Set `true` to skip TLS cert verification (not recommended outside testing).
- `MQTT_CA_CERT`: Optional CA certificate path for TLS validation.
- `MQTT_TRANSPORT`: `tcp` or `websockets`.
- `MQTT_WS_PATH`: WebSocket path when using `websockets` transport (usually `/mqtt`).
- `MQTT_CLIENT_ID`: Optional MQTT client ID.
- `MQTT_QOS`: MQTT QoS level (`0`, `1`, or `2`; default `0`).
- `CHANNELS_FILE`: Channel routing file path (supports `.json`, `.yaml`, `.yml`; default `channels.yaml`).
- `WEBHOOKS_FILE`: Webhook routing file path (supports `.json`, `.yaml`, `.yml`; default `webhooks.yaml`).
- `RELAY_DEDUPE_SECONDS`: Dedupe window in seconds for message hash replay protection.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `MQTT_OBSERVER_ALLOWLIST`: Optional comma-separated observer names; if set, only packets seen by these observers are relayed.
- `RELAY_SHOW_SCOPE`: Set `true` to show a scope label for scoped messages in bot and webhook output (default `false`). Unscoped messages have no scope label.
- `RELAY_SCOPE_NAMES`: Optional comma-separated, case-sensitive public scope names to recognize, for example `"#Local,#Regional"`. Quote the value because `#` otherwise starts an `.env` comment. Unknown scopes show their packet-specific transport code instead.
- `RELAY_SHOW_PATH`: Set `true` to append a path line to relayed Discord messages.
- `RELAY_BOT_MESSAGE_MODE`: Bot output style: `simple` (compact sender/message embed) or `detailed` (sender title + relay detail fields).
- `RELAY_EMBED_COLOR`: Discord embed color in hex format (`#RRGGBB`), default `#1e2938` (quote the value in `.env`, for example `"#1e2938"`).
- `RELAY_PATH_WAIT_MS`: Milliseconds to wait before sending when path display is enabled (collects additional hops for the same message).
- `RELAY_PATH_EDIT_UPDATES`: If `true`, bot mode can edit sent Discord messages when additional hops are heard.
- `RELAY_PATH_EDIT_WINDOW_MS`: Max window (ms) after initial send where path edits are allowed.
- `RELAY_PATH_EDIT_MIN_INTERVAL_MS`: Minimum delay (ms) between edit API calls for the same message.
- `RELAY_PATH_MAX_OBSERVERS`: Max hops shown in the path line.

- `MQTT_TOPIC_WHITELIST`: Optional comma-separated topic-pattern filter in addition to the broker subscription.

### Channel file formats

`discord_channel_id` is still supported for single-channel mappings. You can also repeat the same `secret`/`hash` in multiple entries and the relay will merge their Discord channel IDs.
YAML and JSON use the same field names. YAML uses the YAML 1.2 core schema with
anchor/alias and merge-key (`<<`) support. Quote channel IDs and hex values to
keep them as strings. Empty files use defaults; multi-document YAML is rejected.
YAML 1.1-specific tags such as `!!timestamp` are not supported.


### Delivery and observer behavior


- Only GroupText payloads are relayed (MeshCore text chat). If a matching channel secret is not provided, messages are skipped.
- Delivery supports `bot` and `webhook` modes.
- Routing supports either per-channel mapping (`DISCORD_ROUTE_MODE=per_channel`) or a single master target (`DISCORD_ROUTE_MODE=master`).
- Dedupe is handled by message hash for 45 seconds by default (`RELAY_DEDUPE_SECONDS`).
- Observer filtering reads names from MQTT topic metadata and JSON payload fields like `origin`/`observer`.
- Observer allowlist matching is case-insensitive and normalization-based. Example: `MQTT_OBSERVER_ALLOWLIST=DeputyDawg,YC-Observer` will match `DeputyDawg - Observer`.
- With an observer allowlist enabled, messages are held until at least one whitelisted observer sees that message.
- Path collection still includes non-whitelisted observers for the same message, so full hop history can be shown.
- When `RELAY_SHOW_PATH=true`, relayed messages include a bracketed path line with each hop shown as inline code (for example ``[`22`,`97`,`25`,`01`]``). Repeater path bytes are preferred, with observer-derived fallback if packet path is unavailable.
- `RELAY_PATH_WAIT_MS` trades latency for better path completeness. Larger values capture more observer hops before posting.
- With `RELAY_PATH_EDIT_UPDATES=true`, bot-mode messages can be edited after posting when new repeats are heard, throttled by `RELAY_PATH_EDIT_MIN_INTERVAL_MS` and bounded by `RELAY_PATH_EDIT_WINDOW_MS`.
- Detailed bot mode (`RELAY_BOT_MESSAGE_MODE=detailed`) keeps the same relay behavior but changes embed layout to sender title + message body + receiver/metrics/path detail fields.
- Webhook mode uses pre-send wait (`RELAY_PATH_WAIT_MS`) for hop/path completeness and does not do post-send edit updates.
- If bot posting fails, logs can show `Missing Permissions` with the channel ID. Grant `View Channel`, `Send Messages`, and `Read Message History` to the bot.
- In webhook mode, messages use per-sender robot avatars from RoboHash (`set1`) derived from sender name.

### Dependency updates

Dependabot checks npm, Docker, and GitHub Actions weekly with version-update PRs targeting `dev`. Security alerts are associated with the default branch. See the repository workflow and Dependabot files for the current policy.
