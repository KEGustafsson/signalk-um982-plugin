
import { PathValue, Plugin, PluginConstructor, Position, ServerAPI } from '@signalk/server-api';
import { NtripOptions, NtripOptionsSchema, startRTCM } from './ntrip';

export const PLUGIN_ID = 'tkurki-um982';

export type Configuration = {
  serialconnection: string;
  ntripEnabled: boolean;
  headingOffset?: number;
} & Omit<NtripOptions, 'xyz'> & Position

export type Debug = (fmt: string, ...args: any[]) => void

const noopDebug: Debug = () => { }

// Antenna-installation constant: the angle between the master->slave antenna
// baseline and the vessel's bow. Applied to every heading this plugin publishes.
// 90 is the historical hard-coded value and stays the default so existing
// installations are unaffected; anyone whose antennas sit along the centreline
// wants 0.
const DEFAULT_HEADING_OFFSET = 90;

// Commands the webapp and this plugin are allowed to write to the receiver.
// The route is reachable by anything that can reach the Signal K HTTP API, so
// destructive commands (FRESET, and anything not listed) are simply not
// expressible - see the route handler below.
const ALLOWED_COMMANDS = new Set([
  'BESTSATA',
  'CONFIG',
  'GPGGA',
  'GPGSA',
  'GPGSV',
  'GPGSVH',
  'GPHPR',
  'GPRMC',
  'MODE',
  'SAVECONFIG',
  'UNIHEADINGA',
  'UNLOG'
]);

// Anything the receiver accepts is ASCII alphanumerics, spaces and simple
// numeric punctuation. Rejecting the rest also rules out CR/LF injection of a
// second command into a single request.
const COMMAND_PATTERN = /^[A-Za-z0-9 .,\-]{1,120}$/;

// Matches the `minimum` both timing fields declare in NtripOptionsSchema.
const MIN_NTRIP_TIMING_MS = 1000;

