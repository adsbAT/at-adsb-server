import { describe, it, expect } from "vitest";
import {
  buildFlightRecord,
  buildStatsRecord,
  buildStationRecord,
  validateFlightRecord,
  type StationRecordOptions,
  type StrongRef,
} from "../records.js";
import type { TrackedAircraft, StatsAccumulator, PositionReport, AircraftSnapshot } from "../tracker.js";

const mockRef: StrongRef = {
  uri: "at://did:plc:test/at.adsb.aircraft.identity/tid123",
  cid: "bafyreig123",
};

// Helper functions to build mock objects
function createMockTrackedAircraft(overrides?: Partial<TrackedAircraft>): TrackedAircraft {
  return {
    icaoHex: "A1B2C3",
    callsign: "UAL456",
    firstSeen: new Date("2026-05-23T10:00:00Z"),
    lastSeen: new Date("2026-05-23T10:05:00Z"),
    positionCount: 5,
    lastSeenPos: 100,
    initialMessages: 50,
    currentMessages: 150,
    maxRangeNm: 123.456,
    initial: { altitudeFt: 35000, headingDeg: "180", groundSpeedKts: "450", verticalRateFpm: -500 },
    final: { altitudeFt: 30000, headingDeg: "175", groundSpeedKts: "440", verticalRateFpm: -200 },
    track: [
      {
        latitude: "37.5",
        longitude: "-122.5",
        timestamp: "2026-05-23T10:00:00Z",
        source: "adsb_icao",
      },
    ] as ReadonlyArray<PositionReport>,
    ...overrides,
  };
}

function createMockStatsAccumulator(overrides?: Partial<StatsAccumulator>): StatsAccumulator {
  return {
    periodStart: new Date("2026-05-23T10:00:00Z"),
    aircraftSeen: new Set(["A1B2C3", "D4E5F6"]),
    messagesAtPeriodStart: 100,
    messagesAtLastPoll: 250,
    positionsReported: 10,
    maxRangeNm: 150.5,
    signalSum: 1000,
    signalSamples: 20,
    noiseSum: 400,
    noiseSamples: 20,
    strongSignals: 15,
    totalMessages1min: 100,
    ...overrides,
  };
}

