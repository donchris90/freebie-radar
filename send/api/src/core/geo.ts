/** Geo helpers: coordinate validation, haversine distance, bounding boxes, unit conversion. */

export type DistanceUnit = 'mi' | 'km';
const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;

export class GeoError extends Error {}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function assertCoordinate(lat: number, lng: number): void {
  if (!isValidCoordinate(lat, lng)) throw new GeoError(`Invalid coordinates: ${lat}, ${lng}`);
}

const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  assertCoordinate(aLat, aLng);
  assertCoordinate(bLat, bLng);
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  /** True when the box crosses the antimeridian: match lng >= minLng OR lng <= maxLng. */
  wrapsAntimeridian: boolean;
}

/** Cheap prefilter for an indexed (lat,lng) query. Always refine with haversine afterwards. */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  assertCoordinate(lat, lng);
  if (!Number.isFinite(radiusKm) || radiusKm < 0) throw new GeoError('Radius must be a non-negative number');
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);
  // Near the poles every longitude is within range.
  if (maxLat >= 90 || minLat <= -90) {
    return { minLat, maxLat, minLng: -180, maxLng: 180, wrapsAntimeridian: false };
  }
  const dLng = (radiusKm / (EARTH_RADIUS_KM * Math.cos(rad(lat)))) * (180 / Math.PI);
  let minLng = lng - dLng;
  let maxLng = lng + dLng;
  if (dLng >= 180) return { minLat, maxLat, minLng: -180, maxLng: 180, wrapsAntimeridian: false };
  let wraps = false;
  if (minLng < -180) {
    minLng += 360;
    wraps = true;
  }
  if (maxLng > 180) {
    maxLng -= 360;
    wraps = true;
  }
  return { minLat, maxLat, minLng, maxLng, wrapsAntimeridian: wraps };
}

export function withinRadius(
  centerLat: number,
  centerLng: number,
  pointLat: number,
  pointLng: number,
  radiusKm: number,
): boolean {
  return haversineKm(centerLat, centerLng, pointLat, pointLng) <= radiusKm;
}

export const kmToUnit = (km: number, unit: DistanceUnit): number => (unit === 'mi' ? km / KM_PER_MILE : km);
export const unitToKm = (value: number, unit: DistanceUnit): number => (unit === 'mi' ? value * KM_PER_MILE : value);

export function formatDistance(km: number, unit: DistanceUnit, locale = 'en-US'): string {
  const value = kmToUnit(km, unit);
  if (value < 0.1) return `<0.1 ${unit}`;
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 });
  return `${fmt.format(value)} ${unit}`;
}

/**
 * Public-facing approximate location: rounds to 2 decimal places (~1.1 km grid).
 * Exact coordinates must never be returned to other users.
 */
export function approximateLocation(lat: number, lng: number): { lat: number; lng: number } {
  assertCoordinate(lat, lng);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { lat: r(lat), lng: r(lng) };
}
