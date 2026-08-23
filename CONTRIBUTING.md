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

Homebridge UI is at http://localhost:8581.

**Pair with iPhone (optional):** Home app → Add Accessory → "I Don't Have a Code" → enter `031-45-154`. iPhone must be on the same network.

## Releasing

Publishing is handled by `.github/workflows/publish.yml` via npm trusted publishing (OIDC) whenever a GitHub Release is published.

```bash
npm version patch        # or minor / major — commits x.y.z and tags vx.y.z
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

## Design Notes

- **No runtime deps.** Native `fetch`, no supply-chain surface.
- **Platform owns polling.** Single timer pushes state into accessories via `refreshState()`.

## Style

- TypeScript strict; ESLint flat config
- Early returns over nested `if/else`
- Comments only when the **why** is non-obvious

Before committing:

```bash
npm run build && npm run lint
```

CI runs the same on every push.
