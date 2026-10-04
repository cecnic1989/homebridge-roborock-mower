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
- **Liveness is proven actively, because the broker lies.** Roborock's broker can stop delivering a subscription while the connection still answers pings — pushes vanish with nothing looking wrong (2026-08-26: a lost 6 AM undock push left the mower shut out of the garage). Silence alone cannot detect it: a docked mower is legitimately quiet for hours. The probe exploits an empirical quirk — the a282 answers **any** unrecognized RPC method with `{"id":<int>,"result":"unknown_method"}` in ~0.1s, and that reply travels the same protocol-102 path as state pushes, so it proves delivery end-to-end with no side effects. Hence `LIVENESS_PROBE` in `src/mower/commands.ts` sends a deliberately meaningless `liveness_noop`. Verified over 40 consecutive 15-minute probes across a full night docked: 40/40 answered, 0.1–0.7s — the mower never sleeps through it. Use `scripts/liveness-probe.ts` to re-test candidates (`--dry-run` first) and `scripts/probe-smoke.ts` to exercise the plugin's own probe path against the live broker. Detection alone proved insufficient: the broker kills a subscription every ~3.5-4h, so even a 30-minute detection window left several blind spots a day (2026-08-29: a scheduled mow undocked inside one and the garage never opened). Two mechanisms close it. **Age rotation** refreshes the connection before it can die, because a connection that never gets old never gets killed: past 2h, at the first moment the mower is quiet (no frame for 5 min). It never interrupts a delivering connection — a QoS-0 push dropped in the ~1s gap would be the very miss this prevents, and silence from an *active* mower is caught by the probe within a cycle anyway. Only the quiet case, where a docked mower is indistinguishable from a dead subscription, needs the guarantee. This matches the wider diagnosis: the same "connected but no longer delivering" failure is reported across Roborock clients and other MQTT stacks, and where a cause is identified it is server-side session expiry with no client-visible signal. **Command-timeout healing** treats a missing reply to a Mow/Dock on a live connection as the same evidence a failed probe gives: reconnect at once so pushes resume in seconds. It never retries the command (the publish already reached the mower; only the reply was lost) and is bounded per mower by a latch that only a real frame re-arms, so an unreachable mower costs exactly one reconnect. Every restart path defers while a command is in flight, since a restart rejects all pending commands.
- **Where the mower is, is one fact.** `position` in `src/mower/state.ts` is `dock | leaving | out | returning`, and `docked`, `leaving`, `returning` and `away` are all read off it. It was six correlated booleans once, kept consistent by hand in every branch, and thirteen review rounds found eight position bugs in it — a `docked` that was also `returning`, a `homeward` that latched and reported the next departure as a return, a hold that expired back onto evidence it had already decided was wrong. None of those are expressible against a single position, which is the whole reason for the shape.
- **A position is only ever left on evidence, never on a timer.** `nextPosition` reads mostly as "stay put": if nothing in a push says anything, the mower is still where it was. Evidence is, in order, a state code that places it, the 61-63 waits (reported from the moment it heads home *and* while it waits out rain on the dock, so they move a mower that is out and leave one that is already home), DPS 143, a job ending under a stalled departure, and last the charge contact. The contact is last because it is wrong exactly when it matters: it stays live while the mower leaves and it re-seats on it, and the push that clears it is the one known to go missing, so until that push arrives the contact reports a mower home while it is still out. That closed a garage door on a returning mower once (2026-08-26) and on a departing one twice (2026-08-29, 2026-10-03). `sensorDebounceSeconds` was the first attempt and could not work: it is a hold timer, so once a value is applied it only *delays* the reverse edge, the observed re-seats ran to 13 s against a 15 s window, and a default is no protection — the recurrence was an install still carrying `3` from before the default changed. Docked opening now skips the debounce outright, since the door has to be open before the mower moves.
- **The charge contact is physically honest, but it may not be current.** Nothing breaks a charge contact without moving and nothing asserts one without touching it, so the reading itself is never wrong — the problem is staleness. A code that placed the mower away while the contact still read on-dock proves the clearing push never arrived, and from then on that reading means nothing. So a contact gone clear simply moves the mower off the dock, while an asserting one only brings it home if this push *changed* it and the mower was not mid-exit. Freshness is a value comparison, never a test for a key's presence: on the cloud path every snapshot carries all of them, so presence would make every poll look like news.
- **Activity needs its own, smaller memory.** DPS 123 = 0 reports nothing at all, yet the mower sits there for up to half a minute between zones, which dropped Mowing and brought it back. `settleState` carries `mowing` across a bare idle for `IDLE_HOLD_MAX_MS` — bounded, because a job whose end push lost its DPS 132 has to stop reading as mowing eventually, and only while the mower is not docked, or an arrival would leave Mowing open behind it. Sensor changes log at `info`, worded as the Home app names the trigger, because a contact flap changes no other DPS and left no trace above `debug`.
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
