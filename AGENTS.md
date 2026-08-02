# at-adsb-server

Last verified: 2026-05-27

## Tech Stack
- Lexicons: AT Protocol Lexicon schema (`lexicons/at/adsb/`)
- CLI/Daemon: TypeScript (ESM), Node.js
- AT Protocol client: `@atproto/api`
- Cryptography: `@atproto/crypto` (secp256k1 keypairs for stream signing)
- Event stream: `@atproto/xrpc-server`, `@ipld/dag-cbor`, `express`
- Testing: Vitest
- Build: `tsc`

## Project Structure
- `lexicons/` - AT Protocol lexicon schemas (the protocol spec)
- `server/` - CLI and daemon for publishing receiver data to ATP
- `k3s-manifests/` - Kubernetes deployment manifest for the daemon
- `docs/` - Hosting guide, specification, and verification docs
- `tests/` - Shell wizard test
- `setup-station.sh` - Interactive setup wizard
- `docker-compose.yml` - Docker Compose for daemon + readsb adapter (michelada adapter service commented out)

## Commands (from `server/`)
- `npm run build` - Compile TypeScript
- `npm run dev` - Run CLI via tsx
- `npm run test` - Run tests (vitest)
- `npm run lint` - Type-check without emit

## Conventions
- Functional Core / Imperative Shell pattern (annotated with `// pattern:` comments)
- Numeric values with fractional precision stored as strings (atproto CBOR has no floats)
- Coordinates follow `community.lexicon.location` conventions (decimal degrees, WGS-84)
- ICAO hex codes are uppercased on ingestion
- Records use `$type` set to collection name (e.g. `at.adsb.receiver.sighting`)

## Key Lexicon Collections
- `at.adsb.receiver.station` - Receiver identity (one per account, rkey `self`); optional `streamSigningKey` (did:key secp256k1)
- `at.adsb.receiver.sighting` - Batch sighting (time-windowed, contains manifest + telemetry blob + `sources` array + optional rawCapture blob)
- `at.adsb.receiver.stats` - Periodic performance summary
- `at.adsb.aircraft.identity` - Aircraft identity record (keyed by ICAO hex, one per aircraft per account)
- `at.adsb.flight.record` - Per-aircraft flight record (created on departure, references batch sightings via strongRef chain)
- `at.adsb.flight.defs` - Shared types: `position` (requires `source` field), `contributor`, `trackSummary`
- `at.adsb.datalink.message` - Captured ACARS/VDL2/HFDL messages
- `at.adsb.ephemeral.eventStream` - Realtime WebSocket subscription (no repo writes)
- `at.adsb.broadcast.subscribeEvents` - Event stream frames carry optional `sig` (DAG-CBOR signature); `#info` frames support `KeyRotated` for signalling key rotation

## Boundaries
- Lexicon files in `lexicons/` define the protocol -- treat as the source of truth
- `server/` implements a single receiver's side of the protocol
- `server/src/stream.ts` imports the eventStream lexicon JSON directly (exception to the no-lexicon-import boundary)
- Provenance chain: sighting batches → flight records via strongRef; flight records → aircraft identity via strongRef; raw SDR captures optionally attached to sightings for cryptographic provenance
- Stream signing: station generates secp256k1 keypair via CLI (`generate-stream-key`), publishes did:key to station record, daemon signs event frames with DAG-CBOR encoding (env: `STREAM_SIGNING_KEY_HEX`); key rotation detected on startup and emits `KeyRotated` info frame before updating station record

## Architecture (FCIS)
- **Functional Core**:
  - `records.ts` (record builders and validation)
  - `batch.ts` (batch window accumulation and record building with source attribution)
  - `blobs.ts` (compression)
  - `atrx.ts` (ATRX envelope build/parse, frame counting, concatenation)
  - `stream-payload.ts` (event stream frame builder)
  - `normalized.ts` (NormalizedAircraft types, adapter message schema validation)
- **Imperative Shell**:
  - `daemon.ts` (adapter server loop, batch flush, identity resolution, raw capture, shutdown)
  - `adapter-server.ts` (Unix domain socket server, message routing)
  - `tracker.ts` (aircraft state machine with mutable tracking, multi-adapter aggregation)
  - `identity-cache.ts` (SQLite-backed aircraft identity cache)
  - `client.ts` (ATP API calls)
  - `cli.ts` (CLI entry, station record fetch, adapter spawning)
  - `queue.ts` (SQLite persistence)
  - `stream.ts` (WebSocket event stream broadcaster)
- **Adapter Processes** (CLI subcommands, separate executables, Imperative Shell):
  - `adapters/readsb.ts` (connects to readsb HTTP API, emits normalized messages)
  - `readsb.ts` (readsb HTTP client, data fetching)
  - `beast-client.ts` (BEAST TCP raw frame ingestion with reconnect; only used by readsb adapter)
  - `adapters/michelada.ts` (polls a michelada station's `/extras/adsb` API, emits normalized messages)
  - `adapters/michelada-mapping.ts` (Functional Core: snapshot diffing that derives fix freshness and message counts)
  - `michelada.ts` (michelada HTTP client: aircraft table plus ADS-B mode start/stop)

## Key Decisions
- **Adapter architecture**: Unix domain socket protocol with adapter-per-decoder (`adapter readsb`, `adapter michelada`, future `adapter dump978`). Each adapter connects independently, sending normalized aircraft messages. Daemon aggregates from multiple adapters.
- **Adapters may report fix freshness explicitly**: `NormalizedAircraft.newPosition` lets an adapter that diffs snapshots (michelada) state that a fix is new; adapters that report a true fix age (readsb) omit it and the tracker infers freshness from `seenPos` falling.
- **Batch sightings**: positions accumulated in time windows, published as a single record with manifest + blob per window. Reduces write volume dramatically.
- **Provenance chain via strongRef**: flight records reference batch sightings; flight records reference aircraft identity. Enables downstream verification without re-fetching telemetry.
- **ATRX envelope format**: custom binary format for raw SDR frame capture. Designed for cryptographic provenance -- the raw demodulated frames can independently verify decoded telemetry.

## Invariants
- Every batch sighting has `windowStart`, `windowEnd`, `manifest` (non-empty), `telemetry` blob, `createdAt`, and optionally `rawCapture` blob
- Every flight record has `aircraft` (strongRef), `batches` (non-empty array of strongRefs), `firstSeen`, `lastSeen`, `createdAt`
- Flight records are only created for aircraft with positionCount > 0 and at least one batch ref
- Aircraft identity records are idempotent per ICAO hex (upsert via identity cache)
- Station record always uses rkey `self` (one per account)
- Queue entries are never silently dropped -- they retry with backoff or succeed
- ICAO hex codes are always uppercased

## Gotchas
- `alt_baro` can be the string `"ground"` in readsb data -- typed as `number | string | undefined`
- Receiver location extracted from station record at startup, must pass lat/lon validation
- AdapterServer accepts connections but doesn't authenticate -- assumes trusted local network
- Multiple adapters with same sourceId will have telemetry merged; sourceId should be unique per adapter instance
- michelada reports no altitude, squawk, category, NIC/Rc, RSSI or message counter, and no raw frames; the adapter omits what it cannot know, reports readsb's -49.5 dBFS RSSI floor, and synthesizes a lower-bound message count from poll diffs
- michelada shares its radio across modes: no aircraft are decoded unless the station is in ADS-B mode, which the adapter requests (at most every 30s) unless `--no-auto-start`
