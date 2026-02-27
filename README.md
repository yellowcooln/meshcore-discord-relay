# MeshCore Discord Relay

Relays MeshCore GroupText chat messages from MQTT into Discord channels. It uses `@michaelhart/meshcore-decoder` to decrypt GroupText messages with channel secrets.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Docker

1) Copy configs:

```bash
cp .env.example .env
cp channels.example.json channels.json
```
2) Edit `.env` and `channels.json` to fit your needs.

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

- `DISCORD_TOKEN` (required): Discord bot token.
- `DISCORD_DEFAULT_CHANNEL_ID`: Fallback Discord channel if a Mesh channel hash is not mapped in `channels.json`.
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
- `CHANNELS_FILE`: Channel routing file path (default `channels.json`).
- `RELAY_DEDUPE_SECONDS`: Dedupe window in seconds for message hash replay protection.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `MQTT_OBSERVER_ALLOWLIST`: Optional comma-separated observer names; if set, only packets seen by these observers are relayed.

### channels.json

Each entry provides a MeshCore channel secret (hex) and one or more Discord channel IDs to post into. The relay derives the channel hash from the secret, decrypts the GroupText payload, and routes based on that hash.

```json
{
  "default_channel_id": "123456789012345678",
  "channels": [
    {
      "name": "public",
      "secret": "8b3387e9c5cdea6ac9e5edbaa115cd72",
      "discord_channel_ids": [
        "123456789012345678",
        "345678901234567890"
      ]
    }
  ]
}
```

`discord_channel_id` is still supported for single-channel mappings. You can also repeat the same `secret`/`hash` in multiple entries and the relay will merge their Discord channel IDs.

## Notes

- Only GroupText payloads are relayed (MeshCore text chat). If a matching channel secret is not provided, messages are skipped.
- Dedupe is handled by message hash for 45 seconds by default (`RELAY_DEDUPE_SECONDS`).
- Observer filtering reads names from MQTT topic metadata and JSON payload fields like `origin`/`observer`.
- Observer allowlist matching is case-insensitive and normalization-based. Example: `MQTT_OBSERVER_ALLOWLIST=DeputyDawg,YC-Observer` will match `DeputyDawg - Observer`.
- If Discord posting fails, logs show `Missing Permissions` with the channel ID. Grant `View Channel`, `Send Messages`, and `Read Message History` to the bot.
