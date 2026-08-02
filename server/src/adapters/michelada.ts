// pattern: Imperative Shell

import { createConnection, Socket } from "node:net";
import { fetchAircraft, startAdsb } from "../michelada.js";
import type { AircraftMessage } from "../normalized.js";
import {
  mapMicheladaPoll,
  buildStatsMessage,
  type MicheladaAircraftState,
} from "./michelada-mapping.js";
import { calculateBackoffDelay } from "./readsb-mapping.js";

// Minimum gap between attempts to switch the station into ADS-B mode. The
// switch is refused while calibration or the detector owns the radio, so
// retrying on every poll would just spam the station.
const AUTO_START_INTERVAL_MS = 30_000;

export type MicheladaAdapterConfig = {
  readonly socketPath: string;
  readonly micheladaUrl: string;
  readonly sourceId: string;
  readonly pollIntervalS: number;
  // Put the station into ADS-B mode when it is in another mode. Without this
  // the adapter reports nothing whenever the radio is doing something else.
  readonly autoStart: boolean;
};

export class MicheladaAdapterClient {
  private socket: Socket | null = null;
  private reconnectDelayMs: number = 1000;
  private maxReconnectDelayMs: number = 60000;
  private currentReconnectDelayMs: number = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;
  private states: ReadonlyMap<string, MicheladaAircraftState> = new Map();
  private lastPollMs: number | null = null;
  private lastAutoStartMs: number | null = null;
  private wasActive: boolean | null = null;

  constructor(private readonly config: MicheladaAdapterConfig) {}

  start(): void {
    if (this.stopped) {
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.socket = createConnection(this.config.socketPath, () => {
      this.currentReconnectDelayMs = this.reconnectDelayMs;
      console.log(`MicheladaAdapter: Connected to ${this.config.socketPath}`);

      const handshake = {
        type: "handshake",
        sourceId: this.config.sourceId,
        protocol: "adsb",
        version: 1,
      };
      this.writeMessage(handshake);

      this.startPollLoop();
    });

    this.socket.on("error", (err: Error) => {
      console.error(`MicheladaAdapter: Connection error: ${err.message}`);
      this.scheduleReconnect();
    });

    this.socket.on("close", () => {
      console.log("MicheladaAdapter: Connection closed");
      this.stopPollLoop();
      this.scheduleReconnect();
    });

    this.socket.on("data", () => {
      // We don't expect data from the daemon, just receive and ignore
    });
  }

  private writeMessage(message: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    try {
      const json = JSON.stringify(message);
      this.socket.write(`${json}\n`);
    } catch (err) {
      console.error(`failed to write message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const pollMs = this.config.pollIntervalS * 1000;

    // Poll immediately
    this.pollOnce().catch((err: Error) => {
      console.error(`failed to poll aircraft: ${err.message}`);
    });

    // Then poll at interval
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err: Error) => {
        console.error(`failed to poll aircraft: ${err.message}`);
      });
    }, pollMs);
  }

  private stopPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const data = await fetchAircraft(this.config.micheladaUrl);
    const nowMs = Date.now();
    const elapsedS =
      this.lastPollMs === null
        ? Number.POSITIVE_INFINITY
        : (nowMs - this.lastPollMs) / 1000;
    this.lastPollMs = nowMs;

    if (data.active !== this.wasActive) {
      console.log(
        data.active
          ? "MicheladaAdapter: station is in ADS-B mode"
          : "MicheladaAdapter: station is not in ADS-B mode, no aircraft will be decoded",
      );
      this.wasActive = data.active;
    }

    if (!data.active && this.config.autoStart) {
      await this.requestAdsbMode(nowMs);
    }

    const result = mapMicheladaPoll(
      data.aircraft ?? [],
      this.states,
      nowMs,
      elapsedS,
    );
    this.states = result.states;

    const message: AircraftMessage = {
      type: "aircraft",
      // The daemon timestamps positions against this clock, and the synthesized
      // seenPos values are ages measured on the same clock.
      timestamp: nowMs / 1000,
      aircraft: result.aircraft,
    };

    this.writeMessage(message);

    const statsMessage = buildStatsMessage(
      result.messagesDelta,
      result.positionsDelta,
    );
    if (statsMessage) {
      this.writeMessage(statsMessage);
    }
  }

  private async requestAdsbMode(nowMs: number): Promise<void> {
    if (
      this.lastAutoStartMs !== null &&
      nowMs - this.lastAutoStartMs < AUTO_START_INTERVAL_MS
    ) {
      return;
    }
    this.lastAutoStartMs = nowMs;

    try {
      const result = await startAdsb(this.config.micheladaUrl);
      console.log(`MicheladaAdapter: requested ADS-B mode, station is in ${result.mode} mode`);
    } catch (err) {
      console.error(
        `failed to switch station into ADS-B mode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delayMs = this.currentReconnectDelayMs;
    console.log(`MicheladaAdapter: Scheduling reconnect in ${delayMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);

    // Exponential backoff: double the delay, capped at max
    this.currentReconnectDelayMs = calculateBackoffDelay(
      this.currentReconnectDelayMs,
      this.maxReconnectDelayMs,
    );
  }

  stop(): void {
    this.stopped = true;

    this.stopPollLoop();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

export async function runMicheladaAdapter(
  config: MicheladaAdapterConfig,
): Promise<void> {
  const client = new MicheladaAdapterClient(config);
  client.start();

  // Handle graceful shutdown. The station is left in whatever mode it is in --
  // the adapter never switches the radio back, so a daemon restart doesn't
  // interrupt reception.
  process.on("SIGINT", () => {
    console.log("MicheladaAdapter: SIGINT received, shutting down");
    client.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("MicheladaAdapter: SIGTERM received, shutting down");
    client.stop();
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {
    // Never resolves, process is kept alive by timers
  });
}
