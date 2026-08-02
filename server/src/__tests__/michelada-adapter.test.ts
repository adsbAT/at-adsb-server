import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { MicheladaAircraft } from "../michelada.js";
import {
  mapMicheladaAircraft,
  mapMicheladaPoll,
  buildStatsMessage,
  MICHELADA_SOURCE,
  UNKNOWN_RSSI_DBFS,
  STATE_RETENTION_MS,
  type MicheladaAircraftState,
} from "../adapters/michelada-mapping.js";
import { validateNormalizedAircraft } from "../normalized.js";
import { AircraftTracker } from "../tracker.js";

const T0 = 1_780_000_000_000;

function entry(overrides?: Partial<MicheladaAircraft>): MicheladaAircraft {
  return {
    icao: "A1B2C3",
    lat: null,
    lon: null,
    heading: null,
    last_seen: 0,
    ...overrides,
  };
}

describe("michelada adapter — field mapping", () => {
  it("uppercases the ICAO address", () => {
    const mapped = mapMicheladaAircraft(entry({ icao: "a1b2c3" }), undefined, T0, 1);

    expect(mapped?.aircraft.icaoHex).toBe("A1B2C3");
  });

  it("rejects rows without a usable ICAO address", () => {
    expect(mapMicheladaAircraft(entry({ icao: "" }), undefined, T0, 1)).toBeNull();
    expect(mapMicheladaAircraft(entry({ icao: "ZZZZZZ" }), undefined, T0, 1)).toBeNull();
    expect(mapMicheladaAircraft(entry({ icao: "A1B2" }), undefined, T0, 1)).toBeNull();
  });

  it("labels positions adsb_icao, matching readsb's label for own-transponder fixes", () => {
    const mapped = mapMicheladaAircraft(entry(), undefined, T0, 1);

    expect(mapped?.aircraft.source).toBe(MICHELADA_SOURCE);
    expect(mapped?.aircraft.source).toBe("adsb_icao");
  });

  it("reports readsb's RSSI floor, since michelada measures no signal power", () => {
    const mapped = mapMicheladaAircraft(entry(), undefined, T0, 1);

    expect(mapped?.aircraft.rssi).toBe(UNKNOWN_RSSI_DBFS);
  });

  it("maps callsign, heading and speed onto flight, track and gs", () => {
    const mapped = mapMicheladaAircraft(
      entry({ callsign: " UAL456 ", heading: 183.5, speed: 420 }),
      undefined,
      T0,
      1,
    );

    expect(mapped?.aircraft.flight).toBe("UAL456");
    expect(mapped?.aircraft.track).toBe(183.5);
    expect(mapped?.aircraft.gs).toBe(420);
  });

  it("omits the fields michelada does not decode", () => {
    const mapped = mapMicheladaAircraft(entry(), undefined, T0, 1);

    expect(mapped?.aircraft.altBaro).toBeUndefined();
    expect(mapped?.aircraft.altGeom).toBeUndefined();
    expect(mapped?.aircraft.squawk).toBeUndefined();
    expect(mapped?.aircraft.category).toBeUndefined();
    expect(mapped?.aircraft.baroRate).toBeUndefined();
    expect(mapped?.aircraft.nic).toBeUndefined();
    expect(mapped?.aircraft.rc).toBeUndefined();
  });

  it("treats null lat/lon/heading/speed as absent", () => {
    const mapped = mapMicheladaAircraft(entry(), undefined, T0, 1);

    expect(mapped?.aircraft.lat).toBeUndefined();
    expect(mapped?.aircraft.lon).toBeUndefined();
    expect(mapped?.aircraft.seenPos).toBeUndefined();
    expect(mapped?.aircraft.track).toBeUndefined();
    expect(mapped?.aircraft.gs).toBeUndefined();
  });

  it("produces messages the daemon's validator accepts", () => {
    const mapped = mapMicheladaAircraft(
      entry({ lat: 41.1, lon: 2.07, heading: 90, speed: 300, callsign: "VLG123" }),
      undefined,
      T0,
      1,
    );

    expect(validateNormalizedAircraft(JSON.parse(JSON.stringify(mapped?.aircraft)))).not.toBeNull();
  });
});