const pluginFactory: PluginConstructor = function (app: ServerAPI): Plugin {
  const debug: Debug = (app as any).debug.bind(app)

  const knownNmeaConnections: string[] = []
  const knownSerialPorts: string[] = []
  let rtcmReceived: number | undefined = undefined

  // Per-run receiver configuration reported by $CONFIG. Kept in the factory
  // closure (not at module scope) so it does not survive a stop/start, and
  // published as a copy so already-delivered deltas are never mutated.
  let configMap: { [key: string]: string } = {}

  const updatePluginStatus = () => {
    const problems: string[] = []
    if (knownNmeaConnections.length === 0) {
      problems.push('No NMEA0183 data connections')
    }
    if (knownSerialPorts.length === 0) {
      problems.push('No serial ports detected')
    } else if (currentSerialConnection && serialWrite === noSerialPort) {
      // Some port is enumerated, just not the configured one - unplugging the
      // receiver while an AIS adapter stays connected looks healthy by port
      // count alone, while every command and every RTCM frame is dropped.
      problems.push(`Configured serial port ${currentSerialConnection} is not connected`)
    }
    if (problems.length > 0) {
      app.setPluginError(problems.join('; '));
    } else {
      app.setPluginStatus(rtcmReceived
        ? `RTCM data received ${new Date(rtcmReceived).toLocaleTimeString()}`
        : 'No RTCM data received yet');
    }
  }

  const noSerialPort = () => {
    debug('Dropping write, no serial port selected');
    return false;
  }
  let serialWrite: (data: string | Buffer) => boolean = noSerialPort

  let currentSerialConnection: string | undefined = undefined

  // Bind serialWrite to the port the user actually selected. Binding to
  // whichever port happened to be enumerated last would send the receiver's
  // configuration - and the whole RTCM correction stream - to an unrelated
  // device such as an AIS receiver.
  const bindSerialPort = (values: any[]) => {
    debug('Serial ports: %j', values);
    let matched = false
    // Replace rather than append: onPropertyValues re-delivers the whole
    // accumulated list, so appending left an unplugged adapter in the config
    // dropdown until the server restarted.
    knownSerialPorts.length = 0;
    values.filter(v => v).forEach(({ value }) => {
      if (!knownSerialPorts.includes(value.id)) {
        knownSerialPorts.push(value.id);
      }
      if (value.id === currentSerialConnection) {
        matched = true
        serialWrite = (data: string | Buffer) => {
          (app as any).emit(value.eventNames.toStdout, data);
          return true
        };
      }
    })
    if (!matched && currentSerialConnection) {
      debug('Configured serial port %s not present among %j', currentSerialConnection, knownSerialPorts);
      serialWrite = noSerialPort
    }
  }

  const unsubscribeSerialPorts = app.onPropertyValues('serialport', (values) => bindSerialPort(values as any[]))

  let onStop = [] as (() => void)[];
  onStop.push(() => unsubscribeSerialPorts());

  return {
    id: PLUGIN_ID,
    name: 'Unicore UM982 GNSS Receiver',
    description: 'Signal K plugin for Unicore UM982 GNSS receiver',
    registerWithRouter: (router: any) => {
      router.post('/send/:sentence/:args?', (req: any, res: any) => {
        // Express has already percent-decoded req.params; decoding again here
        // would throw URIError on a literal '%' and could reintroduce a '/'.
        const sentence = String(req.params.sentence).trim();
        const rawArgs = req.params.args;
        const args = rawArgs === undefined || rawArgs === null
          ? ''
          : String(rawArgs).trim();

        const command = args ? `${sentence} ${args}` : sentence;

        if (!COMMAND_PATTERN.test(command)) {
          res.status(400).json({ error: 'command contains unsupported characters' });
          return;
        }

        const verb = sentence.split(' ')[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(verb)) {
          res.status(403).json({ error: `command ${verb} is not allowed` });
          return;
        }

        if (!serialWrite(command)) {
          res.status(503).json({ error: 'no serial connection to the UM982' });
          return;
        }

        debug('Sent command: %s', command);
        res.status(200).json({ status: 'queued', sentence, args: args || null });
      });
    },
    schema: () => {
      const serialConnectionEnum = [...knownSerialPorts];
      const result = {
        properties: {
          serialconnection: {
            type: "string",
            title: "Serial Connection",
            description: serialConnectionEnum.length === 0 ? 'You need to connect a serial port for a UM982 device first' : 'Select the serial connection for the UM982 device',
            enum: serialConnectionEnum,
            default: undefined as string | undefined
          },
          headingOffset: {
            type: "number",
            title: "Heading Offset (degrees)",
            description: "Angle from the vessel's bow to the master->slave antenna baseline, added to the receiver's heading",
            minimum: -360,
            maximum: 360,
            default: DEFAULT_HEADING_OFFSET
          },
          ntripEnabled: {
            type: "boolean",
            title: "NTRIP Enabled",
            description: "Fetch RTCM corrections from an NTRIP caster. All NTRIP fields below are required when this is enabled.",
            // Defaults to false so the receiver can be used without a caster,
            // as the README describes. With a true default, saving the form
            // with the NTRIP fields blank left the plugin refusing to start.
            default: false
          },
          ...NtripOptionsSchema.properties,
        },
        required: ["serialconnection"]
      };

      //add current value to enum if not present
      if (currentSerialConnection && !serialConnectionEnum.includes(currentSerialConnection)) {
        serialConnectionEnum.unshift(currentSerialConnection);
      }
      if (serialConnectionEnum.length > 0) {
        result.properties.serialconnection.default = serialConnectionEnum[0];
      }

      return result
    },
    start: (config_: Configuration) => {
      const problem = describeConfigurationProblem(config_, debug);
      if (problem) {
        app.setPluginError(`Invalid configuration: ${problem}`);
        return;
      }
      currentSerialConnection = config_.serialconnection;
      const headingOffset = typeof config_.headingOffset === 'number' && Number.isFinite(config_.headingOffset)
        ? config_.headingOffset
        : DEFAULT_HEADING_OFFSET;
      configMap = {};
      app.setPluginStatus('Starting');

      // Re-resolve serialWrite now that we know which port was selected.
      const unsubscribeReselect = app.onPropertyValues('serialport', (values) => bindSerialPort(values as any[]))
      onStop.push(() => unsubscribeReselect());

      let stopped = false;
      onStop.push(() => { stopped = true });

      const parseSentence = createSentenceParser({
        debug,
        headingOffset,
        configMap: () => configMap,
        handleMessage: (delta: any) => app.handleMessage(PLUGIN_ID, delta)
      });

      const startTimer = setTimeout(() => {
        if (stopped) {
          debug('Plugin stopped before initialisation ran, skipping receiver setup');
          return;
        }
        serialWrite('MODE ROVER UAV')
        serialWrite('MODE')
        serialWrite('GPGSVH 1')
        serialWrite('BESTSATA 1')
        serialWrite('GPHPR 1')
        // serialWrite('CONFIG HEADING LENGTH 138 10')
        serialWrite('CONFIG')

        if (config_.ntripEnabled) {
          try {
            const closeRTCM = startRTCM({
              options: config_,
              onData: (data: Buffer) => {
                // Only a frame that reached the receiver counts: reporting
                // "RTCM data received" while every frame is dropped on the
                // floor hides the one fault the status line exists to show.
                if (serialWrite(data)) {
                  rtcmReceived = Date.now()
                }
              },
              onError: (e) => {
                debug('RTCM error: %o', e)
              },
              onClose: () => {
                rtcmReceived = undefined
                updatePluginStatus()
              },
              onStationData: (delta: any) => app.handleMessage(PLUGIN_ID, delta),
              debug
            })
            onStop.push(closeRTCM);
          } catch (e: any) {
            app.setPluginError(`Could not start NTRIP client: ${e?.message ?? e}`);
          }
        }
      }, 1000);
      // Registered synchronously: stop() may run before the timer fires.
      onStop.push(() => clearTimeout(startTimer));

      const updatePluginStatusTimer = setInterval(() => {
        updatePluginStatus()
      }, 1000)
      onStop.push(() => clearInterval(updatePluginStatusTimer));

      const unsubscribeProviders = app.onPropertyValues('pipedprovider', (values) => {
        (values as any[]).filter(v => v).forEach(({ value }) => {
          debug('%j', value)
          if (value.type !== 'Multiplexed' && value.type !== 'NMEA0183') {
            return
          }
          if (knownNmeaConnections.indexOf(value.id) !== -1) {
            return
          }
          knownNmeaConnections.push(value.id);
          const eventName = value.eventNames.received;
          const listener = value.type === 'Multiplexed'
            ? (data: any) => parseSentence.multiplexed(data.toString())
            : (data: any) => parseSentence.sentence(data.toString());
          (app as any).on(eventName, listener);
          // Without this the listeners outlive stop(), so a disabled plugin
          // keeps publishing deltas until the server restarts.
          onStop.push(() => {
            (app as any).removeListener(eventName, listener);
            const i = knownNmeaConnections.indexOf(value.id);
            if (i !== -1) {
              knownNmeaConnections.splice(i, 1);
            }
          });
        })
        updatePluginStatus();
      })
      onStop.push(() => unsubscribeProviders());

      updatePluginStatus();
    },
    stop: () => {
      onStop.forEach(f => {
        try {
          f()
        } catch (e: any) {
          debug('Error during stop: %o', e)
        }
      });
      onStop = []
      rtcmReceived = undefined
      configMap = {}
      serialWrite = noSerialPort
    }
  };
};

