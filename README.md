<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">
</p>

# homebridge-roborock-mower

[![npm version](https://img.shields.io/npm/v/@cecnic1989/homebridge-roborock-mower.svg)](https://www.npmjs.com/package/@cecnic1989/homebridge-roborock-mower)
[![Build and Lint](https://img.shields.io/github/actions/workflow/status/cecnic1989/homebridge-roborock-mower/build.yml?branch=latest)](https://github.com/cecnic1989/homebridge-roborock-mower/actions/workflows/build.yml)

Apple Home support for Roborock RockMow robot lawn mowers. Tested on a RockMow Z1 / X120H.

## Features

- **State sensors** — Docked, Leaving, Mowing, Returning; contact sensors driven by Roborock's cloud push
- **Needs Attention** — opens when the mower is stuck, faulted, or stopped with its button
- **Battery** — level, charging state, low-battery flag
- **Mow and Pause switches** — optional; start, dock, pause and resume from Siri or automations

## Automations

Each state is a contact sensor, so Home triggers on it with *A Sensor Detects Something*:

| Sensor | Opens when | Closes when |
|---|---|---|
| **Docked** | it leaves the dock | it is back on the dock |
| **Leaving** | a job starts (initializing / undocking) | it begins cutting |
| **Mowing** | it starts cutting or driving to a zone | cutting stops |
| **Returning** | it heads back to the dock | it reaches the dock |
| **Needs Attention** | it reports an error or fault, or STOP was pressed | the condition clears |

**Dock inside a garage.** Use *Docked opens → open door*, *Returning opens → open door*, *Docked closes → close door*.

Two things to know before automating the door:

- **Do not close the door on Mowing.** Mowing opens while the mower is still inside the garage. Leave the door open for the duration of the mow, or close it on a timer.
- Prefer **Docked opens** over *Leaving opens* to trigger the departure: both fire on the same push, but Docked can only open once per trip. The mower starts moving ~1.5 s later, so if your door is slow, also trigger from the mowing schedule.

**Notifications** need no automation: open the *Needs Attention* sensor in Home → *Status and Notifications* → *Notify when opens*. Pauses made from the Roborock app do not trigger it.

## Controls

Off by default. Enable **Control switches (Mow, Pause)** in the plugin settings and restart Homebridge:

| Switch | Turn on | Turn off |
|---|---|---|
| **Mow** | start a full-lawn mow | send it back to the dock |
| **Pause** | pause the current job | resume it |

Switches reflect the mower's real state, so a job started in the Roborock app reads as Mow on. A paused or rain-delayed job still counts as on — turning Mow off then cancels it and docks. Rejected or unanswered commands surface as an error in Home and the switch keeps its true value.

> **Scenes:** "turn everything on" flips every switch in the room, including Mow. Keep the switches out of scenes, or leave controls off.

## Behaviour notes

- Accessories take the mower's name from the Roborock app; names you set in Home are kept.
- Sensors flip only after a state holds for `sensorDebounceSeconds`. This rides out the brief dock-contact flap when the mower resumes from a mid-job charge, which would otherwise re-trigger dock automations. Faults and battery update immediately.
- Roborock's servers sometimes stop delivering updates without the connection appearing to drop. The plugin detects this and reconnects on its own; sensors show as inactive rather than stale while it does.

## Requirements

- Homebridge `^1.8.0` or `^2.0.0-beta.0`
- Node.js `^20.19.0 || ^22.10.0 || ^24.0.0`
- A Roborock account (same credentials as the mobile app)

## Setup

Install from the Homebridge UI: **Plugins** → search `@cecnic1989/homebridge-roborock-mower`.

Then **Plugins** → **Roborock Mower** → **Settings**: enter your Roborock email, press **Send code**, enter the emailed code, press **Verify & save**, and restart Homebridge.

Sign-in stores a cloud token in `<homebridge storage>/roborock-mower/session.json` (owner-only). Treat it like a password; **Sign out** removes it.

## Options

| Field | Default | Description |
|---|---|---|
| `exposeDocked`, `exposeLeaving`, `exposeMowing`, `exposeReturning` | `true` | Which state sensors to create |
| `exposeAttention` | `true` | Needs Attention sensor |
| `exposeBattery` | `true` | Battery service |
| `exposeControls` | `false` | Mow and Pause switches |
| `faultIndicator` | `true` | Set StatusFault on sensors when the mower reports an error |
| `sensorDebounceSeconds` | `15` | How long a state must hold before its sensor flips (0–60) |
| `mqttLivenessProbe` | `true` | Check the live connection is still delivering, and reconnect if not |
| `pollInterval` | `3600` | Cloud re-sync interval in seconds (min 900). Live state arrives by push and Roborock rate-limits this call, so keep it high |

## Support

If your mower isn't picked up or a control misbehaves, [open an issue](https://github.com/cecnic1989/homebridge-roborock-mower/issues) with your model number and debug logs (`homebridge -D`).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, testing, and design notes.

## License

Apache-2.0
