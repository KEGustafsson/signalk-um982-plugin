import { RtcmMessage, RtcmTransport } from '@gnss/rtcm';
import { Position } from '@signalk/server-api';
import { NtripClient } from 'ntrip-client';

export interface NtripOptions {
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
  xyz: [number, number, number];
  interval: number;
  timeout?: number;
  reconnectInterval?: number;
}

// ntrip-client turns socket inactivity into a hard teardown + reconnect, and its
// own default is 15s. A base that only emits 1005 every 30s, or that idles
// overnight, would therefore reconnect forever. Default to something that
// tolerates a quiet mountpoint.
const DEFAULT_SOCKET_TIMEOUT = 60000;
const DEFAULT_RECONNECT_INTERVAL = 5000;

// RTCM3 frames always start with this preamble (RTCM 10403.x, DF002).
const RTCM3_PREAMBLE = 0xd3;

export const NtripOptionsSchema = {
  type: "object",
  required: ["host", "port", "mountpoint", "username", "password", "latitude", "longitude", "interval"],
  properties: {
    host: {
      type: "string",
      title: "NTRIP Host",
      description: "The hostname or IP address of the NTRIP caster"
    },
    port: {
      type: "number",
      title: "NTRIP Port",
      minimum: 1,
      maximum: 65535,
      default: 2101
    },
    mountpoint: {
      type: "string",
      title: "NTRIP Mountpoint",
      description: "The mountpoint name on the NTRIP caster"
    },
    username: {
      type: "string",
      title: "Username"
    },
    password: {
      type: "string",
      title: "Password"
    },
    latitude: {
      type: "number",
      title: "Latitude",
      description: "Approximate receiver latitude, sent to the caster in a GGA sentence (required for VRS/NEAR mountpoints)",
      minimum: -90,
      maximum: 90
    },
    longitude: {
      type: "number",
      title: "Longitude",
      description: "Approximate receiver longitude, sent to the caster in a GGA sentence (required for VRS/NEAR mountpoints)",
      minimum: -180,
      maximum: 180
    },
    interval: {
      type: "number",
      title: "Update Interval in milliseconds",
      minimum: 1000,
      default: 2000
    },
    timeout: {
      type: "number",
      title: "Socket Timeout in milliseconds",
      description: "Drop and reconnect the caster connection after this much silence",
      minimum: 1000,
      default: DEFAULT_SOCKET_TIMEOUT
    },
    reconnectInterval: {
      type: "number",
      title: "Reconnect Interval in milliseconds",
      minimum: 1000,
      default: DEFAULT_RECONNECT_INTERVAL
    }
  }
} as const;

export type NtripConfig = {
  options: Omit<NtripOptions, 'xyz'> & Position,
  onData: (data: Buffer) => void
  onError: (err: any) => void
  onClose: () => void
  onStationData: (delta: any) => void
  debug?: (fmt: string, ...args: any[]) => void
}

/**
 * Connect to an NTRIP caster and stream RTCM corrections to the receiver.
 *
 * Only verified RTCM3 frames reach `onData`; the caster's response header
 * arrives as an ordinary data event and would otherwise be written into the
 * UM982's command port.
 *
 * @param params Caster options plus the data, error, close and station-data
 *   callbacks, and an optional debug logger.
 * @returns A cleanup function that closes the client.
 * @throws If the configured latitude/longitude do not yield a finite ECEF
 *   position.
 */
export const startRTCM = (params: NtripConfig): (() => void) => {
  const { options, onData, onStationData, onClose, onError, debug = () => { } } = params;

  const xyz = latLonToECEF(options.latitude, options.longitude, 0);
  if (!xyz.every(Number.isFinite)) {
    throw new Error(`Invalid NTRIP reference position: ${options.latitude}, ${options.longitude}`);
  }

  const options_: NtripOptions = {
    timeout: DEFAULT_SOCKET_TIMEOUT,
    reconnectInterval: DEFAULT_RECONNECT_INTERVAL,
    ...options,
    // Spread first so the computed ECEF always wins.
    //
    // ntrip-client only sends the periodic GGA when *all three* ECEF components
    // are non-zero (lib/utils.js checkXyz), and a component is exactly zero for
    // any receiver on the Greenwich meridian or on the equator. Nudging by a
    // micrometre keeps that check happy without moving the reported position.
    xyz: xyz.map(v => (v === 0 ? 1e-6 : v)) as [number, number, number]
  };

  debug('Starting NTRIP client for %s:%s/%s, GGA reference %j',
    options_.host, options_.port, options_.mountpoint, options_.xyz);

  const client = new NtripClient(options_);

  client.on('data', (data: Buffer) => {
    // The caster's response header ("ICY 200 OK", "HTTP/1.1 401 ...") arrives as
    // an ordinary data event. Forwarding it would write ASCII junk into the
    // UM982's command port, so only pass verified RTCM3 frames through.
    if (data.length === 0 || data[0] !== RTCM3_PREAMBLE) {
      debug('Ignoring non-RTCM payload from caster (%d bytes): %s',
        data.length, data.toString('latin1').slice(0, 80));
      // ntrip-client only sets isReady on the legacy "ICY 200 OK" reply, so an
      // NTRIP 2.0 caster answering "HTTP/1.1 200 OK" would never get a GGA.
      // Treat any accepted response header as ready.
      if (!client.isReady && data.toString('latin1').includes('200 OK')) {
        debug('Caster accepted the connection, enabling GGA transmission');
        client.isReady = true;
      }
      return;
    }

    onData(data);

    let message: RtcmMessage;
    try {
      [message] = RtcmTransport.decode(data);
    } catch (err: any) {
      debug('RTCM decode failed (%d bytes): %s', data.length, err?.message ?? err);
      return;
    }
    logReferenceStationInfo(message, onStationData, debug);
  });

  client.on('close', () => {
    debug('NTRIP client closed');
    onClose();
  });

  client.on('error', (err: any) => {
    debug('NTRIP client error: %o', err);
    onError(err);
  });

  client.run();

  // Return cleanup function
  return () => {
    debug('Closing NTRIP client...');
    client.close();
  };
}