type ParserContext = {
  debug: Debug
  headingOffset: number
  configMap: () => { [key: string]: string }
  handleMessage: (delta: any) => void
}

/**
 * Build the sentence parsers for one plugin run.
 *
 * The returned parsers never throw: they run inside the server's connection
 * pipeline, so a malformed sentence is logged and dropped instead of
 * propagating into the server's read path.
 *
 * @param ctx Debug logger, heading offset, receiver config map accessor and
 *   the delta sink.
 * @returns `sentence` for raw NMEA0183 input and `multiplexed` for
 *   `<timestamp>;<discriminator>;<sentence>` lines.
 */
export const createSentenceParser = (ctx: ParserContext) => {
  const sentence = (completeSentence: string) => parseNmeaSentence(completeSentence, ctx);
  return {
    sentence,
    multiplexed: (multiplexedLine: string) => {
      const segments = multiplexedLine.split(';');
      // <timestamp>;<discriminator>;<sentence>, where the sentence itself may
      // contain further semicolons (Unicore ASCII logs always do).
      if (segments.length < 3) {
        ctx.debug('Line is not multiplexed, parsing as-is: %s', multiplexedLine.trim());
        sentence(multiplexedLine.trim());
        return;
      }
      sentence(segments.slice(2).join(';').trim());
    }
  }
}

