// pattern: Functional Core

export type NormalizedAircraft = {
  readonly icaoHex: string;
  readonly source: string;
  readonly seen: number;
  readonly rssi: number;
  readonly messages: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly seenPos?: number;
  // Set by adapters that know exactly when a fix arrived (because they diff
  // consecutive snapshots) instead of leaving the tracker to infer it from a
  // falling seenPos. Absent for adapters that report a true fix age.
  readonly newPosition?: boolean;
  readonly altBaro?: number | "ground";
  readonly altGeom?: number;
  readonly gs?: number;
  readonly track?: number;
  readonly baroRate?: number;
  readonly flight?: string;
  readonly squawk?: string;
  readonly category?: string;
  readonly navQnh?: number;
  readonly nic?: number;
  readonly rc?: number;
};

export type HandshakeMessage = {
  type: "handshake";
  sourceId: string;
  protocol: string;
  version: 1;
};

export type AircraftMessage = {
  type: "aircraft";
  timestamp: number;
  aircraft: ReadonlyArray<NormalizedAircraft>;
};

export type StatsMessage = {
  type: "stats";
  protocol: string;
  messagesReceived: number;
  positionsDecoded: number;
  signal?: {
    meanDbfs: number;
    noiseDbfs: number;
    strongCount: number;
  };
};

export type RawCaptureMessage = {
  type: "rawCapture";
  filePath: string;
  windowStart: string;
  windowEnd: string;
};

export type AdapterMessage =
  | HandshakeMessage
  | AircraftMessage
  | StatsMessage
  | RawCaptureMessage;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateNormalizedAircraft(
  input: unknown,
): NormalizedAircraft | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const obj = input as Record<string, unknown>;

  // Required fields validation
  const icaoHex = obj["icaoHex"];
  if (!isNonEmptyString(icaoHex)) {
    return null;
  }

  const source = obj["source"];
  if (!isNonEmptyString(source) || source.length > 32) {
    return null;
  }

  const seen = obj["seen"];
  if (!isNumber(seen)) {
    return null;
  }

  const rssi = obj["rssi"];
  if (!isNumber(rssi)) {
    return null;
  }

  const messages = obj["messages"];
  if (!isNumber(messages)) {
    return null;
  }

  // Optional fields validation
  let lat: number | undefined;
  const latVal = obj["lat"];
  if (latVal !== undefined) {
    if (!isNumber(latVal)) return null;
    lat = latVal;
  }

  let lon: number | undefined;
  const lonVal = obj["lon"];
  if (lonVal !== undefined) {
    if (!isNumber(lonVal)) return null;
    lon = lonVal;
  }

  let seenPos: number | undefined;
  const seenPosVal = obj["seenPos"];
  if (seenPosVal !== undefined) {
    if (!isNumber(seenPosVal)) return null;
    seenPos = seenPosVal;
  }

  let newPosition: boolean | undefined;
  const newPositionVal = obj["newPosition"];
  if (newPositionVal !== undefined) {
    if (typeof newPositionVal !== "boolean") return null;
    newPosition = newPositionVal;
  }

  let altBaro: number | "ground" | undefined;
  const altBaroVal = obj["altBaro"];
  if (altBaroVal !== undefined) {
    if (altBaroVal !== "ground" && !isNumber(altBaroVal)) return null;
    altBaro = altBaroVal as number | "ground";
  }

  let altGeom: number | undefined;
  const altGeomVal = obj["altGeom"];
  if (altGeomVal !== undefined) {
    if (!isNumber(altGeomVal)) return null;
    altGeom = altGeomVal;
  }

  let gs: number | undefined;
  const gsVal = obj["gs"];
  if (gsVal !== undefined) {
    if (!isNumber(gsVal)) return null;
    gs = gsVal;
  }

  let track: number | undefined;
  const trackVal = obj["track"];
  if (trackVal !== undefined) {
    if (!isNumber(trackVal)) return null;
    track = trackVal;
  }

  let baroRate: number | undefined;
  const baroRateVal = obj["baroRate"];
  if (baroRateVal !== undefined) {
    if (!isNumber(baroRateVal)) return null;
    baroRate = baroRateVal;
  }

  let flight: string | undefined;
  const flightVal = obj["flight"];
  if (flightVal !== undefined) {
    if (typeof flightVal !== "string") return null;
    flight = flightVal;
  }

  let squawk: string | undefined;
  const squawkVal = obj["squawk"];
  if (squawkVal !== undefined) {
    if (typeof squawkVal !== "string") return null;
    squawk = squawkVal;
  }

  let category: string | undefined;
  const categoryVal = obj["category"];
  if (categoryVal !== undefined) {
    if (typeof categoryVal !== "string") return null;
    category = categoryVal;
  }

  let navQnh: number | undefined;
  const navQnhVal = obj["navQnh"];
  if (navQnhVal !== undefined) {
    if (!isNumber(navQnhVal)) return null;
    navQnh = navQnhVal;
  }

  let nic: number | undefined;
  const nicVal = obj["nic"];
  if (nicVal !== undefined) {
    if (!isNumber(nicVal)) return null;
    nic = nicVal;
  }

  let rc: number | undefined;
  const rcVal = obj["rc"];
  if (rcVal !== undefined) {
    if (!isNumber(rcVal)) return null;
    rc = rcVal;
  }

  return {
    icaoHex,
    source,
    seen,
    rssi,
    messages,
    ...(lat !== undefined && { lat }),
    ...(lon !== undefined && { lon }),
    ...(seenPos !== undefined && { seenPos }),
    ...(newPosition !== undefined && { newPosition }),
    ...(altBaro !== undefined && { altBaro }),
    ...(altGeom !== undefined && { altGeom }),
    ...(gs !== undefined && { gs }),
    ...(track !== undefined && { track }),
    ...(baroRate !== undefined && { baroRate }),
    ...(flight !== undefined && { flight }),
    ...(squawk !== undefined && { squawk }),
    ...(category !== undefined && { category }),
    ...(navQnh !== undefined && { navQnh }),
    ...(nic !== undefined && { nic }),
    ...(rc !== undefined && { rc }),
  };
}

