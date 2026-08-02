// pattern: Functional Core

import type { MicheladaAircraft } from "../michelada.js";
import type { NormalizedAircraft, StatsMessage } from "../normalized.js";

// michelada only decodes DF17/DF18 extended squitters, so every fix it reports
// comes from the aircraft's own transponder. readsb labels those `adsb_icao`;
// reusing the label keeps telemetry `source` values comparable between adapters.
export const MICHELADA_SOURCE = "adsb_icao";

// michelada's aircraft table carries no per-aircraft signal power. readsb
// reports -49.5 dBFS as its RSSI floor for aircraft it has no measurement for,
// so consumers already read that value as "no signal information".
export const UNKNOWN_RSSI_DBFS = -49.5;

// How long synthesized counters survive after an aircraft drops out of
// michelada's table. michelada prunes at 60s and the daemon declares departure
// 60s after that, so retaining state a little longer keeps the message counter
// monotonic when an aircraft flickers out and back.
export const STATE_RETENTION_MS = 300_000;

// Per-aircraft state the adapter carries between polls. michelada reports a
// point-in-time table with no counters, so freshness has to be derived by
// diffing consecutive snapshots.
export type MicheladaAircraftState = {
  readonly lat?: number;
  readonly lon?: number;
  // Wall-clock ms of the fix the current lat/lon came from.
  readonly positionFixMs?: number;
  readonly messages: number;
  readonly lastObservedMs: number;
};

export type MicheladaMapped = {
  readonly aircraft: NormalizedAircraft;
  readonly state: MicheladaAircraftState;
  readonly messagesDelta: number;
  readonly positionsDelta: number;
};

export type MicheladaPoll = {
  readonly aircraft: ReadonlyArray<NormalizedAircraft>;
  readonly states: ReadonlyMap<string, MicheladaAircraftState>;
  readonly messagesDelta: number;
  readonly positionsDelta: number;
};

function finite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Maps one michelada aircraft row to a normalized aircraft, deriving the fields
 * michelada does not report from the previous snapshot of the same aircraft.
 *
 * `elapsedS` is the wall-clock gap since the previous poll (Infinity on the
 * first poll). Returns null for rows without a usable ICAO address.
 */
export function mapMicheladaAircraft(
  entry: Readonly<MicheladaAircraft>,
  prev: MicheladaAircraftState | undefined,
  nowMs: number,
  elapsedS: number,
): MicheladaMapped | null {
  const icaoHex =
    typeof entry.icao === "string" ? entry.icao.trim().toUpperCase() : "";
  if (!/^[0-9A-F]{6}$/.test(icaoHex)) {
    return null;
  }

  const seen = finite(entry.last_seen) ?? 0;

  // michelada reports seconds since the last message but no message counter. A
  // last_seen smaller than the poll gap means at least one message arrived since
  // the previous poll, so this counter is a lower bound on messages received --
  // several messages inside one poll interval count once.
  const messagesDelta = prev === undefined ? 1 : seen < elapsedS ? 1 : 0;
  const messages = (prev?.messages ?? 0) + messagesDelta;

  const lat = finite(entry.lat);
  const lon = finite(entry.lon);
  const hasPosition = lat !== undefined && lon !== undefined;

  // A changed lat/lon is the only evidence of a new fix. The fix itself arrived
  // no later than the aircraft's last message, so `now - last_seen` is a closer
  // estimate of when it happened than the poll time.
  const isNewFix =
    hasPosition &&
    (prev?.positionFixMs === undefined || prev.lat !== lat || prev.lon !== lon);
  const positionFixMs = !hasPosition
    ? undefined
    : isNewFix
      ? nowMs - seen * 1000
      : prev?.positionFixMs;

  const seenPos =
    positionFixMs !== undefined
      ? Math.max(0, (nowMs - positionFixMs) / 1000)
      : undefined;

  const callsign = entry.callsign?.trim();
  const track = finite(entry.heading);
  const gs = finite(entry.speed);

  const aircraft: NormalizedAircraft = {
    icaoHex,
    source: MICHELADA_SOURCE,
    seen,
    rssi: UNKNOWN_RSSI_DBFS,
    messages,
    // michelada decodes identification, position and velocity only -- no
    // altitude, squawk, category or NIC/Rc, so those stay absent.
    ...(hasPosition && { lat, lon }),
    ...(seenPos !== undefined && { seenPos }),
    ...(hasPosition && { newPosition: isNewFix }),
    ...(callsign && { flight: callsign }),
    ...(track !== undefined && { track }),
    ...(gs !== undefined && { gs }),
  };

  return {
    aircraft,
    state: {
      ...(lat !== undefined && { lat }),
      ...(lon !== undefined && { lon }),
      ...(positionFixMs !== undefined && { positionFixMs }),
      messages,
      lastObservedMs: nowMs,
    },
    messagesDelta,
    positionsDelta: isNewFix ? 1 : 0,
  };
}

/**
 * Maps a full michelada snapshot, carrying per-aircraft state forward. State for
 * aircraft missing from this snapshot is retained for STATE_RETENTION_MS so
 * counters survive a brief dropout, then pruned.
 */
export function mapMicheladaPoll(
  snapshot: ReadonlyArray<MicheladaAircraft>,
  prevStates: ReadonlyMap<string, MicheladaAircraftState>,
  nowMs: number,
  elapsedS: number,
): MicheladaPoll {
  const aircraft: Array<NormalizedAircraft> = [];
  const states = new Map<string, MicheladaAircraftState>();
  let messagesDelta = 0;
  let positionsDelta = 0;

  for (const entry of snapshot) {
    const icaoHex =
      typeof entry.icao === "string" ? entry.icao.trim().toUpperCase() : "";
    const mapped = mapMicheladaAircraft(
      entry,
      prevStates.get(icaoHex),
      nowMs,
      elapsedS,
    );
    if (mapped === null) {
      continue;
    }

    aircraft.push(mapped.aircraft);
    states.set(mapped.aircraft.icaoHex, mapped.state);
    messagesDelta += mapped.messagesDelta;
    positionsDelta += mapped.positionsDelta;
  }

  for (const [hex, state] of prevStates) {
    if (states.has(hex)) continue;
    if (nowMs - state.lastObservedMs <= STATE_RETENTION_MS) {
      states.set(hex, state);
    }
  }

  return { aircraft, states, messagesDelta, positionsDelta };
}

// The daemon sums the stats it receives, so each poll reports only its own
// delta. michelada exposes no signal or noise measurement, so the optional
// `signal` block is omitted rather than filled with placeholders.
export function buildStatsMessage(
  messagesDelta: number,
  positionsDelta: number,
): StatsMessage | null {
  if (messagesDelta === 0 && positionsDelta === 0) {
    return null;
  }

  return {
    type: "stats",
    protocol: "adsb",
    messagesReceived: messagesDelta,
    positionsDecoded: positionsDelta,
  };
}
