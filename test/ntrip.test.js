const test = require('node:test');
const assert = require('node:assert');

const { ecefToLatLon, latLonToECEF } = require('../dist/ntrip.js');

// ecefToLatLon takes raw RTCM 1005/1006 ARP integers (0.1 mm units).
const toArp = ([x, y, z]) => [x * 10000, y * 10000, z * 10000];

test('lat/lon round-trips through ECEF', () => {
  for (const [lat, lon] of [[60.1699, 24.9384], [-33.8688, 151.2093], [51.4779, 0], [0, 0], [0, 24]]) {
    const back = ecefToLatLon(...toArp(latLonToECEF(lat, lon, 0)));
    assert.ok(Math.abs(back.latitude - lat) < 1e-7, `latitude ${lat} -> ${back.latitude}`);
    assert.ok(Math.abs(back.longitude - lon) < 1e-7, `longitude ${lon} -> ${back.longitude}`);
    assert.ok(Math.abs(back.height) < 1e-3, `height ${back.height}`);
  }
});

test('ECEF matches published WGS84 values', () => {
  // Helsinki, 60.1699N 24.9384E on the ellipsoid.
  const [x, y, z] = latLonToECEF(60.1699, 24.9384, 0);
  assert.ok(Math.abs(Math.sqrt(x * x + y * y + z * z) - 6362077) < 100);

  // The equator is exactly the semi-major axis from the geocentre.
  const [ex, ey, ez] = latLonToECEF(0, 0, 0);
  assert.ok(Math.abs(ex - 6378137) < 1e-6);
  assert.strictEqual(ey, 0);
  assert.strictEqual(ez, 0);
});

test('altitude is carried through the conversion', () => {
  const back = ecefToLatLon(...toArp(latLonToECEF(60, 25, 100)));
  assert.ok(Math.abs(back.height - 100) < 1e-3);
});

test('a zeroed ARP yields a finite result rather than NaN', () => {
  // A base station still surveying in transmits zeros; the old iteration
  // divided by cos(lat) and by N + h and produced NaN, which serialises to
  // null and reaches consumers as a position.
  const zero = ecefToLatLon(0, 0, 0);
  assert.ok(Number.isFinite(zero.latitude));
  assert.ok(Number.isFinite(zero.longitude));
  assert.ok(Number.isFinite(zero.height));
});

test('the poles do not produce NaN', () => {
  for (const sign of [1, -1]) {
    const pole = ecefToLatLon(0, 0, sign * 6356752.314245 * 10000);
    assert.strictEqual(pole.latitude, sign * 90);
    assert.ok(Number.isFinite(pole.height));
    assert.ok(Math.abs(pole.height) < 1e-3, `height at pole ${pole.height}`);
  }
});
