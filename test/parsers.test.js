const test = require('node:test');
const assert = require('node:assert');

const {
  CONVERTERS,
  createSentenceParser,
  decodeBestSatMask,
  describeConfigurationProblem,
  headingToRadians,
  parseBestSat,
  uniheadingAParser
} = require('../dist/plugin.js');

const HEADING_OFFSET = 90;

const ctx = (overrides = {}) => {
  const configMap = overrides.configMap || {};
  const deltas = [];
  return {
    deltas,
    configMap,
    ctx: {
      debug: () => { },
      headingOffset: overrides.headingOffset === undefined ? HEADING_OFFSET : overrides.headingOffset,
      configMap: () => configMap,
      handleMessage: (d) => deltas.push(d)
    }
  };
};

const valueOf = (values, path) => {
  const found = values.find(v => v.path === path);
  return found === undefined ? undefined : found.value;
};

const deg = (radians) => radians * 180 / Math.PI;

// A real UNIHEADINGA body. Field order verified against Unicore documentation:
// sol status, pos type, baseline length, heading, pitch, reserved,
// heading std dev, pitch std dev, station id, #SVs tracked, #SVs in solution,
// #SVs above mask, #SVs above mask w/ L2, solution source, ext sol status,
// Galileo/BeiDou signal mask, GPS/GLONASS signal mask.
const UNIHEADINGA_FIX =
  '#UNIHEADINGA,93,GPS,FINE,2385,326592000,0,0,18,10;' +
  'SOL_COMPUTED,L1_INT,2.7889,296.7233,-25.7710,0.0000,0.1127,0.1812,"999",49,37,37,0,3,00,1,51*1a';

test('UNIHEADINGA maps every field to the quantity it actually carries', () => {
  const { ctx: c } = ctx();
  const values = uniheadingAParser([], UNIHEADINGA_FIX.split('*')[0], c);

  assert.strictEqual(valueOf(values, 'sensors.rtk.solutionStatus'), 'SOL_COMPUTED');
  assert.strictEqual(valueOf(values, 'sensors.rtk.positionType'), 'L1_INT');
  assert.strictEqual(valueOf(values, 'sensors.rtk.baselineLength'), 2.7889);

  // 296.7233 + 90 offset, wrapped into [0, 360)
  assert.ok(Math.abs(deg(valueOf(values, 'navigation.headingTrue')) - 26.7233) < 1e-9);
  assert.ok(Math.abs(deg(valueOf(values, 'navigation.attitude.pitch')) - -25.7710) < 1e-9);

  // Fields 6 and 7 are standard deviations, not HDOP/VDOP.
  assert.ok(Math.abs(deg(valueOf(values, 'sensors.rtk.headingStdDev')) - 0.1127) < 1e-9);
  assert.ok(Math.abs(deg(valueOf(values, 'sensors.rtk.pitchStdDev')) - 0.1812) < 1e-9);

  assert.strictEqual(valueOf(values, 'navigation.satellites.inView'), 49);
  assert.strictEqual(valueOf(values, 'navigation.satellites.used'), 37);
});

test('UNIHEADINGA no longer publishes DOP, per-constellation counts or position age', () => {
  const { ctx: c } = ctx();
  const values = uniheadingAParser([], UNIHEADINGA_FIX.split('*')[0], c);
  const paths = values.map(v => v.path);

  for (const gone of [
    'navigation.positionHdop',
    'navigation.positionVdop',
    'navigation.satellites.GPS',
    'navigation.satellites.GLONASS',
    'navigation.satellites.GALILEO',
    'navigation.position.age',
    'navigation.position.dgpsAge'
  ]) {
    assert.ok(!paths.includes(gone), `${gone} should not be published`);
  }
});

test('UNIHEADINGA with no solution nulls the heading and publishes nothing derived', () => {
  const sentence = '#UNIHEADINGA,93,GPS,FINE,2385,326592000,0,0,18,10;' +
    'INSUFFICIENT_OBS,NONE,0.0000,0.0000,0.0000,0.0000,0.0000,0.0000,"0",0,0,0,0,0,00,0,0';
  const { ctx: c } = ctx();
  const values = uniheadingAParser([], sentence, c);

  assert.strictEqual(valueOf(values, 'navigation.headingTrue'), null);
  assert.strictEqual(valueOf(values, 'sensors.rtk.baselineLength'), undefined);
  assert.strictEqual(valueOf(values, 'navigation.satellites.used'), undefined);
});