const parseNmeaSentence = (completeSentence: string, ctx: ParserContext) => {
  const parts = completeSentence.split(',')
  let parser: (parts: string[], sentence: string, ctx: ParserContext) => PathValue[];
  switch (true) {
    case parts[0] === '#UNIHEADINGA':
      parser = uniheadingAParser
      break
    case parts[0] === '#MODE':
      parser = modeParser
      break
    case parts[0] === '#BESTSATA':
      parser = bestSatParser
      break
    // Firmware emits $GNHPR, but accept any talker id so a receiver configured
    // to send $GPHPR is not silently ignored.
    case /^\$[A-Z]{2}HPR$/.test(parts[0]):
      parser = hprParser
      break
    case parts[0] === '$CONFIG':
      parser = configParser
      break
    default:
      return;
  }
  let values: PathValue[];
  try {
    // NOTE changed UNIHEADINGA parser to use 2nd param
    values = parser(parts, completeSentence.split('*')[0], ctx);
  } catch (e: any) {
    // These parsers run inside the server's connection pipeline, so a throw on
    // a truncated sentence would propagate into the server's read path.
    ctx.debug('Failed to parse sentence %j: %o', completeSentence, e);
    return;
  }
  if (values.length) {
    ctx.handleMessage({
      updates: [{
        values
      }]
    });
  }
}
/*
MODE ROVER

> GNRMC 1
$command,GNRMC 1,response: OK*1A

// configuration of UM-982:
// unlog: stop all logging on current port
// gphpr com1 1: Heading Pitch Roll on com1 every second
// config: show configuration
// saveconfig
// uniloglist
// freset: factory reset
// gpgga com1 1
// mode heading2 lowdynamic



*/

/**
 * Parse a $CONFIG response into the accumulated receiver configuration map.
 *
 * Shape: `$CONFIG,<key>,CONFIG <key> <value...>*<checksum>`.
 *
 * @param parts The raw sentence split on commas; only the key is taken here.
 * @param sentence The sentence with its checksum already removed.
 * @param ctx Debug logger and the config map accessor.
 * @returns A single `sensors.rtk.um982` value holding a copy of the map, or an
 *   empty array if the line is malformed.
 */
const configParser = (parts: string[], sentence: string, ctx: ParserContext) => {
  if (parts.length < 3 || !parts[1]) {
    ctx.debug('Ignoring malformed $CONFIG sentence: %j', sentence);
    return [];
  }
  // `sentence` already has the checksum removed. The previous implementation
  // sliced a fixed 4 characters off the raw field, which silently ate the last
  // digit of the value whenever the line had been trimmed of its CR.
  const configMap = ctx.configMap();
  // Use `sentence`, which already has the checksum removed - `parts` is split
  // from the raw line and still carries the trailing *cs.
  configMap[parts[1]] = sentence.split(',').slice(2).join(',').trim().split(' ').slice(2).join(' ');
  return [{
    path: 'sensors.rtk.um982',
    // Publish a copy: the map is mutated by every subsequent $CONFIG line, and
    // consumers must not see an already-delivered delta change under them.
    value: { ...configMap }
  }] as PathValue[];
}

/**
 * Parse a #MODE sentence into the receiver's current mode.
 *
 * @param _parts Unused; the mode is taken from the data section of `sentence`.
 * @param sentence The sentence with its checksum already removed.
 * @returns A single `navigation.gnss.um982.mode` value, or an empty array if
 *   there is no data section.
 */
const modeParser = (_parts: string[], sentence: string) => {
  // #MODE,<header fields>;MODE <mode...>
  const dataSection = sentence.split(';')[1];
  if (!dataSection) {
    return [];
  }
  // Require a non-empty value after the MODE token: a line truncated at
  // ";MODE" leaves nothing for the replace to strip, and the literal string
  // "MODE" would be published as the receiver's mode.
  const match = dataSection.trim().match(/^MODE\s+(.+)$/i);
  if (!match) {
    return [];
  }
  return [{
    path: 'navigation.gnss.um982.mode',
    value: match[1]
  } as PathValue];
}

/**
 * Apply the antenna offset to a receiver heading and convert it to radians.
 *
 * @param headingDeg Heading reported by the receiver, in degrees.
 * @param offsetDeg Angle from the bow to the master->slave antenna baseline.
 * @returns The heading in `[0, 2pi)`, or `null` if `headingDeg` is not finite.
 */
export const headingToRadians = (headingDeg: number, offsetDeg: number): number | null => {
  if (!Number.isFinite(headingDeg)) {
    return null;
  }
  // Normalise into [0, 2pi) so the offset cannot produce a negative or >360
  // heading, which consumers reject.
  const normalised = (((headingDeg + offsetDeg) % 360) + 360) % 360;
  return normalised * Math.PI / 180;
}