export function validateAdapterMessage(input: unknown): AdapterMessage | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const obj = input as Record<string, unknown>;
  const type = obj["type"];

  if (type === "handshake") {
    return validateHandshakeMessage(obj);
  } else if (type === "aircraft") {
    return validateAircraftMessage(obj);
  } else if (type === "stats") {
    return validateStatsMessage(obj);
  } else if (type === "rawCapture") {
    return validateRawCaptureMessage(obj);
  }

  return null;
}

function validateHandshakeMessage(obj: Record<string, unknown>): HandshakeMessage | null {
  const sourceId = obj["sourceId"];
  if (!isNonEmptyString(sourceId)) {
    return null;
  }

  const protocol = obj["protocol"];
  if (!isNonEmptyString(protocol)) {
    return null;
  }

  if (obj["version"] !== 1) {
    return null;
  }

  return {
    type: "handshake",
    sourceId,
    protocol,
    version: 1,
  };
}

function validateAircraftMessage(obj: Record<string, unknown>): AircraftMessage | null {
  const timestamp = obj["timestamp"];
  if (!isNumber(timestamp)) {
    return null;
  }

  const aircraftData = obj["aircraft"];
  if (!Array.isArray(aircraftData)) {
    return null;
  }

  const aircraft: Array<NormalizedAircraft> = [];
  for (const item of aircraftData) {
    const validated = validateNormalizedAircraft(item);
    if (validated === null) {
      return null;
    }
    aircraft.push(validated);
  }

  return {
    type: "aircraft",
    timestamp,
    aircraft,
  };
}

function validateStatsMessage(obj: Record<string, unknown>): StatsMessage | null {
  const protocol = obj["protocol"];
  if (!isNonEmptyString(protocol)) {
    return null;
  }

  const messagesReceived = obj["messagesReceived"];
  if (!isNumber(messagesReceived)) {
    return null;
  }

  const positionsDecoded = obj["positionsDecoded"];
  if (!isNumber(positionsDecoded)) {
    return null;
  }

  let signal:
    | {
        meanDbfs: number;
        noiseDbfs: number;
        strongCount: number;
      }
    | undefined;

  const signalData = obj["signal"];
  if (signalData !== undefined) {
    const sig = validateSignal(signalData);
    if (sig === null) {
      return null;
    }
    signal = sig;
  }

  return {
    type: "stats",
    protocol,
    messagesReceived,
    positionsDecoded,
    ...(signal !== undefined && { signal }),
  };
}

function validateSignal(
  input: unknown,
): { meanDbfs: number; noiseDbfs: number; strongCount: number } | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const obj = input as Record<string, unknown>;

  const meanDbfs = obj["meanDbfs"];
  if (!isNumber(meanDbfs)) {
    return null;
  }

  const noiseDbfs = obj["noiseDbfs"];
  if (!isNumber(noiseDbfs)) {
    return null;
  }

  const strongCount = obj["strongCount"];
  if (!isNumber(strongCount)) {
    return null;
  }

  return {
    meanDbfs,
    noiseDbfs,
    strongCount,
  };
}

function validateRawCaptureMessage(obj: Record<string, unknown>): RawCaptureMessage | null {
  const filePath = obj["filePath"];
  if (!isNonEmptyString(filePath)) {
    return null;
  }

  const windowStart = obj["windowStart"];
  if (!isNonEmptyString(windowStart)) {
    return null;
  }

  const windowEnd = obj["windowEnd"];
  if (!isNonEmptyString(windowEnd)) {
    return null;
  }

  return {
    type: "rawCapture",
    filePath,
    windowStart,
    windowEnd,
  };
}