test('UNIHEADINGA truncated mid-sentence never publishes NaN', () => {
  const sentence = '#UNIHEADINGA,93,GPS,FINE,2385,326592000,0,0,18,10;SOL_COMPUTED,L1_INT,2.7889';
  const { ctx: c } = ctx();
  const values = uniheadingAParser([], sentence, c);

  assert.ok(values.length > 0);
  for (const { path, value } of values) {
    assert.ok(!Number.isNaN(value), `${path} should not be NaN`);
    assert.notStrictEqual(value, undefined, `${path} should not be undefined`);
  }
});

test('UNIHEADINGA truncated before the position type omits it entirely', () => {
  // Every published entry must carry a value: `{value: undefined}` serialises
  // to a delta entry with no value key at all.
  const { ctx: c } = ctx();
  const values = uniheadingAParser([], '#UNIHEADINGA,93,GPS,FINE,2385,326592000,0,0,18,10;INSUFFICIENT_OBS', c);

  assert.ok(!values.some(v => v.path === 'sensors.rtk.positionType'));
  assert.strictEqual(valueOf(values, 'sensors.rtk.solutionStatus'), 'INSUFFICIENT_OBS');
  assert.strictEqual(valueOf(values, 'navigation.headingTrue'), null);
  for (const v of values) {
    assert.ok('value' in v, `${v.path} has no value key`);
    assert.notStrictEqual(v.value, undefined, `${v.path} is undefined`);
  }
});

test('UNIHEADINGA with no data section yields nothing', () => {
  const { ctx: c } = ctx();
  assert.deepStrictEqual(uniheadingAParser([], '#UNIHEADINGA,93,GPS,FINE', c), []);
});

test('headingToRadians wraps into [0, 2pi) and rejects non-numbers', () => {
  assert.strictEqual(headingToRadians(0, 0), 0);
  assert.ok(Math.abs(deg(headingToRadians(350, 90)) - 80) < 1e-9);
  assert.ok(Math.abs(deg(headingToRadians(10, -90)) - 280) < 1e-9);
  assert.ok(headingToRadians(359.9, 0) < 2 * Math.PI);
  assert.strictEqual(headingToRadians(NaN, 90), null);
});

test('HPR reports null heading when the quality flag says no fix', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);

  parser.sentence('$GNHPR,123519.00,0.00,0.00,0.00,0,0,0.0,0*1a');
  assert.strictEqual(deltas[0].updates[0].values[0].value, null);

  parser.sentence('$GNHPR,123519.00,270.00,1.00,0.00,4,20,0.0,0*1a');
  // 270 + 90 offset wraps to 0
  assert.ok(Math.abs(deltas[1].updates[0].values[0].value) < 1e-9);
});

test('HPR is accepted from any talker id', () => {
  const { ctx: c, deltas } = ctx();
  createSentenceParser(c).sentence('$GPHPR,123519.00,180.00,1.00,0.00,4,20,0.0,0*1a');
  assert.strictEqual(deltas.length, 1);
  assert.ok(Math.abs(deg(deltas[0].updates[0].values[0].value) - 270) < 1e-9);
});

test('$CONFIG keeps the whole value and does not truncate trailing digits', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);

  // Trimmed of its CR, as the multiplexed path delivers it.
  parser.sentence('$CONFIG,COM1,CONFIG COM1 115200*1E');
  assert.strictEqual(deltas[0].updates[0].values[0].value.COM1, '115200');

  // With the CR still attached, as the raw NMEA0183 path delivers it.
  parser.sentence('$CONFIG,COM2,CONFIG COM2 9600*1E\r');
  assert.strictEqual(deltas[1].updates[0].values[0].value.COM2, '9600');
});

test('$CONFIG publishes a copy, so delivered deltas are not mutated later', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);

  parser.sentence('$CONFIG,COM1,CONFIG COM1 115200*1E');
  const first = deltas[0].updates[0].values[0].value;
  parser.sentence('$CONFIG,COM2,CONFIG COM2 9600*1E');

  assert.deepStrictEqual(first, { COM1: '115200' });
});

test('a truncated $CONFIG does not throw', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);
  assert.doesNotThrow(() => parser.sentence('$CONFIG'));
  assert.doesNotThrow(() => parser.sentence('$CONFIG,COM1'));
  assert.strictEqual(deltas.length, 0);
});

