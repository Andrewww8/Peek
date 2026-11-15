# Perspective

Perspective is an iPhone app for coaching yourself in any sport. The first demo covers one basketball drill, the catch-and-shoot three-pointer.

Use `frontend/` for the iPhone app, `server/` for the Fastify API, and `shot_coach/` for the Python pose and 3D comparison CLI. The `mobile/` package contains the phone core used by the backend simulator. See [the project context](PROJECT_CONTEXT.md) for the API contract and demo scope.

## Run the iPhone app

Use Node 24, Xcode 26.4 or newer with iOS support, and CocoaPods. Connect an iPhone with Developer Mode enabled and configure signing in Xcode for your team. From the repository root, run:

```sh
cd frontend
npm ci
npm run ios -- --device
```

For a rehearsal that relaunches offline with the JavaScript bundle embedded, install a Release build with `npm run ios -- --device --configuration Release`. Use a physical iPhone for recording and Quick Look. Recordings are silent, use the shooting-side camera, and stop after 30 seconds or when the file reaches its size cap.

## Connect Vercel and Supabase

The mobile app defaults to the [Perspective Vercel API](https://perspective-api-eta.vercel.app/health). Copy `frontend/.env.example` to `frontend/.env.local` and set these build-time values:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | HTTPS origin for the Vercel API. The existing production URL is `https://perspective-api-eta.vercel.app`. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL for the same project the Vercel backend trusts. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The project's `sb_publishable_…` key. For a project using legacy keys, `EXPO_PUBLIC_SUPABASE_ANON_KEY` can supply the public `anon` key instead. |

The Expo variables are bundled into the app. Supabase secret keys, service-role keys, JWT secrets, and Blob credentials belong in Vercel's server environment. Enable the email provider in Supabase. For new-account confirmation in the app, include `{{ .Token }}` as the verification code in the Confirm signup template. Supabase's default email service only sends to project team addresses. Use custom SMTP for other recipients. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) · [Supabase SMTP configuration](https://supabase.com/docs/guides/auth/auth-smtp)

Rebuild the iOS app after changing build-time values. If upgrading an existing local native project, run `npx expo prebuild --platform ios` from `frontend` before the build to add the SecureStore module.

In Vercel, set the project root to `server/` and deploy `main`. Apply the SQL files in [server/supabase/migrations](server/supabase/migrations) in numeric order. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `BLOB_READ_WRITE_TOKEN` on Vercel. Vercel OIDC with `BLOB_STORE_ID` also works for private Blob. Set `SUPABASE_JWT_SECRET` only if the project still signs access tokens with the legacy HS256 secret.

The app requests the public `GET /v1/demos?shotType=three_point` catalog and opens downloaded USDZs in Quick Look. Recording, manual tags, replay, and downloaded models work when signed out. For recordings made and tagged while signed in, the app queues shot clips in SQLite. It sends a Supabase bearer token to the API to request an upload grant, uploads the recording directly to private Blob storage with that grant, and asks the API to cut clips. New tags and edited outcomes sync while the app is active. Signing out pauses that account’s pending work. The server removes the full recording from Blob after it cuts the requested clips. Existing and guest practice stays on the phone. [Cloud API contract](PROJECT_CONTEXT.md#authenticated-endpoints-shot-clips)

For Coach chat, set `ANTHROPIC_API_KEY` and the Supabase pooled database URL `POSTGRES_URL` in Vercel. To seed the pro comparison templates, load the server environment locally and run `PERSPECTIVE_DEPS=production npm run reference-templates-ingest -w server` from the root. In the app, sign in, record and tag a shot, let it sync, then select its session from the Coach tab. Wait for pose analysis before asking about shot mechanics.

## Run pose inference on the Mac

Vercel hosts the Fastify API and cuts the tagged shot clips with FFmpeg. Supabase Auth signs users in, and Supabase Postgres holds the shot metadata and analysis. The Mac downloads pending clips through short-lived private URLs, runs Shot Coach’s pose models, and submits the pose data to Vercel. The API saves the measurements before removing the temporary clips. The signed-in player sees analysis status and measurements in Replay.

Run `npm ci` from the repository root and follow the [Shot Coach setup](shot_coach/README.md#setup) to create `shot_coach/.venv` on an Apple silicon Mac. Run the worker from the repository root:

```sh
export PERSPECTIVE_API_URL=https://perspective-api-eta.vercel.app
# Load CV_SERVICE_TOKEN in this terminal from the matching server environment.
npm run pose-worker -w server -- --watch
```

The worker checks for pending clips every 15 seconds after processing a batch. Omit `--watch` to process one batch. For a local Fastify server, use `http://127.0.0.1:3001` and its local CV token. Set the same `CV_SERVICE_TOKEN` in Vercel and the Mac worker. If your Python environment is elsewhere, set `SHOT_COACH_PYTHON` to its interpreter.

## Verify

Run the frontend checks from the repository root:

```sh
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run typecheck
(cd frontend && npx expo export --platform ios)
```

Use Node 24 for the complete backend and integration checks:

```sh
npm ci
npm --prefix mobile ci
SIM_SEED=42 npm run master
npm run test:integration
```

`npm run master` checks the server, serves the animated model to verify the catalog's byte count, and runs the network and local storage simulator. `npm run test:integration` exercises the iPhone sync, analysis, and Coach clients against the local Fastify API with FFmpeg, SQLite, fixture poses, a scripted coach model, and test tokens. Set `FFMPEG_PATH` to an installed binary if the `ffmpeg-static` installer did not provide one.

## Rehearse on the demo iPhone

1. Install a signed Release build and open Practice on a physical iPhone.
2. Download the animated reference pose and open it in Quick Look while online. If the phone has the old model, select **Check for update**, then **Download update**. The bundled v2 USDZ is a stick figure animated from the averaged Curry three-point pose in `server/reference-data/average-shots/`.
3. Record a clip, scrub it at 0.5×, and tag made and missed shots. Force quit, disable both Wi-Fi and cellular data, and reopen the clip, its stats, and the downloaded model.
4. For the cloud portion, sign in with a confirmed test account, record and tag a shot, and leave the app open to sync. Check **Shot analysis** in Replay, then open the session from **Coach** and ask about follow-through. Use a second test account to verify that clips and chat history are isolated.

## Preview a pose track

For a local preview, use Python with NumPy and the OpenUSD tools `usdcat`, `usdzip`, and `usdchecker`. Pick one track and a contiguous frame range with valid 3D joints:

```sh
python3 server/scripts/export-pose-usdz.py source.npz pose-preview.usdz \
  --track 75 --start-frame 1740 --end-frame 1830
usdchecker --arkit pose-preview.usdz
```

The export shows a body-relative stick figure. It does not reconstruct a player's appearance, ball motion, or court position. Verify the selected move and playback on the demo iPhone before publishing a versioned export and updating `server/catalog/demos.json`. Keep the source NPZ outside Git.
