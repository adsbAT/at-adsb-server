# server - AT-ADS-B CLI & Daemon

Last verified: 2026-05-27

## Purpose
Accepts connections from input adapters via Unix domain socket, tracks aircraft through
coverage, publishes batch sightings and flight records to the AT Protocol
network with a cryptographic provenance chain (strongRef links) and source attribution,
and broadcasts a realtime ephemeral event stream over WebSocket.

## Contracts
- **Exposes**: 
  - CLI with `register` (station setup), `run` (daemon), `adapter readsb` and `adapter michelada` (adapter processes) commands
  - XRPC WebSocket subscription at `at.adsb.ephemeral.eventStream`
- **Guarantees**:
  - Station record exists before daemon starts (fetched on `run` command startup)
  - Receiver location extracted from station record location field (lat/lon validation at runtime)
  - Batch sightings published every `batchWindowS` seconds (configurable 15-600s, default 300s) containing all positions collected in that window as a zstd-compressed telemetry blob with deduplicated `sources` array (source attribution)
  - Oversized windows are split into multiple sighting records with disjoint manifests so every telemetry blob stays under the 2MB lexicon limit and every manifest under 1000 entries (`chunkTelemetry` in `blobs.ts`); raw capture attaches to the first chunk only
  - Empty batch windows produce no record
  - Flight records created on aircraft departure, referencing all contributing batch sightings via strongRef chain
  - Aircraft identity records resolved or created before flight record publication; cached in SQLite
  - Zero-position aircraft are skipped (no flight record created)
  - Failed publishes are enqueued to SQLite with exponential backoff retry
  - Stats and partial batches flushed on shutdown so no data is silently lost
  - Telemetry blobs are zstd-compressed before upload; positions in telemetry carry `source` field (e.g., `adsb_icao`, `mlat`, `uat`)
  - When adapters provide raw SDR frames, they are captured per batch window, wrapped in ATRX envelope format, concatenated, and uploaded as the optional `rawCapture` blob on the sighting record
  - ATRX blobs are self-describing: 8-byte header (magic + version + flags + reserved), length-prefixed CBOR metadata (receiverDid, window timestamps, clockSource, protocol, frameCount), length-prefixed zstd-compressed frame payload (payload length added in v2 so concatenated blobs split without scanning payload bytes)
  - ATRX frameCount is verified on parse (round-trip integrity check)
  - ICAO hex codes are always uppercased
  - Event stream frames are DAG-CBOR encoded per AT Protocol subscription wire format
  - Event stream sequence numbers are monotonically increasing (per process lifetime, not persisted)
  - Event stream is ephemeral -- no repo writes, no backfill support
- **Expects**:
  - Unix domain socket path for adapter connections (default `/tmp/at-adsb.sock`)
  - At least one adapter process connecting and streaming data via the socket
  - Valid ATP credentials (handle + app password)
  - Station record already registered on the ATP account

## Dependencies
- **Uses**: `@atproto/api` (ATP client), `@atproto/xrpc-server` (WebSocket stream), `@ipld/dag-cbor` (CBOR encoding for stream frames and ATRX metadata), `express` (HTTP for XRPC), `better-sqlite3` (queue persistence), `commander` (CLI), `dotenv`, `node:net` (Unix domain socket server)
- **Used by**: Nothing yet (standalone CLI tool)
- **Boundary**: Record shapes are built in `records.ts` to match lexicon schemas; `stream.ts` is the exception -- it imports the eventStream lexicon JSON directly (required by xrpc-server for method registration); `readsb.ts` and `beast-client.ts` are now only imported by the `adapters/readsb.ts` adapter process, not the daemon

