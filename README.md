# Peek

Peek is an iPhone app for coaching yourself in any sport. The first demo covers one basketball drill, the catch-and-shoot three-pointer.

Use `frontend/` for the iPhone app, `server/` for the Fastify API, and `shot_coach/` for the Python pose and 3D comparison CLI. The `mobile/` package contains the phone core used by the backend simulator. See [the project context](PROJECT_CONTEXT.md) for the API contract and demo scope.

## Run the iPhone app

Use Node 24, Xcode 26.4 or newer with iOS support, and CocoaPods. Connect an iPhone with Developer Mode enabled and configure signing in Xcode for your team. From the repository root, run:

```sh
cd frontend
npm ci
npm run ios -- --device
```

For a rehearsal that relaunches offline with the JavaScript bundle embedded, install a Release build with `npm run ios -- --device --configuration Release`. Use a physical iPhone for recording and Quick Look. Recordings are silent, use the shooting-side camera, and stop after 30 seconds or when the file reaches its size cap.

Open Peek and sign in or continue as a guest. In Coach, tap **+** to record or attach a video. Open **Saved clips** from the menu to replay sessions, mark shots, and review stats.

Open a session in **Saved Clips** and tap **Compare your shot vs NBA** near the top of **Session details**. On iOS 17 or later, Peek estimates one release from the recorded shooting motion and tracks the 3D body pose on the iPhone. The comparison works without a release tag or a made or missed outcome. New recordings and imports start analysis after saving. The progress bar shows the current phase, percentage, elapsed time, and final duration. To compare a specific tagged attempt, open it under **Tagged shots**.

The shots play together through one second after release. Peek fills gaps between tracked poses so the white skeleton continues through the recorded follow-through. If the footage or tracking ends early, Peek holds the final tracked pose for the rest of the comparison. The bundled NBA references include measured motion through half a second after release and hold their final pose for the rest of the playback. Tap **Change NBA player** to pick a reference. Both skeletons use the same release position, camera angle, and playhead. **View in AR** opens an animated Quick Look scene with names above the white player skeleton and the yellow NBA reference. New cloud analyses of tagged shots show the finger points that Shot Coach can track around release. To add them to an older analysis, import the original video again and mark the release in the new session.

On-device comparisons stabilize the body motion and show wrist and fingertip geometry where the recording supports it. The white skeleton stays grounded through the dip and landing. It shows lift when the video tracks both feet rising near release and descending again. Reopening an older saved recording refreshes its tracking at the original release time.

## Connect Vercel and Supabase

