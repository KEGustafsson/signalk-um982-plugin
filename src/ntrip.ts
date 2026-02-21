import { RtcmTransport } from '@gnss/rtcm';
import { Position } from '@signalk/server-api';

const { NtripClient } = require('ntrip-client');

export interface NtripOptions {
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password: string;
  xyz: [number, number, number];
  interval: number;
}

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
      minimum: -90,
      maximum: 90
    },
    longitude: {
      type: "number",
      title: "Longitude",
      minimum: -180,
      maximum: 180
    },
    interval: {
      type: "number",
      title: "Update Interval in milliseconds",
      minimum: 1000,
      default: 2000
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

export const startRTCM = (params: NtripConfig): (() => void) => {
  const { options, onData, onStationData, onClose, onError, debug = () => {} } = params;
  const options_: NtripOptions = {
    xyz: latLonToECEF(options.latitude, options.longitude, 0),
    ...options
  };

  const client = new NtripClient(options_);

  client.on('data', (data: Buffer) => {
    onData(data);
    try {
      const [message, length] = RtcmTransport.decode(data);
      logReferenceStationInfo(message, data, onStationData);
    } catch (err: any) {
      // console.warn('RTCM parse warning:', err.message);
    }
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
    if (client && typeof client.close === 'function') {
      client.close();
    } else if (client && typeof client.destroy === 'function') {
      client.destroy();
    }
  };
}

export function latLonToECEF(lat: number, lon: number, alt: number = 0): [number, number, number] {
  const a = 6378137.0; // WGS84 semi-major axis
  const e2 = 0.00669437999014; // WGS84 eccentricity squared

  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;

  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));

  const x = (N + alt) * Math.cos(latRad) * Math.cos(lonRad);
  const y = (N + alt) * Math.cos(latRad) * Math.sin(lonRad);
  const z = (N * (1 - e2) + alt) * Math.sin(latRad);

  return [x, y, z];
}

export function ecefToLatLon(x: number, y: number, z: number): { latitude: number; longitude: number; height: number } {
  // WGS84 constants
  const a = 6378137.0; // Semi-major axis (meters)
  const f = 1 / 298.257223563; // Flattening
  const e2 = 2 * f - f * f; // First eccentricity squared

  // Convert from millimeters to meters (RTCM coordinates are typically in mm)
  const X = x / 10000;
  const Y = y / 10000;
  const Z = z / 10000;

  // Calculate longitude
  const lon = Math.atan2(Y, X);

  // Calculate latitude iteratively
  const p = Math.sqrt(X * X + Y * Y);
  let lat = Math.atan2(Z, p * (1 - e2));
  let N, h;

  // Iterate to improve accuracy
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat);
    N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(Z, p * (1 - e2 * N / (N + h)));
  }

  // Final height calculation
  const sinLat = Math.sin(lat);
  N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  h = p / Math.cos(lat) - N;

  return {
    latitude: lat * 180 / Math.PI,
    longitude: lon * 180 / Math.PI,
    height: h
  };
}

function logReferenceStationInfo(message: any, data: Buffer, onStationData?: (delta: any) => void) {
  // Check if this is a reference station message with ECEF coordinates
  if (message && typeof message === 'object' &&
    'referenceStationId' in message &&
    'arpEcefX' in message &&
    'arpEcefY' in message &&
    'arpEcefZ' in message) {

    const coords = ecefToLatLon(message.arpEcefX, message.arpEcefY, message.arpEcefZ);

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
              value: coords
            }
          ]
        }]
      };
      onStationData(delta);
    }
  }
}