## Key Decisions
- **Adapter architecture**: Unix domain socket protocol with adapter-per-decoder (`adapter readsb`, `adapter michelada`, future `adapter dump978`). Each adapter connects independently, sending normalized aircraft messages. Daemon aggregates from multiple adapters.
- **Explicit fix freshness**: `NormalizedAircraft.newPosition` lets an adapter that diffs snapshots state outright that a fix is new. michelada sets it; readsb omits it and the tracker keeps inferring freshness from a falling `seenPos`. Without it, back-to-back michelada fixes (both aged ~0s) would be indistinguishable from a repeated one and get dropped.
- **Synthesized michelada fields**: michelada exposes only ICAO, callsign, lat/lon, heading, speed and seconds-since-last-message. The adapter derives fix age from when a reported position changed, counts polls with activity as a lower-bound message count, labels positions `adsb_icao`, and reports readsb's -49.5 dBFS floor for the RSSI it cannot measure. Altitude, squawk, category, vertical rate, QNH and NIC/Rc are omitted rather than faked.
- **michelada owns one radio across modes**: the adapter asks the station to enter ADS-B mode when it finds it in another mode (at most every 30s, since calibration and the detector refuse the switch), and never switches it back on shutdown.
- **Normalized message types**: `AircraftMessage`, `StatsMessage`, `RawCaptureMessage` (adapter-agnostic schema). Adapters convert decoder-specific formats to normalized types. No decoder-specific logic in daemon.
- **Source attribution**: Telemetry blob positions carry `source` field (e.g., `adsb_icao`, `mlat`, `uat`). Sighting record `sources` array is deduplicated set of sources present in positions.
- **ATRX concatenation for multi-source raw capture**: When multiple adapters provide raw frames, each ATRX blob is written to temp file, concatenated via `concatAtrxBlobs()`, and uploaded as single `rawCapture` blob. Parser reads sequentially until EOF.
- **Batch sightings replace per-aircraft sightings**: positions accumulated in time windows, published as a single record with manifest + blob per window. Reduces write volume dramatically.
- **Provenance chain via strongRef**: flight records reference batch sightings; flight records reference aircraft identity. Enables downstream verification without re-fetching telemetry.
- **Aircraft identity records**: one per ICAO hex per account, cached in SQLite `identity_cache` table. Category updates via `putRecord`.
- **Batch index**: in-memory map tracking which batch strongRefs contain each aircraft. Cleaned up on departure.
- **ATRX envelope format**: custom binary format for raw SDR frame capture. Header (magic "ATRX", version, flags, reserved) + CBOR metadata + zstd-compressed frame payload. Designed for cryptographic provenance -- the raw demodulated frames can independently verify decoded telemetry.
- **Raw capture is optional**: Adapters may or may not provide raw frames. Sighting records are valid without `rawCapture`. No degradation when raw capture is unavailable.
- Event stream uses XRPC subscription protocol (WebSocket + DAG-CBOR frames) for compatibility with AT Protocol ecosystem tooling
- Stream sequence is in-memory only; cursor/backfill is reserved but not implemented
- `wsPort` config field controls event stream listen port (separate from any future HTTP API)
- `batchWindowS` config field controls batch flush interval (default 300s, chosen to fit the 1000/day blob upload budget; oversized windows are chunked rather than dropped)
- `socketPath` config field controls Unix domain socket for adapter connections (default `/tmp/at-adsb.sock`)
- `atrxTempDir` config field specifies temp directory for raw capture files during concatenation
- Departure detection requires 60s absence from all adapters, not immediate
- Queue uses SQLite WAL mode for safe concurrent access
- Telemetry stored as zstd-compressed JSON blob keyed by ICAO hex, values are position arrays with `source` field
- Position counting gates on `seen_pos` freshness to avoid double-counting stale fixes
- Stats accumulator aggregates stats from all connected adapters before flush

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
  - `adapters/michelada.ts` (polls a michelada station's `/extras/adsb` API, emits normalized messages; requests ADS-B mode when the station's radio is elsewhere)
  - `adapters/michelada-mapping.ts` (Functional Core: diffs consecutive snapshots to derive fix freshness, message counts and per-poll stats)
  - `michelada.ts` (michelada HTTP client: aircraft table plus ADS-B mode start/stop)

## Invariants
- Every batch sighting has `windowStart`, `windowEnd`, `manifest` (non-empty), `telemetry` blob, `createdAt`, and optionally `rawCapture` blob
- ATRX blobs always have magic "ATRX", version 0x02 (writer; parser also accepts legacy 0x01), reserved bytes 0x00; frameCount in metadata must match actual frame count in payload
- Every flight record has `aircraft` (strongRef), `batches` (non-empty array of strongRefs), `firstSeen`, `lastSeen`, `createdAt`
- Flight records are only created for aircraft with positionCount > 0 and at least one batch ref
- Aircraft identity records are idempotent per ICAO hex (upsert via identity cache)
- Station record always uses rkey `self` (one per account)
- Queue entries are never silently dropped -- they retry with backoff or succeed
- `maxRangeNm` is computed via haversine from receiver position
- Batch index entries are cleaned up on departure regardless of whether a flight record is created

## Gotchas
- `alt_baro` can be the string `"ground"` in readsb data -- typed as `number | string | undefined`
- Receiver location extracted from station record at startup, must pass lat/lon validation
- Queue `markFailed` silently returns if the row was deleted (race condition guard)
- BeastClient accumulates raw bytes between flushes -- flush resets the buffer, so missed flushes lose frames (by design, not a bug)
- AdapterServer accepts connections but doesn't authenticate -- assumes trusted local network (same machine or private LAN)
- Multiple adapters with same sourceId will have telemetry merged; sourceId should be unique per adapter instance. The michelada adapter reads `MICHELADA_SOURCE_ID`, not `SOURCE_ID`, so a shared `.env` cannot collide it with the readsb adapter
- michelada sightings never carry a `rawCapture` blob -- the station has no BEAST output
- ATRX temp files are written to `atrxTempDir` and cleaned up after upload; ensure directory is writable and has sufficient space