// $--HPR field layout (UM982 reference manual, Table 7-42 GPHPR):
//   parts[0]=$--HPR  parts[1]=utc  parts[2]=heading  parts[3]=pitch
//   parts[4]=roll  parts[5]=QF (solution quality)  parts[6]=sat No ...
// QF: 0=fix invalid, 1=single, 2=DGPS, 4=RTK fix, 5=RTK float,
//     6=dead reckoning, 7=manual, 8=extra wide-lane, 9=SBAS.
// The QF field is the authoritative validity flag - when it is 0 there is no
// solution and the heading must be reported as null (instead of flickering to
// the offset value). parts[5] may be missing on older firmware, in which case
// we fall back to treating a numeric-zero heading as no-fix.
/**
 * Parse a $--HPR sentence into a heading.
 *
 * @param parts The sentence split on commas.
 * @param _sentence Unused.
 * @param ctx Debug logger and heading offset.
 * @returns A single `navigation.headingTrue` value, null when the quality flag
 *   reports no fix.
 */
const hprParser = (parts: string[], _sentence: string, ctx: ParserContext) => {
  // `$GNHPR,123519.00,27` is indistinguishable from a complete sentence
  // reporting a heading of 27 degrees, so the final field is never parsed.
  const fields = completeFields(parts);
  const qf = fields[5];
  const heading = parseFloat(fields[2]);
  ctx.debug('HPR fields: %j (heading=%s, QF=%s)', fields, fields[2], qf);
  const noFix = qf !== undefined
    ? qf === '0' || qf === ''
    : isNaN(heading) || heading === 0;
  return [{
    path: 'navigation.headingTrue',
    value: noFix ? null : headingToRadians(heading, ctx.headingOffset)
  }
  ] as PathValue[]
}

/**
 * Decode a BESTSATA signal mask into the signal names it represents.
 *
 * Bit assignments differ per constellation, and firmware abbreviates some
 * names (GLO/GAL/BDS), so both spellings are accepted.
 *
 * @param maskHex The mask field, hexadecimal.
 * @param gnssSystem Constellation name from the same satellite record.
 * @returns Signal names, or a single `0x...` entry for an unknown
 *   constellation or an unparseable mask.
 */
export const decodeBestSatMask = (maskHex: string, gnssSystem: string) => {
  const mask = parseInt(maskHex, 16);
  const signals: string[] = [];

  if (!Number.isFinite(mask)) {
    return [`0x${maskHex}`];
  }

  // Signal bit definitions vary by GNSS system. Firmware abbreviates some
  // constellation names (GLO/GAL/BDS), so accept both spellings.
  switch (gnssSystem) {
    case 'GPS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L1M');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L2M');
      if (mask & 0x20) signals.push('L5I');
      if (mask & 0x40) signals.push('L5Q');
      if (mask & 0x80) signals.push('L1C');
      break;

    case 'GLO':
    case 'GLONASS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L2CA');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L3I');
      if (mask & 0x20) signals.push('L3Q');
      break;

    case 'GAL':
    case 'GALILEO':
      if (mask & 0x01) signals.push('E1B');
      if (mask & 0x02) signals.push('E1C');
      if (mask & 0x04) signals.push('E5aI');
      if (mask & 0x08) signals.push('E5aQ');
      if (mask & 0x10) signals.push('E5bI');
      if (mask & 0x20) signals.push('E5bQ');
      if (mask & 0x40) signals.push('E6B');
      if (mask & 0x80) signals.push('E6C');
      break;

    case 'BDS':
    case 'BEIDOU':
      if (mask & 0x01) signals.push('B1I');
      if (mask & 0x02) signals.push('B1Q');
      if (mask & 0x04) signals.push('B2I');
      if (mask & 0x08) signals.push('B2Q');
      if (mask & 0x10) signals.push('B3I');
      if (mask & 0x20) signals.push('B3Q');
      break;

    case 'QZSS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1C');
      if (mask & 0x04) signals.push('L2C');
      if (mask & 0x08) signals.push('L5I');
      if (mask & 0x10) signals.push('L5Q');
      break;

    default:
      // For unknown systems, just return the hex value
      signals.push(`0x${maskHex}`);
  }

  return signals;
};

/**
 * Decode the satellite records carried by a #BESTSATA sentence.
 *
 * @param sentence The sentence with its checksum already removed.
 * @returns One entry per satellite; empty if there is no data section. A
 *   record count larger than the data present is truncated rather than
 *   producing undefined entries.
 */
