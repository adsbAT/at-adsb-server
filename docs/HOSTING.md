# Hosting at-adsb

at-adsb runs as two processes: a **daemon** that publishes to the AT Protocol network, and one or more **adapters** that feed aircraft data into it. They communicate over a Unix domain socket.

This guide covers Docker Compose and Kubernetes (k3s) deployments. Both assume you already have a decoder like [readsb](https://github.com/wiedehopf/readsb) or a [michelada](https://github.com/konradit/michelada) station running somewhere accessible over HTTP.

## Prerequisites

- An AT Protocol account (e.g., on [bsky.social](https://bsky.social))
- An [app password](https://bsky.app/settings/app-passwords) for that account
- A running readsb or michelada instance (or any decoder with an HTTP JSON API)
- Docker and Docker Compose, or a Kubernetes cluster

## Architecture

```
┌──────────────┐     Unix socket     ┌──────────┐     AT Protocol
│ adapter      │ ──────────────────> │ daemon   │ ──────────────> PDS
│ (readsb)     │   NDJSON messages   │          │   sightings,
│              │ <─ ─ ─ ─ ─ ─ ─ ─ ─ │          │   flight records,
└──────────────┘                     │          │   stats
                                     │          │ ── WebSocket ──> subscribers
┌──────────────┐     Unix socket     │          │
│ adapter      │ ──────────────────> │          │
│ (future)     │                     └──────────┘
└──────────────┘
```

The daemon doesn't know or care what decoder you're using. Adapters handle the translation. Two adapters ship today — `adapter readsb` and `adapter michelada` — and the socket protocol is open for future decoders.

### `adapter michelada`

[michelada](https://github.com/konradit/michelada) is a CaribouLite SDR station with a built-in 1090 MHz ADS-B decoder under `/extras/adsb`. Point the adapter at the station's HTTP address and it feeds the daemon exactly like the readsb adapter:

```bash
node dist/cli.js adapter michelada \
  --socket /tmp/at-adsb.sock \
  --url http://michelada.local:8080
```

Under Compose, set `MICHELADA_URL` in `.env` and bring up the profile-gated service. For a michelada-only station, name the two services so the readsb adapter stays down:

```bash
docker compose --profile michelada up -d daemon adapter-michelada
```

michelada shares one radio between the spectrum analyser, FPV, the detector and ADS-B, so the decoder only runs while the station is in ADS-B mode. The adapter switches it into that mode on startup (and whenever it finds the station in another mode), retrying at most every 30s because calibration and the detector hold the radio exclusively. Pass `--no-auto-start`, or set `MICHELADA_AUTO_START=false`, to leave the radio under your control. The adapter never switches the station back out of ADS-B mode.

michelada's API reports less than readsb's does, so sightings from it carry less detail:

| Field | michelada |
|-------|-----------|
| ICAO hex, callsign, lat/lon, ground track, ground speed | decoded |
| Altitude, squawk, category, vertical rate, NIC/Rc, QNH | not decoded — omitted from telemetry |
| RSSI | not measured — reported as readsb's `-49.5` dBFS floor |
| Message count | michelada exposes no counter; the adapter counts polls in which the aircraft was active, a lower bound |
| Position timestamps | derived from when the reported position changed, accurate to the poll interval |
| Raw frame capture (ATRX) | not available — michelada has no BEAST output, so sightings have no `rawCapture` blob |

Positions are labelled `adsb_icao` in telemetry, the same label readsb uses for fixes off the aircraft's own transponder.


## Docker Compose

### Quick start

From the repository root, run the wizard:

```bash
./setup-station.sh
```

It creates a mode-restricted `.env` and registers `at.adsb.receiver.station/self`. It does not start the stack automatically. The wizard's coordinate warning is required because station coordinates are public AT Protocol data; rounded coordinates are the safer default. Compose registration uses `--build`, so the image is built before the registration container runs.

Start the stack after registration:

```bash
docker compose up -d
```

For manual Compose setup, copy `.env.example`, edit the protected `.env`, and register with the built image. The CLI reads credentials from `.env`:

```bash
cp .env.example .env
# Edit .env without printing or committing credentials.
docker compose run --rm --build daemon register \
  --name "Home receiver" \
  --lat 38.8977 --lon -77.0365
```

### Configuration

All settings live in `.env`. Copy `.env.example` and fill in:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATP_SERVICE` | yes | `https://bsky.social` | Your PDS URL |
| `ATP_HANDLE` | yes | | AT Protocol handle |
| `ATP_PASSWORD` | yes | | App password (not your account password) |
| `READSB_URL` | yes (readsb adapter) | `http://host.docker.internal:8080` | readsb HTTP API base URL |
| `MICHELADA_URL` | yes (michelada adapter) | `http://localhost:8080` | michelada station HTTP base URL |
| `MICHELADA_SOURCE_ID` | no | `michelada-1090` | Source id for the michelada adapter (must differ from other adapters') |
| `MICHELADA_AUTO_START` | no | `true` | Switch the michelada station into ADS-B mode when it is in another mode |
| `WS_PORT` | no | `4100` | WebSocket event stream port |
| `BATCH_WINDOW_S` | no | `60` | Seconds between sighting publications |
| `STATS_INTERVAL_M` | no | `60` | Minutes between stats publications |
| `QUEUE_DB_PATH` | no | `/data/at-adsb-queue.db` in Compose | SQLite publish retry queue path |
| `POLL_INTERVAL_S` | no | `5` | How often the adapter polls readsb |
| `BEAST_HOST` | no | | BEAST TCP host for raw frame capture |
| `BEAST_PORT` | no | `30005` | BEAST TCP port |

If readsb runs on the host machine, `http://host.docker.internal:8080` works on Docker Desktop. On Linux, use `--add-host=host.docker.internal:host-gateway` or the host's LAN IP.

If readsb runs in another Compose stack, use Docker's network features to connect them, or point `READSB_URL` at the container's network address.

### Register your station

Before the daemon can publish, you need a station record on your AT Protocol account. The quick-start wizard is the recommended path. If you use the manual Compose path above, replace the example coordinates with rounded coordinates for your receiver and run:

```bash
docker compose run --rm --build daemon register \
  --name "Home receiver" \
  --lat 38.8977 --lon -77.0365
```

Credentials come from the protected `.env`; do not put an app password in command arguments. Station coordinates are public now, so do not enter precise home coordinates unless you deliberately accept that disclosure.

### Enable raw BEAST capture

To attach raw SDR frames to sighting records (for cryptographic provenance), uncomment the BEAST lines in `docker-compose.yml` and set `BEAST_HOST`/`BEAST_PORT` in `.env`. The adapter connects to the BEAST TCP port, captures frames each batch window, and passes them to the daemon for upload.

### Multiple adapters

To run a second decoder (e.g., a 978 MHz UAT receiver), duplicate the `adapter-readsb` service in `docker-compose.yml` with a different name, `--source-id`, and `--url`. `docker-compose.yml` also carries a commented-out `adapter-michelada` service to uncomment if you feed from a michelada station. Both adapters connect to the same daemon socket. The daemon merges their data automatically — sighting records include a `sources` array showing which decoders contributed.

Give every adapter its own `--source-id`: the daemon replaces an existing connection when a second adapter hands over the same id, so a duplicate id silently drops one of them.

### Verify it's working

```bash
# Check both containers are running
docker compose ps

# Watch daemon logs for sighting publications
docker compose logs -f daemon

# Watch adapter logs for poll cycles
docker compose logs -f adapter-readsb
```

You should see the adapter polling every few seconds and the daemon publishing sighting records every `BATCH_WINDOW_S` seconds.

## Kubernetes (k3s)

The `k3s-manifests/at-adsb.yaml` file defines a Deployment with the daemon and adapter as sidecar containers in the same pod. They share a socket via an in-memory `emptyDir` volume.

### Setup

1. Build and load the image:

```bash
docker build -t at-adsb:latest -f server/Dockerfile .
# For k3s with local images:
sudo k3s ctr images import <(docker save at-adsb:latest)
```

2. Create the `at-adsb-credentials` Secret with your platform's protected secret-management workflow. Do not place the app password in shell history or a command argument. The Secret must contain `handle` and `password` keys.

3. Register your station (one-time) with that Secret injected into the registration Pod:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: at-adsb-register
spec:
  restartPolicy: Never
  containers:
    - name: register
      image: at-adsb:latest
      command: ["node", "dist/cli.js", "register"]
      args: ["--name", "Home receiver", "--lat", "38.8977", "--lon", "-77.0365"]
      env:
        - name: ATP_SERVICE
          value: "https://bsky.social"
        - name: ATP_HANDLE
          valueFrom:
            secretKeyRef:
              name: at-adsb-credentials
              key: handle
        - name: ATP_PASSWORD
          valueFrom:
            secretKeyRef:
              name: at-adsb-credentials
              key: password
EOF
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/at-adsb-register --timeout=120s
kubectl logs pod/at-adsb-register
kubectl delete pod at-adsb-register
```

The Pod receives credentials as environment variables, not register arguments. Use a short-lived Pod manifest or your cluster's secret-injection mechanism when process inspection is a concern.

4. Edit the manifest to match your environment:

   - Set the readsb URL in the adapter's `--url` arg (default: `http://readsb:8080`)
   - Uncomment the BEAST args if you want raw frame capture
   - Uncomment the stream signing key secret if you've generated one
   - Replace the `data` `emptyDir` with a PVC if you want the queue database to survive pod restarts

5. Apply:

```bash
kubectl apply -f k3s-manifests/at-adsb.yaml
```

### Customisation

The manifest exposes the WebSocket event stream on NodePort 30100. Change the `nodePort` value or switch the Service type to `ClusterIP`/`LoadBalancer` depending on your ingress setup.

Resource limits are conservative (256Mi / 500m CPU for the daemon, 128Mi / 250m for the adapter). If you're tracking high-traffic airspace, bump the daemon limits.

## Building from source

If you prefer to run without containers:

```bash
cd server
npm ci
npm run build

# Register station with a separate protected credentials file.
# Create ./at-adsb-credentials.env with mode 0600; keep it separate from the
# Compose-escaped .env and do not commit it. It should define ATP_HANDLE and
# ATP_PASSWORD. The shell-compatible file is loaded only for this process.
set -a
. ./at-adsb-credentials.env
set +a
node dist/cli.js register \
  --name "Home receiver" \
  --lat 38.8977 --lon -77.0365

# Start daemon (in one terminal)
node dist/cli.js run --socket-path /tmp/at-adsb.sock

# Start adapter (in another terminal)
node dist/cli.js adapter readsb \
  --socket /tmp/at-adsb.sock \
  --url http://localhost:8080

# ...or feed from a michelada station instead
node dist/cli.js adapter michelada \
  --socket /tmp/at-adsb.sock \
  --url http://michelada.local:8080
```

Requires Node.js 22+.

## Troubleshooting

**Adapter can't connect to daemon socket.** The daemon creates the socket file on startup. If the adapter starts first, it'll retry with exponential backoff (1s, 2s, 4s... up to 60s). Check that both processes can access the same socket path.

**No sighting records published.** The daemon only publishes when it has position data. If your readsb instance has no aircraft in range, the batch window flushes empty (by design). Check `docker compose logs adapter-readsb` to confirm the adapter is receiving aircraft from the decoder.

**michelada adapter reports no aircraft.** The adapter logs `station is not in ADS-B mode` when michelada's radio is doing something else. With auto-start enabled it asks the station to switch every 30s, but michelada refuses while calibration or the detector owns the radio — stop those first. Note also that michelada only reports a position once it has decoded an even/odd CPR pair for an aircraft, so aircraft appear in its table before they have coordinates.

**"Station record not found" on daemon start.** Run the `register` command first. The daemon expects a station record to already exist on your AT Protocol account.

**Queue database errors.** The daemon uses SQLite for its publish retry queue. Make sure the `QUEUE_DB_PATH` directory is writable. In Docker, the `queue-data` volume handles this. In k3s, consider a PVC instead of `emptyDir` if you need persistence across pod restarts.
