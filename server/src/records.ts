// pattern: Functional Core

import type { TrackedAircraft, StatsAccumulator } from "./tracker.js";

export type StrongRef = {
  readonly uri: string;
  readonly cid: string;
};

export type ProtocolBreakdownEntry = {
  readonly protocol: string;
  readonly messagesReceived: number;
  readonly positionsDecoded: number;
  readonly signal?: {
    readonly meanDbfs: number;
    readonly noiseDbfs: number;
    readonly strongCount: number;
  };
};

export type StationRecordOptions = {
  readonly displayName: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude?: number;
  readonly locationName?: string;
  readonly description?: string;
  readonly website?: string;
  readonly coverageRadiusNm?: number;
  readonly receiver?: string;
  readonly antenna?: string;
  readonly software?: string;
  readonly protocols?: ReadonlyArray<string>;
  readonly streamEndpoint?: string;
};

export function buildAircraftIdentityRecord(
  icaoHex: string,
  now: Date,
  category?: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    icaoHex,
    createdAt: now.toISOString(),
  };

  if (category !== undefined) {
    record["category"] = category;
  }

  return record;
}

export function buildFlightRecord(
  ac: Readonly<TrackedAircraft>,
  aircraftRef: StrongRef,
  batches: ReadonlyArray<StrongRef>,
  now: Date,
): Record<string, unknown> | null {
  if (ac.positionCount === 0) {
    return null;
  }

  if (batches.length === 0) {
    return null;
  }

  const messageCount = Math.max(0, ac.currentMessages - ac.initialMessages);

  const record: Record<string, unknown> = {
    aircraft: aircraftRef,
    firstSeen: ac.firstSeen.toISOString(),
    lastSeen: ac.lastSeen.toISOString(),
    batches,
    positionCount: ac.positionCount,
    messageCount,
    createdAt: now.toISOString(),
  };

  if (ac.callsign !== undefined) record["callsign"] = ac.callsign;
  if (ac.squawk !== undefined) record["squawk"] = ac.squawk;

  if (ac.initial.altitudeFt !== undefined) record["initialAltitudeFt"] = ac.initial.altitudeFt;
  if (ac.initial.headingDeg !== undefined) record["initialHeadingDeg"] = ac.initial.headingDeg;
  if (ac.initial.groundSpeedKts !== undefined) record["initialGroundSpeedKts"] = ac.initial.groundSpeedKts;
  if (ac.initial.verticalRateFpm !== undefined) record["initialVerticalRateFpm"] = ac.initial.verticalRateFpm;

  if (ac.final.altitudeFt !== undefined) record["finalAltitudeFt"] = ac.final.altitudeFt;
  if (ac.final.headingDeg !== undefined) record["finalHeadingDeg"] = ac.final.headingDeg;
  if (ac.final.groundSpeedKts !== undefined) record["finalGroundSpeedKts"] = ac.final.groundSpeedKts;
  if (ac.final.verticalRateFpm !== undefined) record["finalVerticalRateFpm"] = ac.final.verticalRateFpm;

  if (ac.maxRangeNm !== null) record["maxRangeNm"] = ac.maxRangeNm.toFixed(1);

  return record;
}

export function buildStatsRecord(
  stats: Readonly<StatsAccumulator>,
  periodEnd: Date,
  now: Date,
  protocolBreakdown?: ReadonlyArray<ProtocolBreakdownEntry>,
): Record<string, unknown> {
  const messagesReceived = protocolBreakdown !== undefined && protocolBreakdown.length > 0
    ? protocolBreakdown.reduce((sum, entry) => sum + entry.messagesReceived, 0)
    : Math.max(0, stats.messagesAtLastPoll - stats.messagesAtPeriodStart);

  const record: Record<string, unknown> = {
    periodStart: stats.periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    aircraftSeen: stats.aircraftSeen.size,
    messagesReceived,
    createdAt: now.toISOString(),
  };

  if (stats.positionsReported > 0) {
    record["positionsReported"] = stats.positionsReported;
  }

  if (stats.maxRangeNm > 0) {
    record["maxRangeNm"] = stats.maxRangeNm.toFixed(1);
  }

  if (stats.signalSamples > 0) {
    const meanSignalDbfs = (stats.signalSum / stats.signalSamples).toFixed(1);
    const noiseLevelDbfs = (stats.noiseSum / stats.noiseSamples).toFixed(1);
    let strongSignalsPct: string | undefined;

    if (stats.totalMessages1min > 0) {
      strongSignalsPct = ((stats.strongSignals / stats.totalMessages1min) * 100).toFixed(1);
    }

    record["signalStats"] = {
      meanSignalDbfs,
      noiseLevelDbfs,
      ...(strongSignalsPct !== undefined ? { strongSignalsPct } : {}),
    };
  }

  if (protocolBreakdown !== undefined && protocolBreakdown.length > 0) {
    record["protocolBreakdown"] = Array.from(protocolBreakdown);
  }

  return record;
}