export const parseBestSat = (sentence: string) => {
  // BESTSATA message format:
  // #BESTSATA,90,GPS,FINE,2389,362704000,0,0,18,24;18,GPS,1,GOOD,00000017,GPS,2,GOOD,00000011...
  // The data section starts with the satellite count, then 4 fields per
  // satellite: GNSS system, satellite ID, status (ignored), signal mask.
  const data = sentence.split(';')[1];
  if (!data) {
    return [];
  }

  const satellites: { gnss: string, id: string, mask: string, signals: string[] }[] = [];
  const satelliteData = data.split(',');
  const count = Number(satelliteData[0]);
  if (!Number.isFinite(count)) {
    return satellites;
  }

  for (let i = 0; i < count; i++) {
    const gnssSystem = satelliteData[i * 4 + 1];
    const satId = satelliteData[i * 4 + 2];
    const maskHex = satelliteData[i * 4 + 4];
    if (gnssSystem === undefined || satId === undefined || maskHex === undefined) {
      break;
    }

    satellites.push({
      gnss: gnssSystem,
      id: satId,
      mask: maskHex,
      signals: decodeBestSatMask(maskHex, gnssSystem)
    });
  }

  return satellites;
};

/**
 * Decode #BESTSATA for the debug log only.
 *
 * Publishing this as navigation.gnss.satellitesUsed was removed deliberately
 * in 9c122e2, so the decoded satellites go to the debug log rather than into
 * the Signal K model.
 *
 * @param _parts Unused.
 * @param sentence The sentence with its checksum already removed.
 * @param ctx Debug logger.
 * @returns Always an empty array.
 */
const bestSatParser = (_parts: string[], sentence: string, ctx: ParserContext) => {
  const satellites = parseBestSat(sentence);
  if (satellites.length) {
    ctx.debug('BESTSATA satellites: %j', satellites);
  }
  return [] as PathValue[];
};

const degreesToRadians = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * Math.PI / 180 : null;
}

const finiteFloat = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const finiteInt = (v: string) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// UNIHEADINGA data section, verified against a captured sentence:
//   SOL_COMPUTED,L1_INT,2.7889,296.7233,-25.7710,0.0000,0.1127,0.1812,"999",
//   49,37,37,0,3,00,1,51
//   0 sol status      1 pos type        2 baseline length (m)  3 heading (deg)
//   4 pitch (deg)     5 reserved        6 heading std dev      7 pitch std dev
//   8 station id      9 #SVs tracked   10 #SVs in solution    11 #SVs above mask
//  12 #SVs above mask with L2          13 solution source     14 ext sol status
//  15 Galileo/BeiDou signal mask       16 GPS/GLONASS signal mask
//
// Fields 11-16 carry no DOP, no per-constellation satellite count and no
// correction age, so the mappings that previously published them as
// navigation.positionHdop/Vdop, navigation.satellites.GPS/GLONASS/GALILEO and
// navigation.position.age/dgpsAge were publishing unrelated numbers. They are
// dropped rather than renamed; fields 6 and 7 are republished as what they
// actually are.
export const CONVERTERS = {
  UNIHEADINGA: [
    { index: 0, path: 'sensors.rtk.solutionStatus', convert: (v: string) => v },
    { index: 1, path: 'sensors.rtk.positionType', convert: (v: string) => v },
    { index: 2, path: 'sensors.rtk.baselineLength', convert: finiteFloat },
    {
      index: 3, path: 'navigation.headingTrue', convert: (v: string, offset: number) =>
        // Math only; heading validity is gated in uniheadingAParser using the
        // authoritative sol-stat + pos-type fields (see SOL_STATUS_VALID /
        // POSITION_TYPE_NO_SOLUTION below).
        headingToRadians(parseFloat(v), offset)
    },
    { index: 4, path: 'navigation.attitude.pitch', convert: degreesToRadians },
    { index: 6, path: 'sensors.rtk.headingStdDev', convert: degreesToRadians },
    { index: 7, path: 'sensors.rtk.pitchStdDev', convert: degreesToRadians },
    { index: 9, path: 'navigation.satellites.inView', convert: finiteInt },
    { index: 10, path: 'navigation.satellites.used', convert: finiteInt }
  ]
}
// Field positions within the data section, not positions within CONVERTERS.
const SOLUTION_STATUS_INDEX = 0;
const POSITION_TYPE_INDEX = 1;

