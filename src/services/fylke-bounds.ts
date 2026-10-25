// ─── Fylke and kommune bounding boxes ───────────────────────────────────────
// dev-request 2026-10-17-integrasjonstest-oppfolging, I-E (SD-02), review B1
// on lokal#1109.
//
// RFB's fylke pages place a producer by the name in its `city` field
// (seo.ts producerPlaceFylke()). That field is a place, not a kommune: a
// town, a bygd or a pre-2020 kommune name. Some of those names are a current
// kommune in another fylke (every live producer with city "Sande" is in Sande
// i Vestfold, but the only current kommune Sande is in Møre og Romsdal), and
// some producers carry a coordinate far from their city. The boxes below let
// the producer's own coordinate veto a placement.
//
// Source: Kartverket kommuneinfo/v1 (fylker/<nr> and kommuner/<nr>,
// filtrer=avgrensningsboks, EPSG:4258, 2024 inndeling), fetched 2026-10-17
// and rounded outward to 0.01°. A box is coarse: neighbouring fylker overlap
// and Oslo lies inside Akershus's box. It can say that a point is NOT in an
// area, never which area a point is in.
//
// Pure: no DB, no I/O.

import { key } from "./norway-fylke";

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** The bounding box of each current fylke, keyed by its canonical name. */
export const FYLKE_BOUNDS: Readonly<Record<string, Bounds>> = {
  "Oslo": { minLat: 59.8, maxLat: 60.14, minLon: 10.48, maxLon: 10.96 },
  "Rogaland": { minLat: 58.02, maxLat: 59.85, minLon: 4.45, maxLon: 7.22 },
  "Møre og Romsdal": { minLat: 61.92, maxLat: 63.77, minLon: 4.81, maxLon: 9.37 },
  "Nordland": { minLat: 64.93, maxLat: 69.6, minLon: 10.57, maxLon: 18.16 },
  "Østfold": { minLat: 58.76, maxLat: 59.78, minLon: 10.53, maxLon: 11.83 },
  "Akershus": { minLat: 59.45, maxLat: 60.61, minLon: 10.19, maxLon: 11.95 },
  "Buskerud": { minLat: 59.4, maxLat: 61.1, minLon: 7.43, maxLon: 10.61 },
  "Innlandet": { minLat: 59.84, maxLat: 62.7, minLon: 7.34, maxLon: 12.88 },
  "Vestfold": { minLat: 58.72, maxLat: 59.68, minLon: 9.75, maxLon: 10.68 },
  "Telemark": { minLat: 58.6, maxLat: 60.19, minLon: 7.09, maxLon: 9.97 },
  "Agder": { minLat: 57.75, maxLat: 59.68, minLon: 6.14, maxLon: 9.67 },
  "Vestland": { minLat: 59.47, maxLat: 62.39, minLon: 4.08, maxLon: 8.33 },
  "Trøndelag": { minLat: 62.25, maxLat: 65.48, minLon: 7.64, maxLon: 14.33 },
  "Troms": { minLat: 68.35, maxLat: 70.71, minLon: 15.59, maxLon: 22.9 },
  "Finnmark": { minLat: 68.55, maxLat: 71.39, minLon: 20.47, maxLon: 31.77 },
};

// Current kommuner whose name is also a former kommune or a bygd in another
// fylke, found among live producers' `city` values by a read-only check of
// every live place page against Kartverket's point lookup (2026-10-17):
//   Nes    Akershus; also Nes på Hedmark (Ringsaker, Innlandet) and Nes i
//          Ådal (Ringerike, Buskerud)
//   Sande  Møre og Romsdal; also Sande i Vestfold (Holmestrand)
//   Hemnes Nordland; also Hemnes i Høland (Aurskog-Høland, Akershus)
//   Osen   Trøndelag; also Osen in Åmot (Innlandet)
//   Åmot   Innlandet; also Åmot in Modum (Buskerud)
// For these names the fylke box is too coarse (Åmot in Modum lies inside
// Innlandet's box), so the kommune's own box is used instead.
export const SHARED_KOMMUNE_BOUNDS: ReadonlyArray<{ readonly name: string; readonly bounds: Bounds }> = [
  { name: "Nes", bounds: { minLat: 59.98, maxLat: 60.36, minLon: 11.25, maxLon: 11.83 } },
  { name: "Sande", bounds: { minLat: 62.15, maxLat: 62.44, minLon: 4.81, maxLon: 5.8 } },
  { name: "Hemnes", bounds: { minLat: 65.76, maxLat: 66.26, minLon: 13.33, maxLon: 14.61 } },
  { name: "Osen", bounds: { minLat: 64.16, maxLat: 64.73, minLon: 9.32, maxLon: 10.93 } },
  { name: "Åmot", bounds: { minLat: 61.01, maxLat: 61.51, minLon: 10.95, maxLon: 11.92 } },
];

const sharedByKey: ReadonlyMap<string, Bounds> = new Map(SHARED_KOMMUNE_BOUNDS.map((e) => [key(e.name), e.bounds]));

/**
 * The bounding box of the current kommune with this name when the name is
 * also a place in another fylke (SHARED_KOMMUNE_BOUNDS), else undefined.
 * Matched with norway-fylke's key() fold, so "nes" and "Amot" match too.
 */
export function sharedKommuneNameBounds(name: string): Bounds | undefined {
  return sharedByKey.get(key(name));
}

/** True when (lat, lon) lies in the box, edges included. False without a box. */
export function inBounds(b: Bounds | undefined, lat: number, lon: number): boolean {
  return !!b && lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}
