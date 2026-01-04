# MeshCore Discord Relay

Relays MeshCore GroupText chat messages from MQTT into Discord channels. It mirrors the MQTT config used by `mesh-live-map` and uses `@michaelhart/meshcore-decoder` to decrypt GroupText messages with channel secrets.

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

- `DISCORD_TOKEN` (required): Bot token.
- `DISCORD_DEFAULT_CHANNEL_ID`: Fallback Discord channel when a MeshCore channel hash is not mapped.
- `CHANNELS_FILE`: JSON mapping of MeshCore channel secrets to Discord channel IDs (default: `channels.json`).

### channels.json

Each entry provides a MeshCore channel secret (hex) and the Discord channel ID to post into. The relay derives the channel hash from the secret, decrypts the GroupText payload, and routes based on that hash.

```json
{
  "default_channel_id": "123456789012345678",
  "channels": [
    {
      "name": "public",
      "secret": "8b3387e9c5cdea6ac9e5edbaa115cd72",
      "discord_channel_id": "123456789012345678"
    }
  ]
}
```

## Notes

- Only GroupText payloads are relayed (MeshCore text chat). If a matching channel secret is not provided, messages are skipped.
- Dedupe is handled by message hash for 45 seconds by default (`RELAY_DEDUPE_SECONDS`).