// UM982 reference manual: a heading is only valid when sol-stat and pos-type
// are considered together (Table 0-5 Solution Status, Table 0-4 Position Type).
// Valid solution status for a computed heading.
const SOL_STATUS_VALID = 'SOL_COMPUTED';
// Position type that means "no solution" (Table 0-4). Any other pos-type with a
// computed solution carries a real heading, so we reject by this blacklist
// rather than an exact whitelist (firmware can report NARROW_INT, NARROW_FLOAT,
// WIDE_INT, etc. - all valid headings).
const POSITION_TYPE_NO_SOLUTION = 'NONE';

// modified UNIHEADINGA parser to extract entire message header
// (i.e. everything up to first semicolon)
// which lets field indexes match UM982 documentation
/**
 * Build path/value pairs, dropping any whose value is absent.
 *
 * `{value: undefined}` serialises to a delta entry with no `value` key, so a
 * field a truncated sentence never carried must not be published at all.
 *
 * @param entries Path to value.
 * @returns One entry per defined value.
 */
/**
 * Drop the final field of a sentence, which may be a fragment.
 *
 * A read cut short ends inside whatever field came last, and a fragment is
 * indistinguishable from a complete field: `...,2.7889,2` looks exactly like a
 * record whose heading really is 2 degrees, and would publish 92 degrees once
 * the offset is applied. Only a field that a delimiter follows is known to be
 * whole, so the last one is never parsed. A complete sentence loses only its
 * trailing field, which no converter here reads.
 *
 * @param fields The sentence's fields, in order, checksum already removed.
 * @returns The leading fields that are known to be complete.
 */
const completeFields = (fields: string[]) => fields.slice(0, -1);

const definedValues = (entries: { [path: string]: string | undefined }) =>
  Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([path, value]) => ({ path, value } as PathValue));

/**
 * Parse a #UNIHEADINGA sentence into Signal K deltas.
 *
 * Validity is judged from sol-stat and pos-type together; when the receiver
 * reports no solution only the status fields and a null heading are returned,
 * rather than a baseline and satellite counts from a sentence it has just
 * declared invalid.
 *
 * @param _parts Unused; the data section is taken from `sentence`.
 * @param sentence The sentence with its checksum already removed.
 * @param ctx Debug logger and heading offset.
 * @returns Path/value pairs, or an empty array if there is no data section.
 */
export const uniheadingAParser = (_parts: string[], sentence: string, ctx: ParserContext) => {
  ctx.debug('UNIHEADINGA received: %s', sentence);

  // Split by semicolon first to separate header from data
  const dataSection = sentence.split(';')[1];

  if (!dataSection) {
    ctx.debug('No data section found after semicolon');
    return [];
  }

  // Parse data section by commas (remove checksum if present)
  const dataFields = dataSection.split('*')[0].split(',');
  const whole = completeFields(dataFields);

  ctx.debug('UNIHEADINGA data fields: %j', dataFields);

  // Matching an exact constant is safe on a fragment - no truncation of a
  // longer status yields SOL_COMPUTED - so the status is read from the raw
  // fields and still published when it is all the sentence carried.
  const solStatus = dataFields[SOLUTION_STATUS_INDEX];
  // The position type is tested by inequality, so a fragment of NONE (say
  // `NON`) would pass the `!== NONE` test below and be read as a solution.
  const posType = whole[POSITION_TYPE_INDEX];

  // Per the manual's guidance, judge validity from sol-stat + pos-type
  // together: accept the sentence when the solution is computed and the
  // position type is not "no solution". Anything else (NONE /
  // INSUFFICIENT_OBS / NO_CONVERGENCE / COV_TRACE) carries no usable
  // measurement, so publish the status fields and null the heading rather than
  // emitting a baseline, standard deviations and satellite counts derived from
  // a sentence the receiver has just declared invalid.
  // A sentence truncated after the solution status leaves posType undefined,
  // which would pass the `!== NONE` test and be accepted as a valid solution.
  const validSolution = solStatus === SOL_STATUS_VALID
    && Boolean(posType?.trim())
    && posType !== POSITION_TYPE_NO_SOLUTION;

  if (!validSolution) {
    ctx.debug('No valid heading solution (solStatus=%s, posType=%s), setting heading to null', solStatus, posType);
    return [
      // Only publish fields the sentence actually carried: a `value` of
      // undefined serialises as a delta entry with no `value` key at all.
      ...definedValues({
        'sensors.rtk.solutionStatus': solStatus,
        'sensors.rtk.positionType': posType
      }),
      { path: 'navigation.headingTrue', value: null }
    ] as PathValue[];
  }

  const parsed = CONVERTERS.UNIHEADINGA
    // A truncated sentence would otherwise yield NaN / undefined values, which
    // reach the full model and only become null at serialisation time.
    .filter(c => c.index < whole.length)
    .map(c => ({
      path: c.path,
      value: c.convert(dataFields[c.index], ctx.headingOffset)
    } as PathValue))

  // The heading must be published on every sentence with a data section, even
  // one truncated before the heading field. Without this a truncated sentence
  // publishes no heading at all and the last good value stays live in the
  // model - the stale-heading case this parser exists to prevent.
  if (!parsed.some(v => v.path === 'navigation.headingTrue')) {
    parsed.push({ path: 'navigation.headingTrue', value: null } as PathValue);
  }

  ctx.debug('UNIHEADINGA parsed values: %j', parsed);

  return parsed;
}

