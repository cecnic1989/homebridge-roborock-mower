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

Test behavior, not plumbing. A test earns its place by naming the bug it would catch: a protocol vector (hash, signature, frame decode), a state transition, a fallback path, an error mapping, a no-crash path. Do not test trivial helpers, one-line wrappers, or assert a header/field at a time — those only pin down the current implementation.

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
gh release create vX.Y.Z --title vX.Y.Z --notes-file notes.md
```

### Release notes

Written for the person running the plugin, not from the commit list (never `--generate-notes`). Same format as `homebridge-frigidaire-dehumidifier`:

```markdown
## What's Changed

- **One bold sentence saying what changed, from the user's point of view.** Then why it matters and what, if anything, they must do ("nothing to change on your side", "restart Homebridge afterwards").
- **Fixed: describe the symptom the user saw.** Then the cause in one clause and the effect of the fix.

**Full Changelog**: https://github.com/cecnic1989/homebridge-roborock-mower/compare/vPREV...vX.Y.Z
```

- Title is the tag (`v0.2.3`), nothing else.
- One bullet per user-visible change; internal refactors are folded into the change they enable or left out.
- Plain language: "sensors show as inactive", not "StatusActive=false"; name settings as they appear in the UI.
- A release with no user-visible change says so in one bullet ("Package metadata only.").

## Design Notes

- **Runtime deps: official `@homebridge/*` packages and `mqtt` only.** Roborock cloud access is native `fetch` + `node:crypto` (`src/roborock/`); `@homebridge/plugin-ui-utils` powers the sign-in page in `homebridge-ui/`; `mqtt` carries live device state.
- **One cloud client, rate-limited.** The platform owns a single `RoborockWebApi`; it serializes calls and enforces python-roborock's budgets (home data 5/h, 40/day). Startup costs exactly one home-data call; everything live comes from MQTT push (`src/roborock/mqtt-client.ts`, V1 frames in `v1-protocol.ts`); `pollInterval` is only an hourly re-sync. Never retry a failed home-data call in a loop.
- **State semantics are empirical.** DPS meanings come from python-roborock plus a real RockMow capture (`test/fixtures/dps-sequence.json`); see `src/mower/state.ts`. Re-run `npx tsx scripts/mqtt-probe.ts` to capture new sequences.
- **Email-code sign-in only.** Roborock's password login is effectively dead (2FA on most accounts). The custom UI requests a code, exchanges it, and stores the resulting session (token + `rriot`) in `<storage>/roborock-mower/session.json` — not config.json, because the UI's schema-form SAVE button rewrites the platform block and would drop it.
- **Controls go through the `remote_pb` RPC, not DPS writes.** The app never writes python-roborock's DPS 201–205. Every control is a V1 RPC request (protocol 101, published to `rr/m/i/{rriot.u}/{mqttUser}/{duid}`) whose `dps.101` is `{"id":<int>,"method":"remote_pb","params":{"id":"<ms>","type":"APP_BUTTON","app_button":"<VERB>"}}`; the reply arrives on the output topic as protocol 102 with `dps.102` = `{"id":<int>,"result":"ok"}`. Verbs: `MOW_GLOBAL`, `MOW_EDGE`, `MOW_PAUSE`, `MOW_RESUME`, `MOW_END`, `CHARGE` (dock). Zone mowing exists (`MOW_SELECT` + `modify_map.boundaries`, zones from `GET_MOW_PREFERENCE_CONFIG`) but is deliberately not exposed — the plugin is for automations, the app for the rest. Source: the community RockNeo integration (`christiantroldmand/Roborock-mower-support-preview-…`, decompiled from the `com.roborock.mower` app) plus python-roborock's `v1_protocol.py`; `scripts/remote-pb-probe.ts` sends one verb for live checks.
- **Liveness is proven actively, because the broker lies.** Roborock's broker can stop delivering a subscription while the connection still answers pings — pushes vanish with nothing looking wrong (2026-08-26: a lost 6 AM undock push left the mower shut out of the garage). Silence alone cannot detect it: a docked mower is legitimately quiet for hours. The probe exploits an empirical quirk — the a282 answers **any** unrecognized RPC method with `{"id":<int>,"result":"unknown_method"}` in ~0.1s, and that reply travels the same protocol-102 path as state pushes, so it proves delivery end-to-end with no side effects. Hence `LIVENESS_PROBE` in `src/mower/commands.ts` sends a deliberately meaningless `liveness_noop`. Verified over 40 consecutive 15-minute probes across a full night docked: 40/40 answered, 0.1–0.7s — the mower never sleeps through it. Use `scripts/liveness-probe.ts` to re-test candidates (`--dry-run` first) and `scripts/probe-smoke.ts` to exercise the plugin's own probe path against the live broker.
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
