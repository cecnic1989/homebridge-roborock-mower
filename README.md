<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">
</p>

# homebridge-roborock-mower

[![npm version](https://img.shields.io/npm/v/@cecnic1989/homebridge-roborock-mower.svg)](https://www.npmjs.com/package/@cecnic1989/homebridge-roborock-mower)
[![Build and Lint](https://img.shields.io/github/actions/workflow/status/cecnic1989/homebridge-roborock-mower/build.yml?branch=latest)](https://github.com/cecnic1989/homebridge-roborock-mower/actions/workflows/build.yml)

Homebridge plugin for Roborock RockMow robot lawn mowers. Exposes your mower to Apple Home.

> **Early development.** Status sensors and battery work (tested on a RockMow Z1 / X120H). Controls are next.

## Features

- **State sensors** for Home-app automations: Docked, Leaving, Mowing, Returning (each a contact sensor, live via Roborock's cloud push)
- **Needs Attention** sensor for Home-app notifications when the mower is stuck, faulted, or was stopped with its button
- **Battery** level, charging state, low-battery flag
- **Fault indicator** on every sensor when the mower reports an error

Planned: start / pause / return-to-dock controls.

## Automations

Each state is a contact sensor so the Home app can trigger on it ("A Sensor Detects Something"):

| Sensor | Opens when | Closes when |
|---|---|---|
| **Docked** | it leaves the dock | it is back on the dock (charging or charged) |
| **Leaving** | a job starts (initializing / undocking) | it begins cutting |
| **Mowing** | it starts cutting or driving to a zone | cutting stops |
| **Returning** | it heads back to the dock | it reaches the dock |
| **Needs Attention** | it reports an error, a fault, or its STOP button was pressed | the condition clears |

Example for a dock inside a garage: *Docked opens → open garage*, *Mowing opens → close garage*, *Returning opens → open garage*, *Docked closes → close garage*.
Prefer **Docked opens** over *Leaving opens* for the departure trigger: both fire on the same push, but Docked can only open once per trip. The mower starts driving ~1.5 s after that push, so if the door needs longer, add a time-based automation on the mowing schedule as well.

**Notifications:** no automation needed — in the Home app open the *Needs Attention* sensor → *Status and Notifications* → turn on *Notify when opens*. It opens on the push that reports the problem (no debounce). Pauses made from the app do not trigger it.

Accessories take the name you gave the mower in the Roborock app (renames follow on the next sync); names you set in the Home app are kept.

Sensors flip only after a state holds for `sensorDebounceSeconds` (default 3 s); faults and battery update immediately. While the cloud connection is down, sensors show as inactive rather than stale.

## Requirements

- Homebridge `^1.8.0` or `^2.0.0-beta.0`
- Node.js `^20.19.0 || ^22.10.0 || ^24.0.0`
- A Roborock account (same credentials as the Roborock mobile app)

## Installation

Homebridge UI: **Plugins** → search `@cecnic1989/homebridge-roborock-mower`.

## Configuration

1. Homebridge UI → **Plugins** → **Roborock Mower** → **Settings**.
2. Enter your Roborock account email and press **Send code**.
3. Enter the verification code Roborock emails you and press **Verify & save**.
4. Restart Homebridge.

Sign-in stores the cloud token in `<homebridge storage>/roborock-mower/session.json` (owner-only permissions); treat it like a password. Use **Sign out** in the settings page to remove it.

Optional fields:

| Field | Default | Description |
|---|---|---|
| `exposeDocked`, `exposeLeaving`, `exposeMowing`, `exposeReturning` | `true` | Which state sensors to create |
| `exposeAttention` | `true` | Needs Attention sensor (errors, faults, emergency stop) |
| `exposeBattery` | `true` | Battery service |
| `faultIndicator` | `true` | Set StatusFault on the sensors when the mower reports an error |
| `sensorDebounceSeconds` | `3` | How long a state must hold before its sensor flips (0–60) |
| `pollInterval` | `3600` | Cloud re-sync interval in seconds (min 900). Live state comes by push; Roborock rate-limits this call, so keep it high |

## Support

If your mower isn't picked up, or a control doesn't behave correctly on it, [open an issue](https://github.com/cecnic1989/homebridge-roborock-mower/issues) with your model number and Homebridge debug logs (`homebridge -D`).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, local testing, and design notes.

## License

Apache-2.0
