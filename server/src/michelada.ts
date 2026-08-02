// pattern: Imperative Shell

// michelada (https://github.com/konradit/michelada) decodes 1090 MHz ADS-B on a
// CaribouLite SDR and exposes the live aircraft table under /extras/adsb. The
// radio is shared with the spectrum analyser, so the decoder only runs while the
// station is in ADS-B mode -- `start`/`stop` switch it.

export type MicheladaAircraft = {
  icao: string;
  callsign?: string;
  // Optional fields are emitted as JSON null when the decoder has no value.
  lat?: number | null;
  lon?: number | null;
  heading?: number | null;
  speed?: number | null;
  last_seen: number;
};

export type MicheladaAircraftData = {
  // false when the radio is in another mode (spectrum, FPV, calibration...),
  // in which case the aircraft table is stale or empty.
  active: boolean;
  aircraft: Array<MicheladaAircraft> | null;
};

export type MicheladaMode = {
  ok: boolean;
  mode: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function fetchAircraft(
  baseUrl: string,
): Promise<MicheladaAircraftData> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/extras/adsb/aircraft`);
  if (!res.ok) throw new Error(`michelada aircraft: ${res.status}`);
  return res.json() as Promise<MicheladaAircraftData>;
}

// Switching into ADS-B mode is a no-op when the station is already in it, and
// is refused (200 with the unchanged mode) while calibration or the detector
// owns the radio.
export async function startAdsb(baseUrl: string): Promise<MicheladaMode> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/extras/adsb/start`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`michelada adsb start: ${res.status}`);
  return res.json() as Promise<MicheladaMode>;
}

export async function stopAdsb(baseUrl: string): Promise<MicheladaMode> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/extras/adsb/stop`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`michelada adsb stop: ${res.status}`);
  return res.json() as Promise<MicheladaMode>;
}