test('#MODE publishes just the mode, without header fields or checksum', () => {
  const { ctx: c, deltas } = ctx();
  createSentenceParser(c).sentence('#MODE,97,GPS,FINE,2389,362704000,0,0,18;MODE ROVER UAV*cf');
  assert.deepStrictEqual(deltas[0].updates[0].values[0], {
    path: 'navigation.gnss.um982.mode',
    value: 'ROVER UAV'
  });
});

test('a truncated #MODE publishes nothing rather than the literal "MODE"', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);

  parser.sentence('#MODE,97,GPS,FINE,2389,362704000,0,0,18;MODE');
  parser.sentence('#MODE,97,GPS,FINE,2389,362704000,0,0,18;MODE ');
  parser.sentence('#MODE,97,GPS,FINE,2389,362704000,0,0,18;');
  assert.strictEqual(deltas.length, 0);

  // A complete sentence still parses.
  parser.sentence('#MODE,97,GPS,FINE,2389,362704000,0,0,18;MODE ROVER UAV*cf');
  assert.strictEqual(deltas[0].updates[0].values[0].value, 'ROVER UAV');
});

test('multiplexed lines are unwrapped, and plain sentences still parse', () => {
  const { ctx: c, deltas } = ctx();
  const parser = createSentenceParser(c);

  parser.multiplexed(`1970-01-01T00:00:00.000Z;um982;${UNIHEADINGA_FIX}`);
  assert.strictEqual(deltas.length, 1);
  assert.ok(valueOf(deltas[0].updates[0].values, 'navigation.headingTrue') > 0);

  // A line that never had the multiplexer prefix is parsed rather than dropped.
  parser.multiplexed('$GNHPR,123519.00,180.00,1.00,0.00,4,20,0.0,0*1a');
  assert.strictEqual(deltas.length, 2);
});

test('a malformed sentence never throws out of the parser', () => {
  const { ctx: c } = ctx();
  const parser = createSentenceParser(c);
  for (const line of ['', ',,,', '#UNIHEADINGA', '#BESTSATA,1,2,3,4,5,6,7,8,9,10', '$GNHPR']) {
    assert.doesNotThrow(() => parser.sentence(line), line);
  }
});

test('BESTSATA decodes satellites and tolerates a short tail', () => {
  const sats = parseBestSat('#BESTSATA,90,GPS,FINE,2389,362704000,0,0,18,24;2,GPS,1,GOOD,00000017,GLO,2,GOOD,00000011');
  assert.strictEqual(sats.length, 2);
  assert.deepStrictEqual(sats[0], {
    // 0x17 = L1CA | L1P | L1M | L2M
    gnss: 'GPS', id: '1', mask: '00000017', signals: ['L1CA', 'L1P', 'L1M', 'L2M']
  });
  assert.strictEqual(sats[1].gnss, 'GLO');

  // Claims 5 satellites but only carries one.
  assert.strictEqual(parseBestSat('#BESTSATA,x;5,GPS,1,GOOD,00000001').length, 1);
  assert.deepStrictEqual(parseBestSat('#BESTSATA,no-data-section'), []);
});

test('decodeBestSatMask accepts abbreviated constellation names', () => {
  assert.deepStrictEqual(decodeBestSatMask('00000003', 'GLO'), ['L1CA', 'L1P']);
  assert.deepStrictEqual(decodeBestSatMask('00000003', 'GLONASS'), ['L1CA', 'L1P']);
  assert.deepStrictEqual(decodeBestSatMask('00000003', 'GAL'), ['E1B', 'E1C']);
  assert.deepStrictEqual(decodeBestSatMask('00000003', 'BDS'), ['B1I', 'B1Q']);
  assert.deepStrictEqual(decodeBestSatMask('zz', 'GPS'), ['0xzz']);
});

test('configuration validation explains what is wrong', () => {
  assert.strictEqual(describeConfigurationProblem({ serialconnection: '/dev/ttyUSB0' }), undefined);
  assert.match(describeConfigurationProblem({}), /serial connection/);
  assert.match(describeConfigurationProblem({ serialconnection: '  ' }), /serial connection/);
  assert.match(describeConfigurationProblem(undefined), /no configuration/);

  // The README's "leave RTK empty" flow must be accepted.
  assert.strictEqual(
    describeConfigurationProblem({ serialconnection: '/dev/ttyUSB0', ntripEnabled: false }),
    undefined
  );

  const ntrip = {
    serialconnection: '/dev/ttyUSB0', ntripEnabled: true, host: 'caster',
    mountpoint: 'MP', username: 'u', password: 'p', port: 2101, interval: 2000,
    latitude: 60, longitude: 25
  };
  assert.strictEqual(describeConfigurationProblem(ntrip), undefined);
  assert.match(describeConfigurationProblem({ ...ntrip, host: '' }), /"host"/);
  assert.match(describeConfigurationProblem({ ...ntrip, latitude: undefined }), /"latitude"/);
  assert.match(describeConfigurationProblem({ ...ntrip, port: 0 }), /port/);
  // 0,0 is the untouched-form default, not a position anyone configures.
  assert.match(
    describeConfigurationProblem({ ...ntrip, latitude: 0, longitude: 0 }),
    /both 0/
  );
  // A real position on one axis is still fine.
  assert.strictEqual(describeConfigurationProblem({ ...ntrip, latitude: 0 }), undefined);
  assert.strictEqual(describeConfigurationProblem({ ...ntrip, longitude: 0 }), undefined);
  assert.match(describeConfigurationProblem({ ...ntrip, latitude: 91 }), /latitude/);
});

