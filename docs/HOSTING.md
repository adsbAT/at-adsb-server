# Hosting at-adsb

at-adsb runs as two processes: a **daemon** that publishes to the AT Protocol network, and one or more **adapters** that feed aircraft data into it. They communicate over a Unix domain socket.

This guide covers Docker Compose and Kubernetes (k3s) deployments. Both assume you already have a decoder like [readsb](https://github.com/wiedehopf/readsb) running somewhere accessible over HTTP.

## Prerequisites

- An AT Protocol account (e.g., on [bsky.social](https://bsky.social))
- An [app password](https://bsky.app/settings/app-passwords) for that account
- A running readsb instance (or any decoder with an HTTP JSON API)
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

The daemon doesn't know or care what decoder you're using. Adapters handle the translation. Today only `adapter readsb` exists, but the socket protocol is open for future decoders.

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
| `READSB_URL` | yes | `http://host.docker.internal:8080` | readsb HTTP API base URL |
| `WS_PORT` | no | `4100` | WebSocket event stream port |
| `BATCH_WINDOW_S` | no | `15` | Seconds between sighting publications |
| `STATS_INTERVAL_M` | no | `60` | Minutes between stats publications |
| `QUEUE_DB_PATH` | no | `/data/at-adsb-queue.db` in Compose | SQLite publish retry queue path |
| `POLL_INTERVAL_S` | no | `5` | How often the adapter polls readsb |
| `STREAM_SIGNING_KEY_HEX` | no | | Private hex of secp256k1 stream signing keypair (generate with `generate-stream-key`) |
| `STREAM_ENDPOINT` | no | | Public `wss://` URL for relay auto-discovery (see [Exposing your station](#exposing-your-station-publicly)) |
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

To run a second decoder (e.g., a 978 MHz UAT receiver), duplicate the `adapter-readsb` service in `docker-compose.yml` with a different name, `--source-id`, and `--url`. Both adapters connect to the same daemon socket. The daemon merges their data automatically — sighting records include a `sources` array showing which decoders contributed.

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

## Exposing your station publicly

The daemon broadcasts a realtime WebSocket event stream on port 4100. If you want relays and aggregators to discover and subscribe to your stream, you need to make it publicly reachable with a stable URL and set `STREAM_ENDPOINT`.

This is **optional** — your station publishes sightings and flight records to the AT Protocol network regardless. The stream endpoint is for realtime consumers that want live data without polling.

### Prerequisites

- **A domain name** (or subdomain) with a DNS A/AAAA record pointing to your server's public IP address. Without a domain, you cannot get a TLS certificate, and `wss://` (secure WebSocket) requires TLS.
- Ports **80** and **443** open on your server's firewall for TLS certificate provisioning and HTTPS traffic.
- If you're behind a home router/NAT, forward ports 80, 443, and 4100 to your server's internal IP. Consider a dynamic DNS service if you don't have a static IP.

### Using Caddy (recommended)

[Caddy](https://caddyserver.com/) automatically provisions TLS certificates via Let's Encrypt and proxies WebSocket connections with no special configuration.

1. Install Caddy on your host (not inside the Docker stack — it needs to bind ports 80/443):

   ```bash
   sudo apt install caddy
   # or see https://caddyserver.com/docs/install
   ```

2. Edit the Caddyfile (usually `/etc/caddy/Caddyfile`):

   ```caddyfile
   adsb.yourdomain.com {
       reverse_proxy localhost:4100
   }
   ```

3. Reload Caddy:

   ```bash
   sudo systemctl reload caddy
   ```

   Caddy will obtain a TLS certificate on the first request. No manual cert management needed.

4. Set `STREAM_ENDPOINT` in your `.env`:

   ```bash
   STREAM_ENDPOINT=wss://adsb.yourdomain.com/xrpc/at.adsb.broadcast.subscribeEvents
   ```

5. Restart the daemon:

   ```bash
   docker compose up -d
   ```

### Using a Cloudflare Tunnel (no open ports)

If you can't open ports 80/443 (e.g., shared network, restrictive ISP), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) provides a free reverse tunnel that needs no inbound ports:

1. Install `cloudflared` and authenticate.
2. Create a tunnel pointing `adsb.yourdomain.com` to `http://localhost:4100`.
3. Set `STREAM_ENDPOINT` to `wss://adsb.yourdomain.com/xrpc/at.adsb.broadcast.subscribeEvents`.
4. Restart the daemon.

### Verify it works

From another machine, test the WebSocket handshake:

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://adsb.yourdomain.com/xrpc/at.adsb.broadcast.subscribeEvents
```

You should see `HTTP/1.1 101 Switching Protocols`. If you get a 502 or connection refused, check that the daemon is running and the reverse proxy is forwarding to the correct port (4100 by default).

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
```

Requires Node.js 22+.

## Troubleshooting

**Adapter can't connect to daemon socket.** The daemon creates the socket file on startup. If the adapter starts first, it'll retry with exponential backoff (1s, 2s, 4s... up to 60s). Check that both processes can access the same socket path.

**No sighting records published.** The daemon only publishes when it has position data. If your readsb instance has no aircraft in range, the batch window flushes empty (by design). Check `docker compose logs adapter-readsb` to confirm the adapter is receiving aircraft from the decoder.

**"Station record not found" on daemon start.** Run the `register` command first. The daemon expects a station record to already exist on your AT Protocol account.

**Queue database errors.** The daemon uses SQLite for its publish retry queue. Make sure the `QUEUE_DB_PATH` directory is writable. In Docker, the `queue-data` volume handles this. In k3s, consider a PVC instead of `emptyDir` if you need persistence across pod restarts.
