const test = require('node:test');
const assert = require('node:assert');

const pluginFactory = require('../dist/plugin.js').default;

// Minimal ServerAPI stand-in. onPropertyValues deliberately does NOT replay
// anything at subscribe time: that is the server-boot case, where the plugins
// start before the server has enumerated its serial ports and connections.
// Toggling the plugin with the server already up replays immediately, which is
// why that path never showed the bug.
const fakeApp = () => {
  const subscribers = {};
  const statuses = [];
  const errors = [];
  const listeners = {};
  return {
    statuses,
    errors,
    deliver: (name, values) => (subscribers[name] || []).forEach(cb => cb(values)),
    app: {
      debug: () => { },
      onPropertyValues: (name, cb) => {
        (subscribers[name] = subscribers[name] || []).push(cb);
        return () => {
          subscribers[name] = subscribers[name].filter(c => c !== cb);
        };
      },
      setPluginStatus: (m) => statuses.push(m),
      setPluginError: (m) => errors.push(m),
      handleMessage: () => { },
      emit: () => true,
      on: (e, l) => { (listeners[e] = listeners[e] || []).push(l); },
      removeListener: () => { }
    }
  };
};

const CONFIG = { serialconnection: '/dev/ttyUSB0', ntripEnabled: false };

const serialPortValues = (id) => [{ value: { id, eventNames: { toStdout: `${id}.out` } } }];
const providerValues = () => [
  { value: { id: 'um982', type: 'NMEA0183', eventNames: { received: 'um982.received' } } }
];

test('a server restart does not report the plugin as failed before discovery', (t) => {
  // The real report: "Last error: No serial ports detected" after a Signal K
  // restart, never after toggling the plugin off and on.
  const { app, statuses, errors, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  // Registered before start: a failing assertion must not leak the plugin's
  // 1s status interval, or the test run hangs instead of reporting.
  t.after(() => plugin.stop());

  plugin.start({ ...CONFIG });

  assert.deepStrictEqual(
    errors.filter(e => e !== ''),
    [],
    `no error may be raised before the server has enumerated anything, got ${JSON.stringify(errors)}`
  );
  assert.ok(
    statuses.some(s => /^Starting/.test(s)),
    `status should say it is still starting, got ${JSON.stringify(statuses)}`
  );
});

test('the startup problem is cleared once the ports and connections arrive', (t) => {
  const { app, errors, statuses, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  // Registered before start: a failing assertion must not leak the plugin's
  // 1s status interval, or the test run hangs instead of reporting.
  t.after(() => plugin.stop());

  plugin.start({ ...CONFIG });
  deliver('pipedprovider', providerValues());
  deliver('serialport', serialPortValues('/dev/ttyUSB0'));

  // Signal K keeps a plugin error until it is explicitly cleared, so becoming
  // healthy must clear it - not merely stop re-raising it.
  assert.ok(
    errors.includes(''),
    `the error must be cleared once healthy, got ${JSON.stringify(errors)}`
  );
  assert.strictEqual(statuses[statuses.length - 1], 'No RTCM data received yet');
});

test('a genuinely missing serial port is still reported once discovery has had its chance', (t) => {
  // The grace period must delay the error, not suppress it: a receiver that is
  // really absent still has to show up as a fault.
  t.mock.timers.enable({ apis: ['Date'] });
  const { app, errors, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  // Registered before start: a failing assertion must not leak the plugin's
  // 1s status interval, or the test run hangs instead of reporting.
  t.after(() => plugin.stop());

  plugin.start({ ...CONFIG });
  deliver('pipedprovider', providerValues());
  // Another adapter is present, but not the configured receiver.
  deliver('serialport', serialPortValues('/dev/ttyACM9'));
  assert.deepStrictEqual(errors.filter(e => e !== ''), [], 'still inside the grace period');

  t.mock.timers.tick(20000);
  deliver('serialport', serialPortValues('/dev/ttyACM9'));

  assert.ok(
    errors.some(e => e.includes('/dev/ttyUSB0') && /not connected/.test(e)),
    `the configured port being absent must be reported, got ${JSON.stringify(errors)}`
  );
});

test('no serial ports at all is still reported once discovery has had its chance', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { app, errors, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  // Registered before start: a failing assertion must not leak the plugin's
  // 1s status interval, or the test run hangs instead of reporting.
  t.after(() => plugin.stop());

  plugin.start({ ...CONFIG });
  deliver('pipedprovider', providerValues());
  t.mock.timers.tick(20000);
  deliver('serialport', []);

  assert.ok(
    errors.some(e => e === 'No serial ports detected'),
    `got ${JSON.stringify(errors)}`
  );
});

test('a malformed serial port entry does not blind the plugin to the others', (t) => {
  // knownSerialPorts is cleared before the list is rebuilt, so a throw here
  // used to leave the plugin believing no port existed for the rest of the run.
  const { app, errors, statuses, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  // Registered before start: a failing assertion must not leak the plugin's
  // 1s status interval, or the test run hangs instead of reporting.
  t.after(() => plugin.stop());

  plugin.start({ ...CONFIG });
  deliver('pipedprovider', providerValues());
  assert.doesNotThrow(() => deliver('serialport', [
    null,
    {},
    { value: null },
    { value: { id: 42 } },
    { value: { id: '/dev/ttyUSB0', eventNames: { toStdout: 'out' } } }
  ]));

  assert.ok(errors.includes(''), `should still find the good port, got ${JSON.stringify(errors)}`);
  assert.strictEqual(statuses[statuses.length - 1], 'No RTCM data received yet');
});

test('an NTRIP startup failure is not wiped by the next status refresh', (t) => {
  // The status refresh runs every second and clears the plugin error when
  // discovery is healthy. Without a separate hold, it replaced "Could not
  // start NTRIP client: ..." with "No RTCM data received yet" a second later,
  // and the operator never learned why corrections were missing.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

  // Patch the module the plugin resolves startRTCM through, so the failure
  // path is exercised without a caster.
  const ntrip = require('../dist/ntrip.js');
  const realStartRTCM = ntrip.startRTCM;
  ntrip.startRTCM = () => { throw new Error('caster unreachable'); };
  t.after(() => { ntrip.startRTCM = realStartRTCM; });

  const { app, errors, statuses, deliver } = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());

  plugin.start({
    ...CONFIG,
    ntripEnabled: true,
    host: 'caster.example', mountpoint: 'MP', username: 'u', password: 'p',
    port: 2101, interval: 2000, latitude: 60, longitude: 25
  });
  deliver('pipedprovider', providerValues());
  deliver('serialport', serialPortValues('/dev/ttyUSB0'));

  t.mock.timers.tick(1000);   // the startup timer fires, startRTCM throws
  assert.ok(
    errors.some(e => e.includes('Could not start NTRIP client')),
    `the startup failure must be reported, got ${JSON.stringify(errors)}`
  );

  const statusesBefore = statuses.length;
  t.mock.timers.tick(1000);   // the status refresh must not erase it

  assert.ok(
    errors[errors.length - 1].includes('Could not start NTRIP client'),
    `the startup failure must survive the status refresh, got ${JSON.stringify(errors.slice(-3))}`
  );
  assert.ok(
    !errors.slice(-1).includes(''),
    'the refresh must not clear the plugin error while the failure stands'
  );
  // The refresh must not report the plugin healthy over the top of it.
  assert.deepStrictEqual(
    statuses.slice(statusesBefore),
    [],
    `no healthy status may be published while NTRIP is failed, got ${JSON.stringify(statuses.slice(statusesBefore))}`
  );
});
