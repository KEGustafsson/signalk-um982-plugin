declare module 'ntrip-client' {
  import { EventEmitter } from 'events';

  export interface NTripClientOptions {
    /** NTRIP caster host/IP address */
    host?: string;

    /** NTRIP caster port */
    port?: string | number;

    /** Username for authentication */
    username?: string;

    /** Password for authentication */
    password?: string;

    /** Mountpoint name (empty string for sourcetable) */
    mountpoint?: string;

    /** User agent string */
    userAgent?: string;

    /** Custom headers to send */
    headers?: Record<string, string>;

    /** Client coordinates [x, y, z] for GGA messages */
    xyz?: [number, number, number];

    /** Time interval to send GGA messages in milliseconds */
    interval?: number;

    /** Reconnect interval in milliseconds */
    reconnectInterval?: number;

    /** Socket timeout in milliseconds */
    timeout?: number;
  }

  // Note: MountpointInfo and ConnectionStats are not part of the actual API
  // These would be handled by the 'data' event when mountpoint is empty string

  // The runtime module exports exactly one name, `NtripClient`
  // (ntrip-client/lib/client.js: `module.exports = { NtripClient }`).

  export class NtripClient extends EventEmitter {
    /** NTRIP caster host/IP address */
    host: string;

    /** NTRIP caster port */
    port: string | number;

    /** Mountpoint name */
    mountpoint: string;

    /** User agent string */
    userAgent: string;

    /** Username for authentication */
    username: string;

    /** Password for authentication */
    password: string;

    /** Custom headers */
    headers: Record<string, string>;

    /** Client coordinates [x, y, z] */
    xyz: [number, number, number];

    /** Time interval to send GGA messages */
    interval: number;

    /** Interval timer reference */
    intervalTimer: NodeJS.Timeout | null;

    /** Reconnect interval */
    reconnectInterval: number;

    /** Socket timeout */
    timeout: number;

    /** TCP socket instance */
    client: any | null;

    /** NTRIP decoder instance */
    decoder: any | null;

    /** Error status flag */
    isError: boolean;

    /** Close status flag */
    isClose: boolean;

    /** Ready status flag */
    isReady: boolean;

    /** Source table buffer */
    sourceBuf: Buffer;

    constructor(options: NTripClientOptions);

    /** Start the client and begin connection */
    run(): void;

    /** Close the client connection */
    close(): void;

    /** Set the XYZ coordinates for GGA messages */
    setXYZ(xyz: [number, number, number]): void;

    /** Send data to the NTRIP caster */
    write(data: string | Buffer): void;

    // EventEmitter events - based on actual implementation. These are additive
    // overloads: the inherited EventEmitter signature stays available so
    // listeners for other events still typecheck.
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'error', listener: (error: string | Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;

    emit(event: 'data', data: Buffer): boolean;
    emit(event: 'error', error: string | Error): boolean;
    emit(event: 'close'): boolean;
    emit(event: string | symbol, ...args: any[]): boolean;
  }
}