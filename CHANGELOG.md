# Changelog

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
