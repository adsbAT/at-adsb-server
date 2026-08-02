#!/usr/bin/env node
// pattern: Imperative Shell

import 'dotenv/config';
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { createAgent, putRecord, getRecord } from "./client.js";
import { buildStationRecord, type StationRecordOptions } from "./records.js";
import { buildDaemonConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { runReadsbAdapter } from "./adapters/readsb.js";
import { generateSigningKey, getSigningKeyDid, exportSigningKeyHex } from "./keys.js";
import type { Credentials } from "./client.js";
import { AtpAgent } from "@atproto/api";

function getCredentials(opts: {
  service?: string;
  handle?: string;
  password?: string;
}): Credentials {
  const service =
    opts.service ?? process.env["ATP_SERVICE"] ?? "https://bsky.social";
  const identifier = opts.handle ?? process.env["ATP_HANDLE"];
  const password = opts.password ?? process.env["ATP_PASSWORD"];

  if (!identifier) {
    console.error("Error: --handle or ATP_HANDLE env var required.");
    process.exit(1);
  }
  if (!password) {
    console.error("Error: --password or ATP_PASSWORD env var required.");
    process.exit(1);
  }

  return { service, identifier, password };
}

export function buildStationOpts(opts: Record<string, unknown>): StationRecordOptions {
  return {
    displayName: opts["name"] as string,
    latitude: opts["lat"] as number,
    longitude: opts["lon"] as number,
    altitude: opts["altitude"] as number | undefined,
    locationName: opts["locationName"] as string | undefined,
    description: opts["description"] as string | undefined,
    website: opts["website"] as string | undefined,
    coverageRadiusNm: opts["coverage"] as number | undefined,
    receiver: opts["receiver"] as string | undefined,
    antenna: opts["antenna"] as string | undefined,
    software: opts["software"] as string | undefined,
    protocols: opts["protocols"] ? (opts["protocols"] as string).split(",") : undefined,
    streamEndpoint: (opts["streamEndpoint"] as string | undefined) ?? process.env["STREAM_ENDPOINT"],
  };
}

export async function generateStreamKey(
  agent: AtpAgent,
): Promise<{
  didKey: string;
  privateHex: string;
}> {
  const stationRecord = await getRecord(
    agent,
    "at.adsb.receiver.station",
    "self",
  );

  if (!stationRecord) {
    throw new Error("No station record found. Run 'at-adsb register' first.");
  }

  const keypair = await generateSigningKey();
  const privateHex = await exportSigningKeyHex(keypair);
  const didKey = getSigningKeyDid(keypair);

  const updatedRecord: Record<string, unknown> = {
    ...(stationRecord.value as Record<string, unknown>),
    streamSigningKey: didKey,
  };
  delete updatedRecord["$type"];

  await putRecord(
    agent,
    "at.adsb.receiver.station",
    "self",
    updatedRecord,
  );

  return { didKey, privateHex };
}

const program = new Command();

program
  .name("at-adsb")
  .description(
    "Daemon and CLI for publishing ADS-B receiver data to the AT Protocol network.",
  )
  .version("0.1.0");

program
  .command("register")
  .description("Register or update a receiver station record.")
  .requiredOption("--name <name>", "Display name for the station")
  .requiredOption("--lat <latitude>", "Latitude (decimal degrees, WGS84)", parseFloat)
  .requiredOption("--lon <longitude>", "Longitude (decimal degrees, WGS84)", parseFloat)
  .option("--altitude <metres>", "Altitude in metres above sea level", parseFloat)
  .option("--location-name <name>", "Human-readable location name")
  .option("--receiver <model>", "Receiver hardware model")
  .option("--antenna <model>", "Antenna model")
  .option("--software <name>", "Decoder software")
  .option(
    "--coverage <nm>",
    "Estimated coverage radius in nautical miles",
    (v) => parseInt(v, 10),
  )
  .option(
    "--protocols <list>",
    "Comma-separated protocols (adsb,mlat,uat,acars,vdl2,hfdl)",
  )
  .option("--description <text>", "Free-form station description")
  .option("--website <url>", "Station stats page URL")
  .option("--stream-endpoint <url>", "WebSocket URL for relay auto-discovery (env: STREAM_ENDPOINT)")
  .option("--handle <handle>", "Account handle")
  .option("--password <password>", "App password")
  .option("--service <url>", "PDS service URL")
  .action(async (opts) => {
    const creds = getCredentials(opts);
    const agent = await createAgent(creds);

    const stationOpts = buildStationOpts(opts);

    try {
      const record = buildStationRecord(stationOpts, new Date());
      const result = await putRecord(
        agent,
        "at.adsb.receiver.station",
        "self",
        record,
      );
      console.log(`Station registered: ${result.uri}`);
    } catch (err) {
      console.error(
        "Failed to register station:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

program
  .command("generate-stream-key")
  .description("Generate a secp256k1 signing keypair for the event stream and update the station record.")
  .option("--handle <handle>", "Account handle")
  .option("--password <password>", "App password")
  .option("--service <url>", "PDS service URL")
  .action(async (opts) => {
    const creds = getCredentials(opts);
    const agent = await createAgent(creds);

    try {
      const { didKey, privateHex } = await generateStreamKey(agent);

      console.log("Stream signing key generated.");
      console.log(`Public key (did:key): ${didKey}`);
      console.log(`Private key (hex): ${privateHex}`);
      console.log("");
      console.log("Add to your environment:");
      console.log(`  STREAM_SIGNING_KEY_HEX=${privateHex}`);
    } catch (err) {
      console.error(
        "Failed to generate stream key:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  });

program
  .command("run")
  .description(
    "Run the daemon: accept adapter connections, publish sightings and stats to PDS.",
  )
  .option("--socket-path <path>", "Unix socket path (env: SOCKET_PATH)")
  .option("--atrx-temp-dir <dir>", "Temp directory for ATRX blob transfer (env: ATRX_TEMP_DIR)")
  .action(async (opts) => {
    const atpHandle = process.env["ATP_HANDLE"];
    const atpPassword = process.env["ATP_PASSWORD"];

    if (!atpHandle) {
      console.error("Error: --handle or ATP_HANDLE env var required.");
      process.exit(1);
    }
    if (!atpPassword) {
      console.error("Error: --password or ATP_PASSWORD env var required.");
      process.exit(1);
    }

    const creds: Credentials = {
      service: process.env["ATP_SERVICE"] ?? "https://bsky.social",
      identifier: atpHandle,
      password: atpPassword,
    };

    const agent = await createAgent(creds);

    // Fetch station record to get receiver location
    const stationRecord = await getRecord(
      agent,
      "at.adsb.receiver.station",
      "self",
    );

    if (!stationRecord) {
      console.error(
        "No station record found. Run 'at-adsb register' first to set up your receiver.",
      );
      process.exit(1);
    }

    // Extract lat/lon from station record location field
    const location = (stationRecord.value as Record<string, unknown>)
      ["location"] as Record<string, unknown> | undefined;
    if (!location) {
      console.error(
        "Station record missing location field.",
      );
      process.exit(1);
    }

    const rawLat = location["latitude"];
    const rawLon = location["longitude"];
    const receiverLat = typeof rawLat === "string" ? parseFloat(rawLat) : typeof rawLat === "number" ? rawLat : NaN;
    const receiverLon = typeof rawLon === "string" ? parseFloat(rawLon) : typeof rawLon === "number" ? rawLon : NaN;

    if (
      !Number.isFinite(receiverLat) ||
      !Number.isFinite(receiverLon) ||
      receiverLat < -90 ||
      receiverLat > 90 ||
      receiverLon < -180 ||
      receiverLon > 180
    ) {
      console.error(
        "Station record has invalid location: latitude and longitude must be valid numbers.",
      );
      process.exit(1);
    }

    const socketPath = opts.socketPath ?? process.env["SOCKET_PATH"] ?? "/tmp/at-adsb.sock";
    const atrxTempDir = opts.atrxTempDir ?? process.env["ATRX_TEMP_DIR"] ?? "/tmp/at-adsb-atrx";

    await mkdir(atrxTempDir, { recursive: true });

    let config;
    try {
      config = buildDaemonConfig({
        service: creds.service,
        identifier: creds.identifier,
        password: creds.password,
        receiverLat,
        receiverLon,
        socketPath,
        atrxTempDir,
        env: process.env,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    const stationRef = {
      uri: stationRecord.uri,
      cid: stationRecord.cid ?? "",
    };

    await runDaemon(agent, config, stationRef);
  });

const adapter = program
  .command("adapter")
  .description("Run an input adapter process.");

adapter
  .command("readsb")
  .description("Poll a readsb instance and stream data to the daemon.")
  .option("--socket <path>", "Daemon Unix socket path (env: SOCKET_PATH)")
  .option("--url <url>", "readsb HTTP base URL (env: READSB_URL)")
  .option("--source-id <id>", "Adapter source identifier (env: SOURCE_ID)")
  .option("--beast-host <host>", "BEAST TCP host for raw capture (env: BEAST_HOST)")
  .option("--beast-port <port>", "BEAST TCP port for raw capture (env: BEAST_PORT)", parseInt)
  .option("--batch-window <seconds>", "Raw capture batch window in seconds (env: BATCH_WINDOW_S)", parseInt)
  .option("--poll-interval <seconds>", "Poll interval in seconds (env: POLL_INTERVAL_S)", parseInt)
  .option("--atrx-temp-dir <dir>", "Temp directory for ATRX blob transfer (env: ATRX_TEMP_DIR)")
  .action(async (opts) => {
    const config = {
      socketPath: opts.socket ?? process.env["SOCKET_PATH"] ?? "/tmp/at-adsb.sock",
      readsbUrl: opts.url ?? process.env["READSB_URL"] ?? "http://localhost:8080",
      sourceId: opts.sourceId ?? process.env["SOURCE_ID"] ?? "readsb-1090",
      pollIntervalS: opts.pollInterval ?? parseInt(process.env["POLL_INTERVAL_S"] ?? "1", 10),
      beastHost: opts.beastHost ?? process.env["BEAST_HOST"] ?? undefined,
      beastPort: opts.beastPort ?? (process.env["BEAST_PORT"] ? parseInt(process.env["BEAST_PORT"], 10) : undefined),
      batchWindowS: opts.batchWindow ?? parseInt(process.env["BATCH_WINDOW_S"] ?? "15", 10),
      atrxTempDir: opts.atrxTempDir ?? process.env["ATRX_TEMP_DIR"] ?? "/tmp/at-adsb-atrx",
    };

    await runReadsbAdapter(config);
  });

// pathToFileURL, not string interpolation: on Windows argv[1] is a drive path
// that never matches a file:// URL, so the CLI would parse no arguments at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.parse();
}
