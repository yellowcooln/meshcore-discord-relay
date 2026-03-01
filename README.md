# MeshCore Discord Relay

Relays MeshCore GroupText chat messages from MQTT into Discord channels. It uses `@michaelhart/meshcore-decoder` to decrypt GroupText messages with channel secrets.

Current release: `v1.3.0` (`package.json` version `0.1.1`).

See [CHANGELOG.md](./CHANGELOG.md) for release history.
See [howto.md](./howto.md) for end-to-end Linux deployment steps.

## Docker

1) Copy configs:

```bash
cp .env.example .env
cp channels.yaml.example channels.yaml
cp webhooks.yaml.example webhooks.yaml
```
2) Edit `.env`, `channels.yaml`, and `webhooks.yaml` to fit your needs.

3) Build and run:

```bash
docker compose up -d --build
```

4) Check logs:

```bash
docker compose logs -f meshcore-discord-relay
```

## Configuration

### .env Breakdown

- `DISCORD_DELIVERY_MODE`: Relay output mode. Use `bot` or `webhook`.
- `DISCORD_TOKEN`: Discord bot token (required only when `DISCORD_DELIVERY_MODE=bot`).
- `DISCORD_ROUTE_MODE`: Discord routing mode. Use `per_channel` (default) to route by Mesh channel mapping, or `master` to send all relayed messages to one channel.
- `DISCORD_MASTER_CHANNEL_ID`: Master Discord channel used when `DISCORD_ROUTE_MODE=master` (falls back to `DISCORD_DEFAULT_CHANNEL_ID` if unset).
- `DISCORD_DEFAULT_CHANNEL_ID`: Fallback Discord channel if a Mesh channel hash is not mapped in `CHANNELS_FILE` (also fallback for master mode).
- `MQTT_HOST`: MQTT broker host.
- `MQTT_PORT`: MQTT broker port.
- `MQTT_USERNAME`: MQTT username (optional).
- `MQTT_PASSWORD`: MQTT password (optional).
- `MQTT_TOPIC`: MQTT topic subscription (for example `meshcore/#` or `meshcore/BOS/#`).
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
- `RELAY_SHOW_PATH`: Set `true` to append a path line to relayed Discord messages.
- `RELAY_EMBED_COLOR`: Discord embed color in hex format (`#RRGGBB`), default `#1e2938` (quote the value in `.env`, for example `"#1e2938"`).
- `RELAY_PATH_WAIT_MS`: Milliseconds to wait before sending when path display is enabled (collects additional hops for the same message).
- `RELAY_PATH_EDIT_UPDATES`: If `true`, bot mode can edit sent Discord messages when additional hops are heard.
- `RELAY_PATH_EDIT_WINDOW_MS`: Max window (ms) after initial send where path edits are allowed.
- `RELAY_PATH_EDIT_MIN_INTERVAL_MS`: Minimum delay (ms) between edit API calls for the same message.
- `RELAY_PATH_MAX_OBSERVERS`: Max hops shown in the path line.

### Routing Modes

`DISCORD_ROUTE_MODE=per_channel` (default)
- `bot` delivery routes by Mesh channel hash using `CHANNELS_FILE`.
- `webhook` delivery routes by Mesh channel hash using `WEBHOOKS_FILE`.
- Uses fallback target only when a hash is not mapped:
- bot fallback: `DISCORD_DEFAULT_CHANNEL_ID`
- webhook fallback: `default_webhook_url` in `WEBHOOKS_FILE`

`DISCORD_ROUTE_MODE=master`
- `bot` delivery sends all relayed messages to one channel (`DISCORD_MASTER_CHANNEL_ID`, fallback `DISCORD_DEFAULT_CHANNEL_ID`).
- `webhook` delivery sends all relayed messages to `default_webhook_url` from `WEBHOOKS_FILE`.
- `CHANNELS_FILE` is still used for Mesh channel key/decryption lookup.

### Message Format

- `bot` delivery format: `**NodeName**: message`
- `webhook` delivery format: webhook `username` is sender name; embed description is the message body
- If `RELAY_SHOW_PATH=true`, a second line is appended: ``[`22`,`97`,`25`,`01`]``

### Channels File (`CHANNELS_FILE`)

Each entry provides a MeshCore channel secret (hex) and one or more Discord channel IDs to post into. The relay derives the channel hash from the secret, decrypts the GroupText payload, and routes based on that hash.

```yaml
default_channel_id: "123456789012345678"
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    discord_channel_ids:
      - "123456789012345678"
      - "345678901234567890"
```

`discord_channel_id` is still supported for single-channel mappings. You can also repeat the same `secret`/`hash` in multiple entries and the relay will merge their Discord channel IDs.
YAML and JSON use the same field names.

### Webhooks File (`WEBHOOKS_FILE`)

Use this file for webhook routing in webhook delivery mode.

```yaml
default_webhook_url: ""
channels:
  - name: "public"
    secret: "8b3387e9c5cdea6ac9e5edbaa115cd72"
    webhook_url: "https://discord.com/api/webhooks/123456789012345678/replace-with-token"
```

Both YAML and JSON are supported for webhook files.

## Notes

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
- Webhook mode uses pre-send wait (`RELAY_PATH_WAIT_MS`) for hop/path completeness and does not do post-send edit updates.
- If bot posting fails, logs can show `Missing Permissions` with the channel ID. Grant `View Channel`, `Send Messages`, and `Read Message History` to the bot.
- In webhook mode, messages use per-sender robot avatars from RoboHash (`set1`) derived from sender name.
