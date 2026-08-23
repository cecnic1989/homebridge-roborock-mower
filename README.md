<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" width="150">
</p>

# homebridge-roborock-mower

[![npm version](https://img.shields.io/npm/v/@cecnic1989/homebridge-roborock-mower.svg)](https://www.npmjs.com/package/@cecnic1989/homebridge-roborock-mower)
[![Build and Lint](https://img.shields.io/github/actions/workflow/status/cecnic1989/homebridge-roborock-mower/build.yml?branch=latest)](https://github.com/cecnic1989/homebridge-roborock-mower/actions/workflows/build.yml)

Homebridge plugin for Roborock RockMow robot lawn mowers. Exposes your mower to Apple Home.

> **Early development.** The plugin installs and loads, but does not yet talk to any mower. Device support is in progress.

## Features

Planned:

- **Mower status** - mowing, docked, charging, paused, error
- **Start / pause / return to dock** controls
- **Battery level** and charging state

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
| `pollInterval` | `60` | How often to check the mower, in seconds (min 15, max 3600) |

## Support

If your mower isn't picked up, or a control doesn't behave correctly on it, [open an issue](https://github.com/cecnic1989/homebridge-roborock-mower/issues) with your model number and Homebridge debug logs (`homebridge -D`).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, local testing, and design notes.

## License

Apache-2.0