test('configuration validation never logs the NTRIP password', () => {
  const logged = [];
  describeConfigurationProblem(
    { serialconnection: '/dev/ttyUSB0', ntripEnabled: false, password: 'hunter2' },
    (fmt, ...args) => logged.push(JSON.stringify(args))
  );
  assert.ok(logged.length > 0);
  assert.ok(!logged.join(' ').includes('hunter2'));
});

test('UNIHEADINGA always publishes a heading, however truncated the sentence', () => {
  // Without this the last good heading stays live in the model after a
  // truncated sentence - the stale-heading case this parser exists to prevent.
  const header = '#UNIHEADINGA,93,GPS,FINE,2385,326592000,0,0,18,10;';
  const bodies = [
    'SOL_COMPUTED',
    'SOL_COMPUTED,',
    'SOL_COMPUTED,   ',
    'SOL_COMPUTED,NONE',
    'SOL_COMPUTED,L1_INT',
    'SOL_COMPUTED,L1_INT,2.7889',
    'INSUFFICIENT_OBS',
    'INSUFFICIENT_OBS,NONE,0.0,0.0'
  ];

  for (const body of bodies) {
    const { ctx: c } = ctx();
    const values = uniheadingAParser([], header + body, c);
    const heading = values.find(v => v.path === 'navigation.headingTrue');
    assert.notStrictEqual(heading, undefined, `no heading published for "${body}"`);
    assert.strictEqual(heading.value, null, `heading should be null for "${body}"`);
    for (const v of values) {
      assert.ok('value' in v, `${v.path} has no value key for "${body}"`);
      assert.notStrictEqual(v.value, undefined, `${v.path} undefined for "${body}"`);
      assert.ok(!Number.isNaN(v.value), `${v.path} is NaN for "${body}"`);
    }
  }
});

test('every parser survives progressive truncation of a real sentence', () => {
  // Systematic sweep rather than hand-picked cases: truncate each sentence at
  // every character boundary and assert nothing throws and nothing publishes
  // an undefined or NaN value.
  const sentences = [
    UNIHEADINGA_FIX,
    '#MODE,97,GPS,FINE,2389,362704000,0,0,18;MODE ROVER UAV*cf',
    '#BESTSATA,90,GPS,FINE,2389,362704000,0,0,18,24;2,GPS,1,GOOD,00000017,GLO,2,GOOD,00000011*aa',
    '$GNHPR,123519.00,270.00,1.00,0.00,4,20,0.0,0*1a',
    '$CONFIG,COM1,CONFIG COM1 115200*1E'
  ];

  for (const sentence of sentences) {
    for (let i = 0; i <= sentence.length; i++) {
      const truncated = sentence.slice(0, i);
      const { ctx: c, deltas } = ctx();
      const parser = createSentenceParser(c);
      assert.doesNotThrow(() => parser.sentence(truncated), `threw on "${truncated}"`);
      for (const delta of deltas) {
        for (const v of delta.updates[0].values) {
          assert.ok('value' in v, `${v.path} has no value key for "${truncated}"`);
          assert.notStrictEqual(v.value, undefined, `${v.path} undefined for "${truncated}"`);
          assert.ok(
            typeof v.value !== 'number' || Number.isFinite(v.value),
            `${v.path} is ${v.value} for "${truncated}"`
          );
        }
      }
    }
  }
});

test('CONVERTERS indexes stay within the documented UNIHEADINGA layout', () => {
  for (const c of CONVERTERS.UNIHEADINGA) {
    assert.ok(c.index >= 0 && c.index <= 16, `${c.path} index ${c.index} out of range`);
  }
});
