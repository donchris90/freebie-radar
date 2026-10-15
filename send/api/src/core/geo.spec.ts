import {
  approximateLocation,
  boundingBox,
  formatDistance,
  GeoError,
  haversineKm,
  isValidCoordinate,
  kmToUnit,
  unitToKm,
  withinRadius,
} from './geo';

describe('geo', () => {
  it('validates coordinates', () => {
    expect(isValidCoordinate(40.7, -74)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(NaN, 0)).toBe(false);
    expect(isValidCoordinate('40' as unknown, 0)).toBe(false);
  });

  it('computes haversine distance (London to Paris ~ 343 km)', () => {
    const d = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    expect(d).toBeGreaterThan(340);
    expect(d).toBeLessThan(346);
  });

  it('is zero for identical points and throws for invalid ones', () => {
    expect(haversineKm(10, 10, 10, 10)).toBeCloseTo(0, 6);
    expect(() => haversineKm(100, 0, 0, 0)).toThrow(GeoError);
  });

  it('filters by radius at the boundary', () => {
    const d = haversineKm(40.7128, -74.006, 40.7306, -73.9352);
    expect(withinRadius(40.7128, -74.006, 40.7306, -73.9352, d + 0.01)).toBe(true);
    expect(withinRadius(40.7128, -74.006, 40.7306, -73.9352, d - 0.01)).toBe(false);
  });

  it('builds a bounding box that contains every point inside the radius', () => {
    const box = boundingBox(40.7128, -74.006, 10);
    expect(box.wrapsAntimeridian).toBe(false);
    expect(box.minLat).toBeLessThan(40.7128);
    expect(box.maxLat).toBeGreaterThan(40.7128);
    // a point ~9 km north must be inside the box
    expect(40.7128 + 9 / 111.2).toBeLessThan(box.maxLat);
  });

  it('handles the antimeridian and the poles', () => {
    expect(boundingBox(0, 179.9, 50).wrapsAntimeridian).toBe(true);
    const pole = boundingBox(89.9, 10, 50);
    expect(pole.minLng).toBe(-180);
    expect(pole.maxLng).toBe(180);
  });

  it('rejects negative radius', () => {
    expect(() => boundingBox(0, 0, -1)).toThrow(GeoError);
  });

  it('converts and formats distance units', () => {
    expect(kmToUnit(1.609344, 'mi')).toBeCloseTo(1, 6);
    expect(unitToKm(10, 'mi')).toBeCloseTo(16.09344, 5);
    expect(formatDistance(16.09344, 'mi')).toBe('10 mi');
    expect(formatDistance(0.01, 'km')).toBe('<0.1 km');
  });

  it('never returns exact coordinates as the approximate location', () => {
    const a = approximateLocation(40.712776, -74.005974);
    expect(a).toEqual({ lat: 40.71, lng: -74.01 });
  });
});
