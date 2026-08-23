# Contributing

## Prerequisites

- Node.js `^20.19.0 || ^22.10.0 || ^24.0.0`
- A Roborock account with at least one RockMow mower

## Setup

```bash
git clone https://github.com/cecnic1989/homebridge-roborock-mower.git
cd homebridge-roborock-mower
npm install
```

Create your local dev config (used by local Homebridge):

```bash
cp hbConfig/config.json.example hbConfig/config.json
```

This file is gitignored; only `.example` is tracked.

## Unit tests

```bash
npm test
```

Runs the `node:test` suites under `test/`. No network or credentials required. CI runs this on every push and PR.

## Local Homebridge Dev

Runs a real Homebridge instance. Auto-rebuilds on save.

```bash
npm run watch
```

Homebridge UI is at http://localhost:8581. Sign in via **Plugins → Roborock Mower → Settings** (email → code), then restart; the log prints the discovered mower's model and `pv`.

**Pair with iPhone (optional):** Home app → Add Accessory → "I Don't Have a Code" → enter `031-45-154`. iPhone must be on the same network.

## Releasing

Publishing is handled by `.github/workflows/publish.yml` via npm trusted publishing (OIDC) whenever a GitHub Release is published.

```bash
npm version patch        # or minor / major — commits x.y.z and tags vx.y.z
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

## Design Notes

- **Runtime deps: official `@homebridge/*` packages and `mqtt` only.** Roborock cloud access is native `fetch` + `node:crypto` (`src/roborock/`); `@homebridge/plugin-ui-utils` powers the sign-in page in `homebridge-ui/`; `mqtt` carries live device state.
- **One cloud client, rate-limited.** The platform owns a single `RoborockWebApi`; it serializes calls and enforces python-roborock's budgets (home data 5/h, 40/day). Startup costs exactly one home-data call; everything live comes from MQTT push (`src/roborock/mqtt-client.ts`, V1 frames in `v1-protocol.ts`); `pollInterval` is only an hourly re-sync. Never retry a failed home-data call in a loop.
- **State semantics are empirical.** DPS meanings come from python-roborock plus a real RockMow capture (`test/fixtures/dps-sequence.json`); see `src/mower/state.ts`. Re-run `npx tsx scripts/mqtt-probe.ts` to capture new sequences.
- **Email-code sign-in only.** Roborock's password login is effectively dead (2FA on most accounts). The custom UI requests a code, exchanges it, and stores the resulting session (token + `rriot`) in `<storage>/roborock-mower/session.json` — not config.json, because the UI's schema-form SAVE button rewrites the platform block and would drop it.
- **Platform owns all I/O.** Accessories (`src/mower/accessory.ts`) only receive derived state via `update()`; they never touch the cloud.

## Style

- TypeScript strict; ESLint flat config
- Early returns over nested `if/else`
- Comments only when the **why** is non-obvious

Before committing:

```bash
npm run build && npm run lint
```

CI runs the same on every push.
