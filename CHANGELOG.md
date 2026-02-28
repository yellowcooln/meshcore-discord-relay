# Changelog

## v1.2 - 2026-02-28

### Added

- Discord routing mode toggle:
  - `DISCORD_ROUTE_MODE=per_channel` for channel-hash-based routing
  - `DISCORD_ROUTE_MODE=master` for one master Discord channel
- Master channel setting `DISCORD_MASTER_CHANNEL_ID`.
- Path display toggle and controls:
  - `RELAY_SHOW_PATH`
  - `RELAY_PATH_WAIT_MS`
  - `RELAY_PATH_MAX_OBSERVERS`
- Configurable embed color via `RELAY_EMBED_COLOR` (default `#1e2938`).

### Changed

- Relay message format now uses `**NodeName**: message`.
- Path formatting now uses a second-line bracket format like `[22,97,25,01]`.
- Relay output now sends Discord embeds instead of plain text messages.
- Path generation now prefers decoded packet repeater path bytes, with observer fallback.
- Observer allowlist behavior now holds messages until a whitelisted observer sees them, while still collecting earlier non-whitelisted hops for path output.
- README and `.env.example` expanded/cleaned up for routing modes, message format, embed color, and path controls.

## v1.1 - 2026-02-27

### Added

- Multi-channel Discord fanout per Mesh channel mapping.
- Support for `discord_channel_ids` arrays in `channels.json` (with backward-compatible `discord_channel_id` support).
- Observer allowlist filtering via `MQTT_OBSERVER_ALLOWLIST`.

### Changed

- Observer filtering now matches names from MQTT topic metadata and JSON payload fields (for example `origin`/`observer`).
- Observer matching is case-insensitive and normalization-based (for example `DeputyDawg` matches `DeputyDawg - Observer`).
- Updated `.env.example` and README documentation for observer filtering.
- Expanded README with a full `.env` variable breakdown.
- Updated `channels.example.json` to document multi-channel fanout format.

## v1 - 2026-01-05 (`a0f4e53`)

- Baseline release snapshot.
- Added repository agent guidelines.