// WGS84 defining parameters (NIMA TR8350.2).
const WGS84_A = 6378137.0; // Semi-major axis (meters)
const WGS84_F = 1 / 298.257223563; // Flattening
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared
const WGS84_B = WGS84_A * (1 - WGS84_F); // Semi-minor axis (meters)

/**
 * Convert geodetic coordinates to earth-centred, earth-fixed metres (WGS84).
 *
 * @param lat Latitude in degrees.
 * @param lon Longitude in degrees.
 * @param alt Height above the ellipsoid in metres.
 * @returns `[x, y, z]` in metres.
 */
export function latLonToECEF(lat: number, lon: number, alt: number = 0): [number, number, number] {
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;

  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(latRad) * Math.sin(latRad));

  const x = (N + alt) * Math.cos(latRad) * Math.cos(lonRad);
  const y = (N + alt) * Math.cos(latRad) * Math.sin(lonRad);
  const z = (N * (1 - WGS84_E2) + alt) * Math.sin(latRad);

  return [x, y, z];
}

/**
 * Convert an RTCM 1005/1006 antenna reference point to geodetic coordinates.
 *
 * Inputs are the decoder's raw signed integers in 0.1 mm units, not metres.
 * The polar axis is handled explicitly: the iteration below divides by
 * `cos(lat)` and by `N + h`, which both collapse to zero there and would
 * otherwise return NaN for a base station transmitting a zeroed ARP.
 *
 * @param x Raw ECEF X in 0.1 mm units.
 * @param y Raw ECEF Y in 0.1 mm units.
 * @param z Raw ECEF Z in 0.1 mm units.
 * @returns Latitude and longitude in degrees, height above the ellipsoid in
 *   metres.
 */
export function ecefToLatLon(x: number, y: number, z: number): { latitude: number; longitude: number; height: number } {
  // RTCM 1005/1006 ARP ECEF coordinates have a resolution of 0.0001 m (0.1 mm)
  // and are returned by the decoder as raw signed integers, so divide by 10000 to get meters.
  const X = x / 10000;
  const Y = y / 10000;
  const Z = z / 10000;

  // Calculate longitude
  const lon = Math.atan2(Y, X);

  const p = Math.sqrt(X * X + Y * Y);

  // On (or very near) the polar axis the iteration below divides by cos(lat) and
  // by N + h, both of which collapse to zero and poison every later value with
  // NaN. A base station reporting a zeroed ARP - common during survey-in - lands
  // exactly here, so answer the degenerate case directly.
  if (p < 1e-9) {
    return {
      latitude: Z >= 0 ? 90 : -90,
      longitude: 0,
      height: Math.abs(Z) - WGS84_B
    };
  }

  // Calculate latitude iteratively
  let lat = Math.atan2(Z, p * (1 - WGS84_E2));
  let N: number;
  let h: number;

  // Iterate to improve accuracy
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat);
    N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(Z, p * (1 - WGS84_E2 * N / (N + h)));
  }

  // Final height calculation
  const sinLat = Math.sin(lat);
  N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  h = p / Math.cos(lat) - N;

  return {
    latitude: lat * 180 / Math.PI,
    longitude: lon * 180 / Math.PI,
    height: h
  };
}

// Reference station heights outside this band mean we decoded something that is
// not an ARP, so the delta is dropped rather than published as a bogus position.
const MAX_PLAUSIBLE_STATION_HEIGHT = 20000;

/**
 * Publish a decoded RTCM 1005/1006 reference station as a Signal K delta.
 *
 * Messages without antenna reference point coordinates are ignored, as are
 * positions that do not convert to a plausible location - a base station
 * transmitting a zeroed ARP must not surface as a real position.
 *
 * @param message A decoded RTCM message.
 * @param onStationData Delta sink; nothing is published without it.
 * @param debug Debug logger.
 */
function logReferenceStationInfo(
  message: any,
  onStationData?: (delta: any) => void,
  debug: (fmt: string, ...args: any[]) => void = () => { }
) {
  // Check if this is a reference station message with ECEF coordinates
  if (message && typeof message === 'object' &&
    'referenceStationId' in message &&
    'arpEcefX' in message &&
    'arpEcefY' in message &&
    'arpEcefZ' in message) {

    const { height, ...latLon } = ecefToLatLon(message.arpEcefX, message.arpEcefY, message.arpEcefZ);

    if (!Number.isFinite(latLon.latitude) || !Number.isFinite(latLon.longitude) ||
      !Number.isFinite(height) || Math.abs(height) > MAX_PLAUSIBLE_STATION_HEIGHT) {
      debug('Ignoring implausible reference station position for %s: %j',
        message.referenceStationId, { ...latLon, height });
      return;
    }

    if (onStationData) {
      const delta = {
        context: `rtkstations.${message.referenceStationId}`,
        updates: [{
          values: [
            {
              path: '',
              value: { name: message.referenceStationId.toString() }
            },
            {
              path: 'navigation.position',
              // Signal K positions use `altitude`, not `height`.
              value: { ...latLon, altitude: height }
            }
          ]
        }]
      };
      onStationData(delta);
    }
  }
}