describe("records — flight, stats, and station record builders", () => {
  const fixedNow = new Date("2026-05-23T12:00:00Z");

  const mockBatch1: StrongRef = {
    uri: "at://did:plc:test/at.adsb.receiver.sighting/abc123",
    cid: "bafyreiabc123",
  };

  const mockBatch2: StrongRef = {
    uri: "at://did:plc:test/at.adsb.receiver.sighting/def456",
    cid: "bafyreidef456",
  };

  describe("buildFlightRecord", () => {
    describe("provenance-chain.AC2.1 — required fields and types", () => {
      it("contains aircraft as strongRef", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record).not.toBeNull();
        expect(record!["aircraft"]).toEqual(mockRef);
      });

      it("contains batches array with strongRefs", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1, mockBatch2], fixedNow);

        expect(record).not.toBeNull();
        expect(Array.isArray(record!["batches"])).toBe(true);
        expect(record!["batches"]).toEqual([mockBatch1, mockBatch2]);
      });

      it("contains firstSeen as ISO datetime string", () => {
        const ac = createMockTrackedAircraft({
          firstSeen: new Date("2026-05-23T10:00:00Z"),
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(typeof record!["firstSeen"]).toBe("string");
        expect(record!["firstSeen"]).toBe("2026-05-23T10:00:00.000Z");
      });

      it("contains lastSeen as ISO datetime string", () => {
        const ac = createMockTrackedAircraft({
          lastSeen: new Date("2026-05-23T10:05:00Z"),
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(typeof record!["lastSeen"]).toBe("string");
        expect(record!["lastSeen"]).toBe("2026-05-23T10:05:00.000Z");
      });

      it("contains createdAt as ISO datetime string", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(typeof record!["createdAt"]).toBe("string");
        expect(record!["createdAt"]).toBe("2026-05-23T12:00:00.000Z");
      });

      it("has all required fields present", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["aircraft"]).toBeDefined();
        expect(record!["batches"]).toBeDefined();
        expect(record!["firstSeen"]).toBeDefined();
        expect(record!["lastSeen"]).toBeDefined();
        expect(record!["createdAt"]).toBeDefined();
      });
    });

    describe("provenance-chain.AC2.4 — position and message counts", () => {
      it("includes positionCount as integer >= 0", () => {
        const ac = createMockTrackedAircraft({ positionCount: 5 });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(Number.isInteger(record!["positionCount"])).toBe(true);
        expect(record!["positionCount"]).toBe(5);
        expect(record!["positionCount"]).toBeGreaterThanOrEqual(0);
      });

      it("includes messageCount as integer >= 0", () => {
        const ac = createMockTrackedAircraft({
          initialMessages: 50,
          currentMessages: 150,
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(Number.isInteger(record!["messageCount"])).toBe(true);
        expect(record!["messageCount"]).toBe(100);
        expect(record!["messageCount"]).toBeGreaterThanOrEqual(0);
      });

      it("clamps messageCount to 0 when delta is negative (readsb restart)", () => {
        const ac = createMockTrackedAircraft({
          initialMessages: 150,
          currentMessages: 50,
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["messageCount"]).toBe(0);
      });
    });

    describe("provenance-chain.AC2.4 — optional snapshot fields", () => {
      it("includes initial snapshot fields when present", () => {
        const ac = createMockTrackedAircraft({
          initial: {
            altitudeFt: 35000,
            headingDeg: "180",
            groundSpeedKts: "450",
            verticalRateFpm: -500,
          },
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["initialAltitudeFt"]).toBe(35000);
        expect(record!["initialHeadingDeg"]).toBe("180");
        expect(record!["initialGroundSpeedKts"]).toBe("450");
        expect(record!["initialVerticalRateFpm"]).toBe(-500);
      });

      it("includes final snapshot fields when present", () => {
        const ac = createMockTrackedAircraft({
          final: {
            altitudeFt: 30000,
            headingDeg: "175",
            groundSpeedKts: "440",
            verticalRateFpm: -200,
          },
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["finalAltitudeFt"]).toBe(30000);
        expect(record!["finalHeadingDeg"]).toBe("175");
        expect(record!["finalGroundSpeedKts"]).toBe("440");
        expect(record!["finalVerticalRateFpm"]).toBe(-200);
      });

      it("omits snapshot fields when undefined", () => {
        const ac = createMockTrackedAircraft({
          initial: {},
          final: {},
        });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["initialAltitudeFt"]).toBeUndefined();
        expect(record!["initialHeadingDeg"]).toBeUndefined();
        expect(record!["finalAltitudeFt"]).toBeUndefined();
        expect(record!["finalHeadingDeg"]).toBeUndefined();
      });
    });

    describe("provenance-chain.AC2.4 — maxRangeNm and optional fields", () => {
      it("formats maxRangeNm to 1 decimal place as string", () => {
        const ac = createMockTrackedAircraft({ maxRangeNm: 123.456 });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["maxRangeNm"]).toBe("123.5");
        expect(typeof record!["maxRangeNm"]).toBe("string");
      });

      it("omits maxRangeNm field when null", () => {
        const ac = createMockTrackedAircraft({ maxRangeNm: null });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["maxRangeNm"]).toBeUndefined();
      });

      it("includes callsign when present", () => {
        const ac = createMockTrackedAircraft({ callsign: "UAL456" });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["callsign"]).toBe("UAL456");
      });

      it("omits callsign field when undefined", () => {
        const ac = createMockTrackedAircraft({ callsign: undefined });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["callsign"]).toBeUndefined();
      });

      it("includes squawk when present", () => {
        const ac = createMockTrackedAircraft({ squawk: "1234" });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["squawk"]).toBe("1234");
      });

      it("omits squawk field when undefined", () => {
        const ac = createMockTrackedAircraft({ squawk: undefined });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record!["squawk"]).toBeUndefined();
      });
    });

    describe("provenance-chain.AC2.5 — zero-position aircraft", () => {
      it("returns null when positionCount is 0", () => {
        const ac = createMockTrackedAircraft({ positionCount: 0 });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record).toBeNull();
      });

      it("returns null when batches array is empty", () => {
        const ac = createMockTrackedAircraft({ positionCount: 5 });
        const record = buildFlightRecord(ac, mockRef, [], fixedNow);

        expect(record).toBeNull();
      });

      it("returns record when positionCount > 0 and batches not empty", () => {
        const ac = createMockTrackedAircraft({ positionCount: 1 });
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(record).not.toBeNull();
        expect(record!["positionCount"]).toBe(1);
      });
    });

    describe("provenance-chain.AC3.2 — strongRef validation", () => {
      it("aircraft ref is strongRef with uri and cid", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        const aircraft = record!["aircraft"] as Record<string, unknown>;
        expect(typeof aircraft["uri"]).toBe("string");
        expect(typeof aircraft["cid"]).toBe("string");
      });

      it("batch refs are strongRefs with uri and cid", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1, mockBatch2], fixedNow);

        const batches = record!["batches"] as Array<Record<string, unknown>>;
        expect(batches.length).toBe(2);
        batches.forEach((batch) => {
          expect(typeof batch["uri"]).toBe("string");
          expect(typeof batch["cid"]).toBe("string");
        });
      });
    });
  });

  describe("validateFlightRecord", () => {
    describe("provenance-chain.AC2.1, AC3.2 — validation", () => {
      it("validateFlightRecord returns true for complete valid record", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);

        expect(validateFlightRecord(record!)).toBe(true);
      });

      it("validateFlightRecord returns false when aircraft missing", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        delete record!["aircraft"];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when aircraft has missing uri", () => {
        const record: Record<string, unknown> = {
          aircraft: { uri: undefined, cid: "bafyreitest" },
          batches: [mockBatch1],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when aircraft has missing cid", () => {
        const record: Record<string, unknown> = {
          aircraft: { uri: "at://test", cid: undefined },
          batches: [mockBatch1],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batches missing", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        delete record!["batches"];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when batches is empty array", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        record!["batches"] = [];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when batches is not an array", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        record!["batches"] = "not-an-array";

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when firstSeen missing", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        delete record!["firstSeen"];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when lastSeen missing", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        delete record!["lastSeen"];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when createdAt missing", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        delete record!["createdAt"];

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when firstSeen is not a string", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        record!["firstSeen"] = new Date();

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when lastSeen is not a string", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        record!["lastSeen"] = new Date();

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when createdAt is not a string", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1], fixedNow);
        record!["createdAt"] = 123456789;

        expect(validateFlightRecord(record!)).toBe(false);
      });

      it("validateFlightRecord returns false when batch entry is missing uri", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [{ uri: undefined, cid: "bafyreitest" }],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batch entry is missing cid", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [{ uri: "at://test", cid: undefined }],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batch entry has non-string uri", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [{ uri: 123, cid: "bafyreitest" }],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batch entry has non-string cid", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [{ uri: "at://test", cid: { nested: "object" } }],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batches array contains primitive value", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [mockBatch1, "not-an-object"],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns false when batches array contains null", () => {
        const record: Record<string, unknown> = {
          aircraft: mockRef,
          batches: [mockBatch1, null],
          firstSeen: "2026-05-23T10:00:00Z",
          lastSeen: "2026-05-23T10:05:00Z",
          createdAt: "2026-05-23T12:00:00Z",
        };

        expect(validateFlightRecord(record)).toBe(false);
      });

      it("validateFlightRecord returns true when all batch entries have valid strongRefs", () => {
        const ac = createMockTrackedAircraft();
        const record = buildFlightRecord(ac, mockRef, [mockBatch1, mockBatch2], fixedNow);

        expect(validateFlightRecord(record!)).toBe(true);
      });
    });
  });

  describe("buildStatsRecord", () => {
    describe("at-adsb-cmd.AC2.1 — required fields", () => {
      it("contains periodStart as ISO datetime string", () => {
        const stats = createMockStatsAccumulator({
          periodStart: new Date("2026-05-23T10:00:00Z"),
        });
        const periodEnd = new Date("2026-05-23T11:00:00Z");
        const record = buildStatsRecord(stats, periodEnd, fixedNow);

        expect(record["periodStart"]).toBe("2026-05-23T10:00:00.000Z");
        expect(typeof record["periodStart"]).toBe("string");
      });

      it("contains periodEnd as ISO datetime string", () => {
        const stats = createMockStatsAccumulator();
        const periodEnd = new Date("2026-05-23T11:00:00Z");
        const record = buildStatsRecord(stats, periodEnd, fixedNow);

        expect(record["periodEnd"]).toBe("2026-05-23T11:00:00.000Z");
        expect(typeof record["periodEnd"]).toBe("string");
      });

      it("contains aircraftSeen as integer", () => {
        const stats = createMockStatsAccumulator({
          aircraftSeen: new Set(["A1B2C3", "D4E5F6", "G7H8I9"]),
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(Number.isInteger(record["aircraftSeen"])).toBe(true);
        expect(record["aircraftSeen"]).toBe(3);
      });

      it("contains messagesReceived as integer", () => {
        const stats = createMockStatsAccumulator({
          messagesAtPeriodStart: 100,
          messagesAtLastPoll: 250,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(Number.isInteger(record["messagesReceived"])).toBe(true);
        expect(record["messagesReceived"]).toBe(150);
      });

      it("contains createdAt as ISO datetime string", () => {
        const stats = createMockStatsAccumulator();
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(typeof record["createdAt"]).toBe("string");
        expect(record["createdAt"]).toBe("2026-05-23T12:00:00.000Z");
      });

      it("clamps messagesReceived to 0 when delta is negative", () => {
        const stats = createMockStatsAccumulator({
          messagesAtPeriodStart: 250,
          messagesAtLastPoll: 100,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["messagesReceived"]).toBe(0);
      });
    });

    describe("at-adsb-cmd.AC2.2 — signalStats formatting", () => {
      it("includes signalStats with string fields when signal data available", () => {
        const stats = createMockStatsAccumulator({
          signalSum: 1000,
          signalSamples: 20,
          noiseSum: 400,
          noiseSamples: 20,
          strongSignals: 15,
          totalMessages1min: 100,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["signalStats"]).toBeDefined();
        const signalStats = record["signalStats"] as any;
        expect(signalStats.meanSignalDbfs).toBe("50.0");
        expect(signalStats.noiseLevelDbfs).toBe("20.0");
        expect(signalStats.strongSignalsPct).toBe("15.0");
      });

      it("formats meanSignalDbfs to 1 decimal place", () => {
        const stats = createMockStatsAccumulator({
          signalSum: 1234,
          signalSamples: 50,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        const signalStats = record["signalStats"] as any;
        expect(signalStats.meanSignalDbfs).toBe("24.7");
      });

      it("formats noiseLevelDbfs to 1 decimal place", () => {
        const stats = createMockStatsAccumulator({
          noiseSum: 567,
          noiseSamples: 30,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        const signalStats = record["signalStats"] as any;
        expect(signalStats.noiseLevelDbfs).toBe("18.9");
      });

      it("formats strongSignalsPct to 1 decimal place", () => {
        const stats = createMockStatsAccumulator({
          strongSignals: 12,
          totalMessages1min: 80,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        const signalStats = record["signalStats"] as any;
        expect(signalStats.strongSignalsPct).toBe("15.0");
      });

      it("omits signalStats when signalSamples is 0", () => {
        const stats = createMockStatsAccumulator({
          signalSamples: 0,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["signalStats"]).toBeUndefined();
      });

      it("all fields in signalStats are strings", () => {
        const stats = createMockStatsAccumulator({
          signalSum: 1000,
          signalSamples: 20,
          noiseSum: 400,
          noiseSamples: 20,
          strongSignals: 15,
          totalMessages1min: 100,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        const signalStats = record["signalStats"] as any;
        expect(typeof signalStats.meanSignalDbfs).toBe("string");
        expect(typeof signalStats.noiseLevelDbfs).toBe("string");
        expect(typeof signalStats.strongSignalsPct).toBe("string");
      });
    });

    describe("at-adsb-cmd.AC2.3 — maxRangeNm formatting", () => {
      it("includes maxRangeNm as string when > 0", () => {
        const stats = createMockStatsAccumulator({ maxRangeNm: 150.5 });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["maxRangeNm"]).toBe("150.5");
        expect(typeof record["maxRangeNm"]).toBe("string");
      });

      it("omits maxRangeNm when 0", () => {
        const stats = createMockStatsAccumulator({ maxRangeNm: 0 });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["maxRangeNm"]).toBeUndefined();
      });

      it("formats to 1 decimal place", () => {
        const stats = createMockStatsAccumulator({ maxRangeNm: 99.999 });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["maxRangeNm"]).toBe("100.0");
      });
    });

    describe("at-adsb-cmd.AC2.5 — empty stats", () => {
      it("publishes stats with zero aircraft seen", () => {
        const stats = createMockStatsAccumulator({
          aircraftSeen: new Set(),
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["aircraftSeen"]).toBe(0);
        expect(record["periodStart"]).toBeDefined();
        expect(record["periodEnd"]).toBeDefined();
        expect(record["createdAt"]).toBeDefined();
      });

      it("does not omit fields when empty", () => {
        const stats = createMockStatsAccumulator({
          aircraftSeen: new Set(),
          positionsReported: 0,
          maxRangeNm: 0,
          signalSamples: 0,
        });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["aircraftSeen"]).toBeDefined();
        expect(record["messagesReceived"]).toBeDefined();
        expect(record["periodStart"]).toBeDefined();
      });
    });

    describe("optional fields", () => {
      it("includes positionsReported when > 0", () => {
        const stats = createMockStatsAccumulator({ positionsReported: 10 });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["positionsReported"]).toBe(10);
      });

      it("omits positionsReported when 0", () => {
        const stats = createMockStatsAccumulator({ positionsReported: 0 });
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["positionsReported"]).toBeUndefined();
      });
    });

    describe("multi-input-adapters.AC7 — protocolBreakdown", () => {
      it("includes protocolBreakdown array when provided (AC7.1)", () => {
        const stats = createMockStatsAccumulator();
        const protocolBreakdown = [
          {
            protocol: "adsb",
            messagesReceived: 100,
            positionsDecoded: 50,
          },
        ];
        const record = buildStatsRecord(stats, fixedNow, fixedNow, protocolBreakdown);

        expect(Array.isArray(record["protocolBreakdown"])).toBe(true);
        expect(record["protocolBreakdown"]).toEqual(protocolBreakdown);
      });

      it("merges multiple adapters' stats into one record (AC7.2)", () => {
        const stats = createMockStatsAccumulator();
        const protocolBreakdown = [
          {
            protocol: "adsb",
            messagesReceived: 100,
            positionsDecoded: 50,
          },
          {
            protocol: "uat",
            messagesReceived: 60,
            positionsDecoded: 30,
          },
        ];
        const record = buildStatsRecord(stats, fixedNow, fixedNow, protocolBreakdown);

        expect(record["protocolBreakdown"]).toHaveLength(2);
        expect(record["protocolBreakdown"]).toEqual(protocolBreakdown);
      });

      it("omits protocolBreakdown when empty array (AC7.3)", () => {
        const stats = createMockStatsAccumulator();
        const protocolBreakdown: any[] = [];
        const record = buildStatsRecord(stats, fixedNow, fixedNow, protocolBreakdown);

        expect(record["protocolBreakdown"]).toBeUndefined();
      });

      it("omits protocolBreakdown when not provided", () => {
        const stats = createMockStatsAccumulator();
        const record = buildStatsRecord(stats, fixedNow, fixedNow);

        expect(record["protocolBreakdown"]).toBeUndefined();
      });

      it("includes signal data in protocolBreakdown entries when present", () => {
        const stats = createMockStatsAccumulator();
        const protocolBreakdown = [
          {
            protocol: "adsb",
            messagesReceived: 100,
            positionsDecoded: 50,
            signal: { meanDbfs: -5, noiseDbfs: -20, strongCount: 25 },
          },
        ];
        const record = buildStatsRecord(stats, fixedNow, fixedNow, protocolBreakdown);

        const breakdown = record["protocolBreakdown"] as any[];
        expect(breakdown[0].signal).toEqual({
          meanDbfs: -5,
          noiseDbfs: -20,
          strongCount: 25,
        });
      });
    });
  });

  describe("buildStationRecord", () => {
    it("builds minimal station record with required fields", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["displayName"]).toBe("Test Station");
      // Decimal-degree strings: atproto has no float type, and a PDS rejects
      // numeric coordinates.
      expect((record["location"] as any).latitude).toBe("37.5");
      expect((record["location"] as any).longitude).toBe("-122.5");
      expect((record["location"] as any).$type).toBe("community.lexicon.location.geo");
      expect(record["status"]).toBe("at.adsb.receiver.station#active");
      expect(record["createdAt"]).toBe("2026-05-23T12:00:00.000Z");
    });

    it("includes optional location fields when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        altitude: 100,
        locationName: "Bay Area",
      };

      const record = buildStationRecord(opts, fixedNow);
      const location = record["location"] as any;

      expect(location.altitude).toBe("100");
      expect(location.name).toBe("Bay Area");
    });

    it("includes description and website when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        description: "A test station",
        website: "https://example.com",
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["description"]).toBe("A test station");
      expect(record["website"]).toBe("https://example.com");
    });

    it("includes coverage radius when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        coverageRadiusNm: 150,
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["coverageRadiusNm"]).toBe(150);
    });

    it("includes hardware details when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        receiver: "RTL-SDR",
        antenna: "Colinear",
        software: "readsb",
      };

      const record = buildStationRecord(opts, fixedNow);
      const hw = record["hardware"] as any;

      expect(hw.receiver).toBe("RTL-SDR");
      expect(hw.antenna).toBe("Colinear");
      expect(hw.software).toBe("readsb");
    });

    it("includes protocols when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        protocols: ["ADSB", "MLAT"],
      };

      const record = buildStationRecord(opts, fixedNow);
      const protocols = record["protocols"] as string[];

      expect(protocols).toContain("at.adsb.receiver.station#adsb");
      expect(protocols).toContain("at.adsb.receiver.station#mlat");
    });

    it("normalizes protocol names to lowercase", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        protocols: ["ADSB", "MLAT", "UAT"],
      };

      const record = buildStationRecord(opts, fixedNow);
      const protocols = record["protocols"] as string[];

      expect(protocols).toContain("at.adsb.receiver.station#adsb");
      expect(protocols).toContain("at.adsb.receiver.station#mlat");
      expect(protocols).toContain("at.adsb.receiver.station#uat");
    });

    it("throws error for unknown protocol", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        protocols: ["INVALID"],
      };

      expect(() => buildStationRecord(opts, fixedNow)).toThrow("Unknown protocol: invalid");
    });

    it("omits hardware when all fields undefined", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["hardware"]).toBeUndefined();
    });

    it("omits protocols when empty array provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        protocols: [],
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["protocols"]).toBeUndefined();
    });

    it("includes streamEndpoint when provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        streamEndpoint: "wss://station.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["streamEndpoint"]).toBe("wss://station.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
    });

    it("omits streamEndpoint when not provided", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["streamEndpoint"]).toBeUndefined();
    });

    it("omits streamEndpoint when explicitly undefined", () => {
      const opts: StationRecordOptions = {
        displayName: "Test Station",
        latitude: 37.5,
        longitude: -122.5,
        streamEndpoint: undefined,
      };

      const record = buildStationRecord(opts, fixedNow);

      expect(record["streamEndpoint"]).toBeUndefined();
    });
  });
});
