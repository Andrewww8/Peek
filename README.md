# Perspective

Perspective is an iPhone app for coaching yourself in any sport. The first demo covers one basketball drill, the catch-and-shoot three-pointer.

Use `frontend/` for the iPhone app and `server/` for the Fastify API. The `mobile/` package contains the separate phone core used by the backend simulator. See [the project context](PROJECT_CONTEXT.md) for the API contract and demo scope.

## Run the iPhone app

Use Node 22.13 or newer, Xcode 26.4 or newer with iOS support, and CocoaPods. Connect an iPhone with Developer Mode enabled and configure signing in Xcode for your team. From the repository root, run:

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

The app requests the public `GET /v1/demos?shotType=three_point` catalog and opens downloaded USDZs in Quick Look. Recording, manual tags, replay, and downloaded models work when signed out. For recordings made and tagged while signed in, the app queues shot clips in SQLite. It sends a Supabase bearer token to the API to request an upload grant, uploads the recording directly to private Blob storage with that grant, and asks the API to cut clips. New tags and edited outcomes sync while the app is active. Signing out pauses that account’s pending work. The server removes the full recording from Blob after it cuts the requested clips. Existing and guest practice stays on the phone. [Cloud API contract](PROJECT_CONTEXT.md#authenticated-endpoints-shot-clips)

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

`npm run master` checks the server and runs the network and local storage simulator; it downloads the public model to verify the catalog's byte count. `npm run test:integration` runs the shipped frontend sync code against the local Fastify server with a synthetic video, ffmpeg, SQLite, and local test tokens.

## Rehearse on the demo iPhone

1. Install a signed Release build and open Practice on a physical iPhone.
2. Download the USDZ and open it in Quick Look while online. The deployed catalog currently serves a placeholder. Keep pose NPZ files as source data and publish the corresponding versioned USDZ for Quick Look.
3. Record a clip, scrub it at 0.5×, and tag made and missed shots. Force quit, disable both Wi-Fi and cellular data, and reopen the clip, its stats, and the downloaded model.
4. For the cloud portion, sign in with a confirmed test account on the same Supabase project Vercel uses. Record while signed in, tag shots offline, then reconnect and verify the clips and edits in `GET /v1/clips`. Verify with a second test account that it cannot list the first account's clips.

The Vercel project uses `server/` as its root. Keep its existing private Blob store connected, and apply the SQL files in [server/supabase/migrations](server/supabase/migrations) on the connected Supabase database before verifying cloud clips. The Vercel backend needs the project URL and server-side credentials from that same database; the iPhone build needs only its URL and public key.

## Preview a pose track

For a local preview, use Python with NumPy and the OpenUSD tools `usdcat`, `usdzip`, and `usdchecker`. Pick one track and a contiguous frame range with valid 3D joints:

```sh
python3 server/scripts/export-pose-usdz.py source.npz pose-preview.usdz \
  --track 75 --start-frame 1740 --end-frame 1830
usdchecker --arkit pose-preview.usdz
```

The export shows a body-relative stick figure. It does not reconstruct a player's appearance, ball motion, or court position. Verify the selected move and playback on the demo iPhone before publishing a versioned export and updating `server/catalog/demos.json`. Keep the source NPZ outside Git.
