# at-adsb-server

AT Protocol receiver daemon for publishing ADS-B aircraft surveillance data to the atmosphere. Accepts aircraft data from decoder adapters (readsb, michelada, and others), tracks aircraft through coverage, publishes batch sightings with cryptographic provenance, and broadcasts a realtime event stream over WebSocket.

## What This Is

This is the **feeder** side of the `at.adsb.*` protocol — the software that runs on your receiver (or in a Docker container next to it), collects aircraft positions from your SDR decoder, and publishes them as AT Protocol records. An optional realtime WebSocket stream lets aggregators and dashboards consume live data without polling.

Each receiver is a first-class AT Protocol identity with its own DID, making contribution history verifiable and portable.

## Quick Start

### Prerequisites

- An Atmosphere account (e.g., a Bluesky account) and an [app password](https://bsky.app/settings/app-passwords)
- A running [readsb](https://github.com/wiedehopf/readsb) or [michelada](https://github.com/konradit/michelada) instance (or compatible decoder exposing an HTTP aircraft API)
- Docker with Compose

### Setup

1. Clone this repo:

   ```bash
   git clone https://github.com/adsbAT/at-adsb-server.git
   cd at-adsb-server
   ```

2. Run the setup wizard:

   ```bash
   ./setup-station.sh
   ```

   The wizard writes a protected `.env` and registers your station record (`at.adsb.receiver.station/self`). It does not start the stack automatically. Review the public-coordinate warning and use rounded coordinates unless you deliberately accept publishing a precise location.

3. Start the daemon and readsb adapter:

   ```bash
   docker compose up -d
   docker compose logs -f daemon
   ```

   Feeding from a [michelada](https://github.com/konradit/michelada) station instead? Set `MICHELADA_URL` in `.env` to your station's address and start its adapter instead of the readsb one:

   ```bash
   docker compose --profile michelada up -d daemon adapter-michelada
   ```

   See the [hosting guide](docs/HOSTING.md#adapter-michelada) for what that adapter can and cannot report.

### Manual Setup (without the wizard)

```bash
cp .env.example .env
# Edit .env with your credentials — do not print or commit it.
docker compose run --rm --build daemon register \
  --name "Home receiver" \
  --lat 38.8977 --lon -77.0365
```

The station record must exist before the daemon starts. Coordinates are public AT Protocol data; see [Receiver Location & Privacy](#receiver-location--privacy).

### Other Deployment Options

- **Kubernetes**: See [`k3s-manifests/at-adsb.yaml`](k3s-manifests/at-adsb.yaml) for a Deployment + Service manifest.
- **Source**: Clone, `cd server && npm ci && npm run build`, then `node dist/cli.js run`.
- **Advanced configuration** (raw capture, multiple adapters, stream signing): See the [hosting guide](docs/HOSTING.md).

## Lexicons

The `at.adsb.*` lexicon namespace defines the protocol. Full schemas are in [`lexicons/`](lexicons/).

### `at.adsb.receiver.*`

- **`station`**: Declares a receiver station: location, hardware, antenna, supported protocols (ADS-B, MLAT, UAT, ACARS, VDL2, HFDL), and operational status. One per account (`key: literal:self`).
- **`sighting`**: A single receiver's batch sighting of aircraft in a time window. Published immediately when the window closes — feeder-authoritative.
- **`stats`**: Periodic performance summaries: aircraft seen, messages decoded, max range, signal quality.

### `at.adsb.flight.*`

- **`record`**: A completed flight synthesised from one or more receiver sightings. Created by an aggregator (not this daemon). Includes ICAO hex, callsign, aircraft type, contributor attribution, and track summary.
- **`defs`**: Shared types: `contributor`, `position`, `trackSummary`.

### `at.adsb.aircraft.*`

- **`identity`**: Aircraft identity record (keyed by ICAO hex, one per aircraft per account).

### `at.adsb.datalink.*`

- **`message`**: Captured ACARS, VDL2, or HFDL datalink messages.

## Data Flow

```
Aircraft positions collected in batch window
  └─► at.adsb.receiver.sighting (published when window closes)

Aircraft leaves coverage (60s absence)
  └─► at.adsb.flight.record (created by this daemon)
        ├─ aircraft  → at.adsb.aircraft.identity
        └─ batches[] → at.adsb.receiver.sighting (strongRef chain)
```

This daemon publishes feeder truth ("I saw these aircraft in this time window"). Aggregators can independently synthesise flight records from the same sightings.

## Development

```bash
cd server
npm ci
npm run build      # compile TypeScript
npm run test       # run test suite (vitest)
npm run lint       # type-check without emit
```

The shell wizard checks can be tested alongside the server suite:

```bash
bash tests/setup-station.test.sh && (cd server && npm test)
```

## Design Notes

- Coordinates use [`community.lexicon.location`](https://github.com/lexicon-community/lexicon/tree/main/community/lexicon/location) conventions (decimal degree strings, WGS-84).
- Numeric values that may have fractional precision (speeds, distances, signal levels) are stored as strings per the atproto data model (no floats in CBOR).
- Batch sightings contain a zstd-compressed telemetry blob with source attribution (`adsb_icao`, `mlat`, `uat`, etc.).
- Raw SDR frames can optionally be captured per batch window in ATRX envelope format for cryptographic provenance — the raw demodulated frames can independently verify decoded telemetry.
- Stream signing: stations can generate a secp256k1 keypair (`generate-stream-key` command) and sign event frames with DAG-CBOR encoding.
- The namespace is protocol-level, not product-specific. Anyone can build on `at.adsb.*`.

## Receiver Location & Privacy

Station records include a required location field. Coordinates are public AT Protocol data: anyone who can read the station record can see them. Round coordinates to roughly 2 decimal places (~1 km precision) unless you deliberately accept publishing a precise home or receiver location.

MLAT (multilateration) can require precise receiver positions to compute aircraft locations from timing differences. If you knowingly accept that disclosure, the registration CLI can publish precise coordinates; the setup wizard asks for explicit confirmation before collecting them.

## License

MIT
