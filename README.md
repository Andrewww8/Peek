# Perspective
An mobile app that allows you to coach yourself in any sport at any time.

See [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the scope, the architecture, and the API contract.

## Layout

| Path | What it is |
| --- | --- |
| `server/` | Cloud API (Fastify on Vercel Functions). It serves `/health`, `/v1/demos`, and the authenticated shot-clip endpoints (`/v1/recordings`, `/v1/clips`, and the `/v1/sessions/...` routes) |
| `server/api/index.ts`, `server/vercel.json` | Vercel entry point and function config |
| `server/src/prod/` | Production dependencies: Vercel Blob, Supabase Postgres, Supabase Auth (JWKS) |
| `server/src/local/` | Local stand-ins for Blob, Postgres, and Auth (used by `npm run server` and the sim) |
| `server/supabase/migrations/` | Postgres schema (`shot_clips`, with row-level security) |
| `server/catalog/demos.json` | Demo catalog. Asset URLs point at the public Blob model store |
| `mobile/src/core/` | iPhone backend: SQLite schema, sessions, shot tagging and stats, 3D demo download, shot-clip upload queue (`clips.ts`), storage recovery. No Expo imports |
| `mobile/src/adapters/expo.ts` | iPhone wiring: expo-sqlite, expo-file-system, expo-crypto, and the Supabase client for sign-in |
| `sim/` | Phone⇄API simulation: the real core on expo-faithful Node adapters, run against the real server (local deps, real ffmpeg) through a fault-injecting proxy |
| `scripts/master.ts` | End-to-end pipeline (`npm run master`) |
| `.claude/agents/perspective-master.md` | Master agent that runs the review-and-improve cycles |

## Deployed

| What | Where |
| --- | --- |
| API | https://perspective-api-eta.vercel.app (Vercel project `perspective-api`, root `server/`) |
| Recordings and shot clips | Private Blob store `perspective-clips`, connected to `perspective-api` |
| 3D models | Public Blob store `perspective-3d-models`. Upload credentials live in the Vercel project `perspective-models` |
| Auth and clip metadata | Supabase `perspective-db`, connected to `perspective-api` through the Vercel Marketplace |

Deploy with `cd server && vercel deploy --prod`. Run `vercel env pull` inside `server/` to get local credentials (git-ignored).

## Run locally

```sh
npm install                          # root (server workspace + tooling)
(cd mobile && npm install)           # Expo types for the adapter typecheck
npm run master                       # typecheck, tests, server smoke test, 150-iteration sim
npm run server                       # API on :3001 with local deps; prints a 30-day dev token
SIM_ITERATIONS=500 SIM_SEED=42 npm run sim
```

## App configuration (`mobile/.env`, see `mobile/.env.example`)

```sh
EXPO_PUBLIC_API_URL=https://perspective-api-eta.vercel.app
EXPO_PUBLIC_SUPABASE_URL=...        # SUPABASE_URL from `vercel env pull`
EXPO_PUBLIC_SUPABASE_ANON_KEY=...   # SUPABASE_ANON_KEY (safe to ship); never ship the service-role key
```

## Using the backend in the app

```ts
import { startBackend, supabase } from './src/adapters/expo';
const backend = await startBackend();             // migrations, crash recovery, background clip sync
await backend.sessions.saveRecording({ tempUri, durationMs });
await backend.shots.addShot(sessionId, releaseMs); // then setOutcome(..., 'made' | 'missed' | 'unmarked')
const result = await backend.demos.openDemo({ shotType: 'three_point', onProgress });
// result.status === 'ready' → open result.demo.uri in Quick Look and show result.demo.cue
// result.status === 'unavailable' → show the retry state
await supabase?.auth.signInWithPassword({ email, password }); // signed-in shots upload as 4 s clips
```

## Publishing a model

1. Export it with a versioned name, for example `three-point-follow-through-v2.usdz`.
2. Upload it to the public model store. In a folder linked to the `perspective-models` project, run `vercel env pull` to get its `BLOB_READ_WRITE_TOKEN`, then run `vercel blob put <file> --access public --pathname models/<file> --rw-token "$BLOB_READ_WRITE_TOKEN"`.
3. Add a catalog entry, or bump `version` in the existing one, with the printed HTTPS URL and the file's exact `sizeBytes`. Phones reject a download whose size doesn't match.
4. Redeploy `server/`. Phones that cached an older version upgrade automatically.

The current catalog entry (v1) is a small animated placeholder. Publish the finished catch-and-shoot animation as v2.
