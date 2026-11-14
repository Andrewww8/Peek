# Perspective
An mobile app that allows you to coach yourself in any sport at any time.

See [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the scope and architecture.

## Layout

| Path | What it is |
| --- | --- |
| `server/` | Laptop API (Fastify + `@fastify/static`): `/health`, `/v1/demos?shotType=`, `/media/<versioned file>` |
| `server/catalog/demos.json` | Demo catalog |
| `server/media/` | Mobile exports only (git-ignored). Blender sources stay in their own working folder. |
| `mobile/src/core/` | iPhone backend: SQLite schema, sessions, shot tagging and stats, 3D demo download, storage recovery. Contains no Expo imports. |
| `mobile/src/adapters/expo.ts` | iPhone wiring for the core (expo-sqlite, expo-file-system, expo-crypto) |
| `sim/` | Phone⇄laptop simulation: the real core on Node adapters, run against the real server through a fault-injecting proxy |
| `scripts/master.ts` | End-to-end pipeline (`npm run master`) |
| `.claude/agents/perspective-master.md` | Master agent that runs and extends this workflow |

## Run

```sh
npm install
npm run master                   # typecheck, model export, catalog sync, server smoke test, 150-iteration sim
npm run server                   # laptop API on :3001; prints the LAN URL for EXPO_PUBLIC_API_URL
SIM_ITERATIONS=500 SIM_SEED=42 npm run sim   # reproducible simulation run
```

## Using the backend in the app

```ts
import { startBackend } from './src/adapters/expo';
const backend = await startBackend();             // migrations + crash recovery
await backend.sessions.saveRecording({ tempUri, durationMs });
await backend.shots.addShot(sessionId, releaseMs); // then setOutcome(..., 'made' | 'missed' | 'unmarked')
const result = await backend.demos.openDemo({ shotType: 'three_point', onProgress });
// result.status === 'ready' → open result.demo.uri in Quick Look and show result.demo.cue
// result.status === 'unavailable' → show the retry state
```

## Publishing a model

1. Put the export in `server/media/` with a versioned name, for example `three-point-follow-through-v2.usdz`.
2. Add a catalog entry for it, or bump `version` and `url` in the existing one.
3. Run `npm run sync-catalog -w server` so that `sizeBytes` matches the file. Phones check this size before they accept a download.

`npm run master` generates a small animated placeholder as **v1**. Publish the finished catch-and-shoot animation as **v2**, and phones that cached the placeholder will upgrade automatically.