describe("michelada adapter — synthesized position freshness", () => {
  it("flags the first fix as new and dates it from last_seen", () => {
    const mapped = mapMicheladaAircraft(
      entry({ lat: 41.1, lon: 2.07, last_seen: 3 }),
      undefined,
      T0,
      1,
    );

    expect(mapped?.aircraft.newPosition).toBe(true);
    // The fix arrived no later than the last message, i.e. 3s ago.
    expect(mapped?.aircraft.seenPos).toBe(3);
    expect(mapped?.positionsDelta).toBe(1);
  });

  it("ages an unchanged position instead of re-reporting it as new", () => {
    const first = mapMicheladaAircraft(
      entry({ lat: 41.1, lon: 2.07 }),
      undefined,
      T0,
      1,
    );
    const second = mapMicheladaAircraft(
      entry({ lat: 41.1, lon: 2.07 }),
      first?.state,
      T0 + 2000,
      2,
    );

    expect(second?.aircraft.newPosition).toBe(false);
    expect(second?.aircraft.seenPos).toBe(2);
    expect(second?.positionsDelta).toBe(0);
  });

  it("flags a changed position as new", () => {
    const first = mapMicheladaAircraft(
      entry({ lat: 41.1, lon: 2.07 }),
      undefined,
      T0,
      1,
    );
    const second = mapMicheladaAircraft(
      entry({ lat: 41.2, lon: 2.08 }),
      first?.state,
      T0 + 2000,
      2,
    );

    expect(second?.aircraft.newPosition).toBe(true);
    expect(second?.aircraft.seenPos).toBe(0);
    expect(second?.positionsDelta).toBe(1);
  });

  it("counts back-to-back fixes that a falling-seenPos heuristic would miss", () => {
    // Both polls report a fresh fix, so both carry seenPos 0. Only the explicit
    // newPosition flag distinguishes them.
    const tracker = new AircraftTracker(41.0, 2.0);
    let state: MicheladaAircraftState | undefined;
    let counted = 0;

    for (let poll = 0; poll < 4; poll++) {
      const nowMs = T0 + poll * 1000;
      const mapped = mapMicheladaAircraft(
        entry({ lat: 41.1 + poll * 0.01, lon: 2.07 }),
        state,
        nowMs,
        1,
      );
      state = mapped?.state;
      expect(mapped?.aircraft.seenPos).toBe(0);

      const result = tracker.update([mapped!.aircraft], nowMs / 1000);
      counted += result.positions.get("A1B2C3")?.length ?? 0;
    }

    expect(counted).toBe(4);
    expect(tracker.getTracked("A1B2C3")?.positionCount).toBe(4);
  });

  it("does not re-count a position the tracker already has", () => {
    const tracker = new AircraftTracker(41.0, 2.0);
    let state: MicheladaAircraftState | undefined;
    let counted = 0;

    for (let poll = 0; poll < 5; poll++) {
      const nowMs = T0 + poll * 1000;
      const mapped = mapMicheladaAircraft(
        entry({ lat: 41.1, lon: 2.07 }),
        state,
        nowMs,
        1,
      );
      state = mapped?.state;

      const result = tracker.update([mapped!.aircraft], nowMs / 1000);
      counted += result.positions.get("A1B2C3")?.length ?? 0;
    }

    expect(counted).toBe(1);
  });
});

describe("michelada adapter — synthesized message counter", () => {
  it("starts at one for a newly seen aircraft", () => {
    const mapped = mapMicheladaAircraft(entry(), undefined, T0, Number.POSITIVE_INFINITY);

    expect(mapped?.aircraft.messages).toBe(1);
    expect(mapped?.messagesDelta).toBe(1);
  });

  it("increments while last_seen shows activity since the previous poll", () => {
    const first = mapMicheladaAircraft(entry(), undefined, T0, 1);
    const second = mapMicheladaAircraft(entry({ last_seen: 0 }), first?.state, T0 + 1000, 1);

    expect(second?.aircraft.messages).toBe(2);
    expect(second?.messagesDelta).toBe(1);
  });

  it("holds steady while the aircraft is silent", () => {
    const first = mapMicheladaAircraft(entry(), undefined, T0, 1);
    const second = mapMicheladaAircraft(entry({ last_seen: 12 }), first?.state, T0 + 1000, 1);

    expect(second?.aircraft.messages).toBe(1);
    expect(second?.messagesDelta).toBe(0);
  });

  it("never decreases across a poll sequence", () => {
    let state: MicheladaAircraftState | undefined;
    let previous = 0;

    for (const last_seen of [0, 0, 4, 0, 9, 1, 0]) {
      const mapped = mapMicheladaAircraft(entry({ last_seen }), state, T0, 2);
      state = mapped?.state;
      expect(mapped!.aircraft.messages).toBeGreaterThanOrEqual(previous);
      previous = mapped!.aircraft.messages;
    }
  });
});