The mobile app defaults to the [deployed Peek API](https://perspective-api-eta.vercel.app/health). Copy `frontend/.env.example` to `frontend/.env.local` and set these build-time values:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | HTTPS origin for the Vercel API. The existing production URL is `https://perspective-api-eta.vercel.app`. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL for the same project the Vercel backend trusts. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The project's `sb_publishable_…` key. For a project using legacy keys, `EXPO_PUBLIC_SUPABASE_ANON_KEY` can supply the public `anon` key instead. |

The Expo variables are bundled into the app. Supabase secret keys, service-role keys, JWT secrets, and Blob credentials belong in Vercel's server environment. Enable the email provider in Supabase. For new-account confirmation in the app, include `{{ .Token }}` as the verification code in the Confirm signup template. Supabase's default email service only sends to project team addresses. Use custom SMTP for other recipients. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) · [Supabase SMTP configuration](https://supabase.com/docs/guides/auth/auth-smtp)

For password recovery, add `perspective://reset-password` to Supabase's additional redirect URLs. Open the reset email on the same iPhone that requested it. [Supabase native deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking)

Guests can analyze shots on the iPhone, use cloud analysis, and chat with Coach without a daily usage cap by default. Coach can use measurements from an attached clip’s on-device analysis. Peek stores a device guest session in Keychain and issues an API-only access token through `POST /v1/guest-session`. This route uses `POSTGRES_URL` and the server’s Supabase service key. To preserve guest identities when rotating the Supabase service-role key, set `PEEK_GUEST_SECRET` to the current derivation key before rotation and keep it stable across deployments.

### Switch guest usage modes

| Mode | Vercel environment | `frontend/.env.local` |
| --- | --- | --- |
| Unlimited | Leave `PEEK_GUEST_DAILY_LIMIT` unset or set it to `unlimited`. | Leave `EXPO_PUBLIC_PEEK_GUEST_DAILY_LIMIT` unset or set it to `unlimited`. |
| Five per UTC day | Set `PEEK_GUEST_DAILY_LIMIT=5`. | Set `EXPO_PUBLIC_PEEK_GUEST_DAILY_LIMIT=5`. |

After changing modes, redeploy the Vercel API and rebuild and install the iPhone app. The cloud setting shares five uses across Coach messages and new cloud shot analyses. The iPhone setting allows five new on-device analyses separately. Existing comparisons and chats remain available in both modes, and usage already counted that UTC day carries over. The guest session endpoint also has its own request limits for issuing access tokens.

Rebuild the iOS app after changing build-time values. If upgrading an existing local native project, run `npx expo prebuild --platform ios` from `frontend` to update its native modules and permissions.

In Vercel, set the project root to `server/` and deploy `main`. Apply the SQL files in [server/supabase/migrations](server/supabase/migrations) in numeric order. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `BLOB_READ_WRITE_TOKEN` on Vercel. Vercel OIDC with `BLOB_STORE_ID` also works for private Blob. Set `SUPABASE_JWT_SECRET` only if the project still signs access tokens with the legacy HS256 secret.

Recording, manual tags, replay, and guest comparisons work when signed out. For recordings made and tagged while signed in, the app queues shot clips in SQLite. It sends a Supabase bearer token to the API to request an upload grant, uploads the recording directly to private Blob storage with that grant, and asks the API to cut clips. New tags and edited outcomes sync while the app is active. Signing out pauses that account’s pending work. The server removes the full recording from Blob after it cuts the requested clips. Existing and guest practice stays on the phone. [Cloud API contract](PROJECT_CONTEXT.md#authenticated-endpoints-shot-clips)

For Coach chat, set `ANTHROPIC_API_KEY` and the Supabase pooled database URL `POSTGRES_URL` in Vercel. To seed the pro comparison templates, load the server environment locally and run `PERSPECTIVE_DEPS=production npm run reference-templates-ingest -w server` from the root. Attach a recording in Coach or tap **Ask Coach** from its session. Coach can use the attached clip’s on-device measurements while cloud analysis runs. For a tagged clip, check **Shot analysis** in Session details for cloud results or the reason a clip could not be processed.

## Run pose inference on the Mac

Vercel hosts the Fastify API and cuts the tagged shot clips with FFmpeg. Supabase Auth signs users in, and Supabase Postgres holds the shot metadata and analysis. The Mac downloads pending clips through short-lived private URLs, runs Shot Coach’s pose models, and submits the pose data to Vercel. The API saves the measurements before removing the temporary clips. The signed-in player sees analysis status and measurements in Replay.

Run `npm ci` from the repository root and follow the [Shot Coach setup](shot_coach/README.md#setup) to create `shot_coach/.venv` on an Apple silicon Mac. Run the worker from the repository root:

```sh
export PERSPECTIVE_API_URL=https://perspective-api-eta.vercel.app
# Load CV_SERVICE_TOKEN in this terminal from the matching server environment.
npm run pose-worker -w server -- --watch
```

The worker checks for pending clips every 15 seconds after processing a batch. Omit `--watch` to process one batch. For a local Fastify server, use `http://127.0.0.1:3001` and its local CV token. Set the same `CV_SERVICE_TOKEN` in Vercel and the Mac worker. If your Python environment is elsewhere, set `SHOT_COACH_PYTHON` to its interpreter. The worker defaults to this checkout's `shot_coach/shot_coach.py`. If you set `SHOT_COACH_PATH`, use a copy with the hand models and landmark functions from [PR #3](https://github.com/Andrewww8/Peek/pull/3).

After replacing the supplied NBA templates, run `node --import tsx server/scripts/export-peek-reference-poses.ts` from the repository root to regenerate the iPhone's bundled three-point reference poses.

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

1. Install a signed Release build and continue as a guest on a physical iPhone.
2. Record a clip and tap **Stop and save**. Open its **Session details** and watch the analysis progress below **Compare your shot vs NBA**. Open the comparison when it finishes, without tagging an outcome or release.
3. Watch the white skeleton and the NBA skeleton play side by side. Change the reference player and tap **View in AR** to open both named skeletons in Quick Look. Quit Peek, disable Wi-Fi and cellular data, and reopen the saved comparison.
4. For the cloud portion, sign in with a confirmed test account, record and tag a shot, and leave the app open to sync. Check **Shot analysis** in Replay, then open the session from **Coach** and ask about follow-through. Use a second test account to verify that clips and chat history are isolated.

## Preview a pose track

For a local preview, use Python with NumPy and the OpenUSD tools `usdcat`, `usdzip`, and `usdchecker`. Pick one track and a contiguous frame range with valid 3D joints:

```sh
python3 server/scripts/export-pose-usdz.py source.npz pose-preview.usdz \
  --track 75 --start-frame 1740 --end-frame 1830
usdchecker --arkit pose-preview.usdz
```

The export shows a body-relative stick figure. It does not reconstruct a player's appearance, ball motion, or court position. Verify the selected move and playback on the demo iPhone before publishing a versioned export and updating `server/catalog/demos.json`. Keep the source NPZ outside Git.
