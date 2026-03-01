# Changelog

## v1.3.0 - webhook upgrade

### Added

- Configurable Discord delivery mode via `DISCORD_DELIVERY_MODE` with `bot` and `webhook` options.
- Per-channel webhook routing via `WEBHOOKS_FILE` with `name`, `secret`, or `hash` channel matching.
- Webhook sender identity support using per-message webhook `username` from Mesh sender name.
- Deterministic webhook robot avatars using RoboHash (`set1`) via webhook `avatar_url`.
- YAML config support for channel and webhook files (`.yaml` / `.yml`) while keeping JSON support.
- Added webhook example files: `webhooks.json.example` and `webhooks.yaml.example`.
- Added channel example files: `channels.json.example` and `channels.yaml.example`.
- Added local YAML runtime files: `channels.yaml` and `webhooks.yaml`.

### Changed

- Webhook mode no longer requires Discord bot login; populated `DISCORD_TOKEN` is ignored in webhook delivery mode.
- Webhook mode now uses pre-send hop collection (`RELAY_PATH_WAIT_MS`) and disables post-send edit updates.
- Webhook channel secrets now contribute to decryption key loading, enabling webhook-only deployments.
- `src/config.js` now parses channel/webhook config as JSON or YAML based on file extension.
- Default config paths now point to YAML (`CHANNELS_FILE=channels.yaml`, `WEBHOOKS_FILE=webhooks.yaml`).
- Docker Compose now mounts YAML config files by default.
- Docker image now includes YAML example files for first-run setup.
- README, how-to docs, env examples, and changelog were updated for webhook mode and YAML-first config.

## v1.2.1 - 2026-03-01

### Added

- Optional post-send path edits (throttled and time-bounded) so relay messages can update when later repeats are heard.
- New relay settings:
  - `RELAY_PATH_EDIT_UPDATES`
  - `RELAY_PATH_EDIT_WINDOW_MS`
  - `RELAY_PATH_EDIT_MIN_INTERVAL_MS`

### Changed

- Updated README and `.env.example` with the new path edit behavior and configuration details.
- Bumped app version to `0.1.1`.

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
- Updated `channels.json.example` to document multi-channel fanout format.

## v1 - 2026-01-05 (`a0f4e53`)

- Baseline release snapshot.
- Added repository agent guidelines.
