// pattern: Imperative Shell

import type { NormalizedAircraft } from "./normalized.js";

export type PositionReport = {
  readonly latitude: string;
  readonly longitude: string;
  readonly timestamp: string;
  readonly source: string;
  readonly altitudeFt?: number;
  readonly groundSpeedKts?: string;
  readonly trackDeg?: string;
  readonly verticalRateFpm?: number;
};

export type AircraftSnapshot = {
  readonly altitudeFt?: number;
  readonly headingDeg?: string;
  readonly groundSpeedKts?: string;
  readonly verticalRateFpm?: number;
};

export type TrackedAircraft = {
  readonly icaoHex: string;
  readonly callsign?: string;
  readonly category?: string;
  readonly squawk?: string;
  readonly qnhHpa?: string;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly positionCount: number;
  readonly lastSeenPos: number | null;
  readonly initialMessages: number;
  readonly currentMessages: number;
  readonly maxRangeNm: number | null;
  readonly initial: AircraftSnapshot;
  readonly final: AircraftSnapshot;
  readonly track: ReadonlyArray<PositionReport>;
};


type MutableAircraftSnapshot = {
  altitudeFt?: number;
  headingDeg?: string;
  groundSpeedKts?: string;
  verticalRateFpm?: number;
};

type MutableTrackedAircraft = {
  icaoHex: string;
  callsign?: string;
  category?: string;
  squawk?: string;
  qnhHpa?: string;
  firstSeen: Date;
  lastSeen: Date;
  positionCount: number;
  lastSeenPos: number | null;
  initialMessages: number;
  currentMessages: number;
  maxRangeNm: number | null;
  initial: MutableAircraftSnapshot;
  final: MutableAircraftSnapshot;
  track: Array<PositionReport>;
};

export type UpdateResult = {
  readonly departed: ReadonlyArray<TrackedAircraft>;
  readonly positions: ReadonlyMap<string, ReadonlyArray<PositionReport>>;
};

export type StatsAccumulator = {
  periodStart: Date;
  aircraftSeen: Set<string>;
  messagesAtPeriodStart: number;
  messagesAtLastPoll: number;
  positionsReported: number;
  maxRangeNm: number;
  signalSum: number;
  signalSamples: number;
  noiseSum: number;
  noiseSamples: number;
  strongSignals: number;
  totalMessages1min: number;
};

function buildSnapshot(ac: NormalizedAircraft): MutableAircraftSnapshot {
  return {
    altitudeFt: typeof ac.altBaro === "number" ? ac.altBaro : undefined,
    headingDeg: ac.track != null ? String(ac.track) : undefined,
    groundSpeedKts: ac.gs != null ? String(ac.gs) : undefined,
    verticalRateFpm: ac.baroRate ?? undefined,
  };
}

function snapshotHasData(s: MutableAircraftSnapshot): boolean {
  return s.altitudeFt !== undefined
    || s.headingDeg !== undefined
    || s.groundSpeedKts !== undefined
    || s.verticalRateFpm !== undefined;
}

export class AircraftTracker {
  private tracked = new Map<string, MutableTrackedAircraft>();

  constructor(
    private readonly receiverLat: number,
    private readonly receiverLon: number,
  ) {}