export function validateFlightRecord(record: Record<string, unknown>): boolean {
  const aircraft = record["aircraft"] as Record<string, unknown> | undefined;
  if (!aircraft || typeof aircraft["uri"] !== "string" || typeof aircraft["cid"] !== "string") {
    return false;
  }

  const batches = record["batches"];
  if (!Array.isArray(batches) || batches.length === 0) {
    return false;
  }

  for (const batch of batches) {
    if (
      typeof batch !== "object" ||
      batch === null ||
      typeof (batch as Record<string, unknown>)["uri"] !== "string" ||
      typeof (batch as Record<string, unknown>)["cid"] !== "string"
    ) {
      return false;
    }
  }

  if (!(record["firstSeen"] && typeof record["firstSeen"] === "string")) {
    return false;
  }

  if (!(record["lastSeen"] && typeof record["lastSeen"] === "string")) {
    return false;
  }

  if (!(record["createdAt"] && typeof record["createdAt"] === "string")) {
    return false;
  }

  return true;
}

export function buildStationRecord(
  opts: Readonly<StationRecordOptions>,
  now: Date,
): Record<string, unknown> {
  const protocolMap: Record<string, string> = {
    adsb: "at.adsb.receiver.station#adsb",
    mlat: "at.adsb.receiver.station#mlat",
    uat: "at.adsb.receiver.station#uat",
    acars: "at.adsb.receiver.station#acars",
    vdl2: "at.adsb.receiver.station#vdl2",
    hfdl: "at.adsb.receiver.station#hfdl",
  };

  const location: Record<string, unknown> = {
    $type: "community.lexicon.location.geo",
    latitude: String(opts.latitude),
    longitude: String(opts.longitude),
  };
  if (opts.altitude !== undefined) location["altitude"] = String(opts.altitude);
  if (opts.locationName !== undefined) location["name"] = opts.locationName;

  const record: Record<string, unknown> = {
    displayName: opts.displayName,
    location,
    status: "at.adsb.receiver.station#active",
    createdAt: now.toISOString(),
  };

  if (opts.description !== undefined) record["description"] = opts.description;
  if (opts.website !== undefined) record["website"] = opts.website;
  if (opts.streamEndpoint !== undefined) record["streamEndpoint"] = opts.streamEndpoint;
  if (opts.coverageRadiusNm !== undefined) record["coverageRadiusNm"] = opts.coverageRadiusNm;

  if (opts.receiver !== undefined || opts.antenna !== undefined || opts.software !== undefined) {
    const hw: Record<string, string> = {};
    if (opts.receiver !== undefined) hw["receiver"] = opts.receiver;
    if (opts.antenna !== undefined) hw["antenna"] = opts.antenna;
    if (opts.software !== undefined) hw["software"] = opts.software;
    record["hardware"] = hw;
  }

  if (opts.protocols !== undefined && opts.protocols.length > 0) {
    const protocols = opts.protocols
      .map((p) => p.trim().toLowerCase())
      .map((p) => {
        const mapped = protocolMap[p];
        if (!mapped) {
          throw new Error(
            `Unknown protocol: ${p}. Valid: ${Object.keys(protocolMap).join(", ")}`,
          );
        }
        return mapped;
      });
    record["protocols"] = protocols;
  }

  return record;
}