describe("michelada adapter — snapshot mapping", () => {
  it("maps every valid row and drops the invalid ones", () => {
    const poll = mapMicheladaPoll(
      [entry({ icao: "A1B2C3" }), entry({ icao: "nope" }), entry({ icao: "4CA1FB" })],
      new Map(),
      T0,
      1,
    );

    expect(poll.aircraft.map((ac) => ac.icaoHex)).toEqual(["A1B2C3", "4CA1FB"]);
  });

  it("carries counters forward across polls", () => {
    const first = mapMicheladaPoll([entry({ lat: 41.1, lon: 2.07 })], new Map(), T0, 1);
    const second = mapMicheladaPoll(
      [entry({ lat: 41.1, lon: 2.07 })],
      first.states,
      T0 + 1000,
      1,
    );

    expect(second.aircraft[0]?.messages).toBe(2);
    expect(second.aircraft[0]?.seenPos).toBe(1);
    expect(second.messagesDelta).toBe(1);
    expect(second.positionsDelta).toBe(0);
  });

  it("keeps state for an aircraft that briefly drops out of the table", () => {
    const first = mapMicheladaPoll([entry()], new Map(), T0, 1);
    const gap = mapMicheladaPoll([], first.states, T0 + 1000, 1);
    const back = mapMicheladaPoll([entry()], gap.states, T0 + 2000, 1);

    expect(gap.states.has("A1B2C3")).toBe(true);
    expect(back.aircraft[0]?.messages).toBe(2);
  });

  it("prunes state once the aircraft is gone for longer than the retention window", () => {
    const first = mapMicheladaPoll([entry()], new Map(), T0, 1);
    const later = mapMicheladaPoll([], first.states, T0 + STATE_RETENTION_MS + 1, 1);

    expect(later.states.size).toBe(0);
  });

  it("sums per-aircraft deltas", () => {
    const poll = mapMicheladaPoll(
      [
        entry({ icao: "A1B2C3", lat: 41.1, lon: 2.07 }),
        entry({ icao: "4CA1FB", lat: 41.3, lon: 2.11 }),
      ],
      new Map(),
      T0,
      1,
    );

    expect(poll.messagesDelta).toBe(2);
    expect(poll.positionsDelta).toBe(2);
  });
});

describe("michelada adapter — stats", () => {
  it("reports the poll's deltas, which the daemon sums", () => {
    expect(buildStatsMessage(7, 3)).toEqual({
      type: "stats",
      protocol: "adsb",
      messagesReceived: 7,
      positionsDecoded: 3,
    });
  });

  it("omits the signal block, which michelada cannot measure", () => {
    expect(buildStatsMessage(7, 3)?.signal).toBeUndefined();
  });

  it("returns null for an empty poll so nothing is published", () => {
    expect(buildStatsMessage(0, 0)).toBeNull();
  });
});

describe("michelada adapter — CLI", () => {
  it("registers `adapter michelada` with its flags", async () => {
    const helpOutput = await execHelp(["adapter", "michelada"]);

    expect(helpOutput).toContain("--socket");
    expect(helpOutput).toContain("--url");
    expect(helpOutput).toContain("--source-id");
    expect(helpOutput).toContain("--poll-interval");
    expect(helpOutput).toContain("--no-auto-start");
    expect(helpOutput).toContain("MICHELADA_URL");
  }, 30_000);

  it("lists michelada alongside readsb under `adapter`", async () => {
    const helpOutput = await execHelp(["adapter"]);

    expect(helpOutput).toContain("michelada");
    expect(helpOutput).toContain("readsb");
  }, 30_000);
});

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Run tsx's entry point through node rather than the .bin shim, which is a
// shell script on POSIX and a .cmd on Windows (spawn rejects the latter).
const tsxCli = resolve(serverDir, "node_modules/tsx/dist/cli.mjs");

async function execHelp(args: Array<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [tsxCli, "src/cli.ts", ...args, "--help"], {
      cwd: serverDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout + stderr);
      } else {
        reject(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("Help command timed out"));
    }, 25000);
  });
}
