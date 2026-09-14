# Signal K plugin for interfacing with Unicore UM982 RTK GNSS receivers with NTRIP integration

This plugin allows Signal K to interface with the [Unicore UM982](https://en.unicorecomm.com/products/detail/26) GNSS positioning and heading module. You can use it to configure the device, mainly sentences output. It also includes a webapp for visualising position and heading drift as well as the satellites visible, in use and their signals. Most of the data is available for both the main and the slave antennas.

The plugin also includes NTRIP client functionality that can provide the receiver with RTCM data over the Internet.

Requires Signal K Server >= v2.18.0 for serial port integration.

<img width="1424" height="937" alt="Image" src="https://github.com/user-attachments/assets/0d1c05b5-efea-415f-ae3d-de83a553b56c" />

## Getting Started

- configure the UM982 serial device with 115200 bps
- the serial connection should show up in the plugin configuration - select & save, rtk connection can be left empty
- NTRIP is disabled by default. Tick **NTRIP Enabled** only when you have caster
  details to enter; every NTRIP field is then required, and the plugin reports
  which one is missing if you save an incomplete form.
- set **Heading Offset** to the angle from the bow to the master->slave antenna
  baseline. It defaults to 90 degrees, which suits an athwartships antenna pair;
  use 0 for antennas mounted along the centreline.

### Published paths

| Path | Unit | Source |
| --- | --- | --- |
| `navigation.headingTrue` | rad | UNIHEADINGA heading / `$--HPR`, plus the heading offset. `null` when the receiver reports no solution |
| `navigation.attitude.pitch` | rad | UNIHEADINGA pitch |
| `navigation.satellites.inView` | count | UNIHEADINGA #SVs tracked |
| `navigation.satellites.used` | count | UNIHEADINGA #SVs in solution |
| `navigation.gnss.um982.mode` | string | `#MODE` |
| `sensors.rtk.solutionStatus` | string | UNIHEADINGA sol-stat |
| `sensors.rtk.positionType` | string | UNIHEADINGA pos-type |
| `sensors.rtk.baselineLength` | m | UNIHEADINGA baseline length |
| `sensors.rtk.headingStdDev` | rad | UNIHEADINGA heading standard deviation |
| `sensors.rtk.pitchStdDev` | rad | UNIHEADINGA pitch standard deviation |
| `sensors.rtk.um982` | object | `$CONFIG` response |

Reference station positions decoded from RTCM 1005/1006 are published under the
`rtkstations.<id>` context.

### Unverified

The plugin writes both ASCII commands and binary RTCM correction frames to the
same serial `toStdout` event. If the Signal K serial provider coerces that
payload to UTF-8 or appends a line terminator, the correction stream would be
corrupted and the receiver would never reach an RTK fix. This has not been
checked against a running server - worth confirming before relying on NTRIP.

## Development

```
npm install
npm test     # builds, then runs the parser and geodesy tests
```

## TODO

- set frequency of different messages 1/10/30/none
- query frequency of different messages
- query rover mode
- checksum checking?
- show firmware revision?
- saveconfig
- reset to factory settings
- NTRIP latlon from data
- work over webusb functionality
- check main ja slave
- parse `$GPGSVH` so the webapp's sky plot and SNR charts have a data source
  (they subscribe to `navigation.gnss.satellitesInView` / `satellitesUsed`,
  which nothing currently publishes)
- push the heading offset into the receiver with `CONFIG HEADING OFFSET`
  instead of applying it in software