/**
 * Check a saved plugin configuration and describe the first problem found.
 *
 * Returning a description rather than a boolean is what lets the plugin tell
 * the user which field is at fault instead of a bare "Invalid configuration".
 * The NTRIP password is redacted before the configuration is logged.
 *
 * @param obj The configuration object as saved by the admin UI.
 * @param debug Debug logger.
 * @returns A human-readable problem description, or `undefined` when the
 *   configuration is usable.
 */
export function describeConfigurationProblem(obj: any, debug: Debug = noopDebug): string | undefined {
  // Never log the whole config object: it carries the NTRIP password.
  const { password, ...loggable } = obj ?? {};
  debug('%j', { ...loggable, password: password ? '***' : undefined })

  if (!obj || typeof obj !== 'object') {
    return 'no configuration supplied';
  }

  // Always validate serial connection is provided
  if (typeof obj.serialconnection !== 'string' || obj.serialconnection.trim() === '') {
    return 'no serial connection selected';
  }

  // Only validate NTRIP configuration if NTRIP is enabled
  if (obj.ntripEnabled === true) {
    for (const key of ['host', 'mountpoint', 'username', 'password'] as const) {
      if (typeof obj[key] !== 'string' || obj[key].trim() === '') {
        return `NTRIP is enabled but "${key}" is not set (untick "NTRIP Enabled" to use the receiver without corrections)`;
      }
    }

    for (const key of ['port', 'interval', 'latitude', 'longitude'] as const) {
      if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) {
        return `NTRIP is enabled but "${key}" is not set (untick "NTRIP Enabled" to use the receiver without corrections)`;
      }
    }

    // Both are optional, but ntrip-client only falls back to its own defaults
    // for a falsy value: `options.reconnectInterval || RECONNECT_INTERVAL`. A
    // negative interval survives that and then trips the `<= 0` guard in
    // _reconnect(), which returns without reconnecting - corrections stop for
    // good on the first dropped connection, silently. A truthy non-number
    // reaches setTimeout() and the sleep timer intact. The admin form enforces
    // the schema's minimum, but a hand-edited settings file does not, and this
    // is the gate that decides whether the plugin runs at all.
    for (const key of ['timeout', 'reconnectInterval'] as const) {
      if (obj[key] === undefined) {
        continue;
      }
      if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key]) || obj[key] < MIN_NTRIP_TIMING_MS) {
        return `NTRIP "${key}" must be a number of at least ${MIN_NTRIP_TIMING_MS} milliseconds`;
      }
    }

    if (obj.port <= 0 || obj.port > 65535) {
      return `NTRIP port ${obj.port} is out of range`;
    }
    if (obj.interval <= 0) {
      return `NTRIP interval ${obj.interval} must be positive`;
    }
    // 0,0 is what an untouched form yields, not a position anyone configures.
    // Accepting it sends the caster a reference position in the Gulf of Guinea
    // and a VRS mountpoint then returns corrections for the wrong place.
    if (obj.latitude === 0 && obj.longitude === 0) {
      return 'NTRIP latitude and longitude are both 0 - set the receiver\'s approximate position';
    }
    if (obj.latitude < -90 || obj.latitude > 90) {
      return `NTRIP latitude ${obj.latitude} is out of range`;
    }
    if (obj.longitude < -180 || obj.longitude > 180) {
      return `NTRIP longitude ${obj.longitude} is out of range`;
    }
  }

  return undefined;
}

export default pluginFactory;