  update(aircraft: ReadonlyArray<NormalizedAircraft>, nowEpoch: number): UpdateResult {
    const departed: Array<TrackedAircraft> = [];
    const positionsAdded = new Map<string, Array<PositionReport>>();
    const currentHexes = new Set<string>();
    const now = new Date(nowEpoch * 1000);

    for (const ac of aircraft) {
      currentHexes.add(ac.icaoHex);
    }

    for (const ac of aircraft) {
      const hex = ac.icaoHex;
      const existing = this.tracked.get(hex);

      if (existing) {
        existing.lastSeen = now;

        if (ac.flight?.trim()) {
          existing.callsign = ac.flight.trim();
        }

        existing.currentMessages = ac.messages;

        if (ac.category) existing.category = ac.category;
        if (ac.squawk) existing.squawk = ac.squawk;
        if (ac.navQnh != null) existing.qnhHpa = String(ac.navQnh);

        const snap = buildSnapshot(ac);
        if (snapshotHasData(snap)) {
          if (!snapshotHasData(existing.initial)) {
            existing.initial = { ...snap };
          }
          existing.final = snap;
        }

        if (ac.lat != null && ac.lon != null && ac.seenPos != null) {
          // Adapters that diff snapshots know when a fix is new and say so;
          // otherwise infer it from the reported fix age falling.
          const isNewFix = ac.newPosition
            ?? (existing.lastSeenPos === null || ac.seenPos < existing.lastSeenPos);
          if (isNewFix) {
            existing.positionCount++;
            existing.lastSeenPos = ac.seenPos;

            const report: PositionReport = {
              latitude: String(ac.lat),
              longitude: String(ac.lon),
              timestamp: new Date((nowEpoch - ac.seenPos) * 1000).toISOString(),
              source: ac.source,
              altitudeFt: typeof ac.altBaro === 'number' ? ac.altBaro : undefined,
              groundSpeedKts: ac.gs != null ? String(ac.gs) : undefined,
              trackDeg: ac.track != null ? String(ac.track) : undefined,
              verticalRateFpm: ac.baroRate ?? undefined,
            };
            existing.track.push(report);

            // Track positions added this cycle for batch accumulation
            const hexPositions = positionsAdded.get(hex) ?? [];
            hexPositions.push(report);
            positionsAdded.set(hex, hexPositions);
          }
        }

        if (ac.lat != null && ac.lon != null) {
          const range = this.haversineNm(
            this.receiverLat,
            this.receiverLon,
            ac.lat,
            ac.lon,
          );
          if (existing.maxRangeNm == null || range > existing.maxRangeNm) {
            existing.maxRangeNm = range;
          }
        }
      } else {
        const snapshot = buildSnapshot(ac);
        const entry: MutableTrackedAircraft = {
          icaoHex: hex,
          firstSeen: now,
          lastSeen: now,
          positionCount: 0,
          lastSeenPos: null,
          initialMessages: ac.messages,
          currentMessages: ac.messages,
          maxRangeNm: null,
          initial: { ...snapshot },
          final: snapshot,
          track: [],
        };

        if (ac.flight?.trim()) {
          entry.callsign = ac.flight.trim();
        }

        if (ac.category) entry.category = ac.category;
        if (ac.squawk) entry.squawk = ac.squawk;
        if (ac.navQnh != null) entry.qnhHpa = String(ac.navQnh);

        if (ac.lat != null && ac.lon != null) {
          if (ac.seenPos != null) {
            entry.positionCount = 1;
            entry.lastSeenPos = ac.seenPos;

            const report: PositionReport = {
              latitude: String(ac.lat),
              longitude: String(ac.lon),
              timestamp: new Date((nowEpoch - ac.seenPos) * 1000).toISOString(),
              source: ac.source,
              altitudeFt: typeof ac.altBaro === 'number' ? ac.altBaro : undefined,
              groundSpeedKts: ac.gs != null ? String(ac.gs) : undefined,
              trackDeg: ac.track != null ? String(ac.track) : undefined,
              verticalRateFpm: ac.baroRate ?? undefined,
            };
            entry.track.push(report);

            // Track positions added this cycle for batch accumulation
            const hexPositions = positionsAdded.get(hex) ?? [];
            hexPositions.push(report);
            positionsAdded.set(hex, hexPositions);
          }

          entry.maxRangeNm = this.haversineNm(
            this.receiverLat,
            this.receiverLon,
            ac.lat,
            ac.lon,
          );
        }

        this.tracked.set(hex, entry);
      }
    }

    // Departure detection: absent for 60+ seconds (multi-adapter threshold)
    const departureThresholdMs = 60_000;
    const hexesToDelete: Array<string> = [];
    for (const [hex, entry] of this.tracked) {
      if (!currentHexes.has(hex)) {
        const absentMs = now.getTime() - entry.lastSeen.getTime();
        if (absentMs >= departureThresholdMs) {
          departed.push(entry as TrackedAircraft);
          hexesToDelete.push(hex);
        }
      }
    }
    for (const hex of hexesToDelete) {
      this.tracked.delete(hex);
    }

    return { departed, positions: positionsAdded };
  }

  getTracked(hex: string): Readonly<TrackedAircraft> | undefined {
    return this.tracked.get(hex.toUpperCase());
  }

  getAllTrackedHexes(): ReadonlySet<string> {
    return new Set(this.tracked.keys());
  }

  getCurrentMaxRange(): number {
    let max = 0;
    for (const entry of this.tracked.values()) {
      if (entry.maxRangeNm != null && entry.maxRangeNm > max) {
        max = entry.maxRangeNm;
      }
    }
    return max;
  }

  private haversineNm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 3440.065;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

export function createStatsAccumulator(): StatsAccumulator {
  return {
    periodStart: new Date(),
    aircraftSeen: new Set(),
    messagesAtPeriodStart: 0,
    messagesAtLastPoll: 0,
    positionsReported: 0,
    maxRangeNm: 0,
    signalSum: 0,
    signalSamples: 0,
    noiseSum: 0,
    noiseSamples: 0,
    strongSignals: 0,
    totalMessages1min: 0,
  };
}
