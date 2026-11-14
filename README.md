# Perspective

Perspective is an iPhone app for coaching yourself in any sport. The first demo covers one basketball drill, the catch-and-shoot three-pointer.

## Run the iPhone app

Use Node 22.13 or newer, Xcode 26.4 or newer with iOS support, and CocoaPods. Connect an iPhone with Developer Mode enabled and configure signing in Xcode for your team. From the repository root, run:

```sh
cd frontend
npm ci
npm run ios -- --device
```

For a rehearsal that relaunches offline with the JavaScript bundle embedded, install a Release build with `npm run ios -- --device --configuration Release`. Use a physical iPhone for recording and Quick Look. Recordings are silent, use the shooting-side camera, and stop after 30 seconds or when the file reaches its size cap.

## Connect Vercel and Supabase

The mobile app defaults to the [Perspective Vercel API](https://perspective-api-eta.vercel.app/health) from the [backend’s v2 branch](https://github.com/Andrewww8/Perspective/tree/v2). Copy `frontend/.env.example` to `frontend/.env.local` and set these build-time values:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | HTTPS origin for the Vercel API. The existing production URL is `https://perspective-api-eta.vercel.app`. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL for the same project the Vercel backend trusts. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The project's `sb_publishable_…` key. For a project using legacy keys, `EXPO_PUBLIC_SUPABASE_ANON_KEY` can supply the public `anon` key instead. |

The Expo variables are bundled into the app. Supabase secret keys, service-role keys, JWT secrets, and Blob credentials belong in Vercel's server environment. Enable the email provider in Supabase. For new-account confirmation in the app, include `{{ .Token }}` as the verification code in the Confirm signup template. Supabase's default email service only sends to project team addresses. Use custom SMTP for other recipients. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) · [Supabase SMTP configuration](https://supabase.com/docs/guides/auth/auth-smtp)

Rebuild the iOS app after changing build-time values. If upgrading an existing local native project, run `npx expo prebuild --platform ios` from `frontend` before the build to add the SecureStore module.

The app requests the public `GET /v1/demos?shotType=three_point` catalog and opens downloaded USDZs in Quick Look. Recording, manual tags, replay, and downloaded models work when signed out. For recordings made and tagged while signed in, the app queues shot clips in SQLite. It sends a Supabase bearer token to the API to request an upload grant, uploads the recording directly to private Blob storage with that grant, and asks the API to cut clips. New tags and edited outcomes sync while the app is active. Signing out pauses that account’s pending work. The server removes the full recording from Blob after it cuts the requested clips. Existing and guest practice stays on the phone. [Cloud API contract](https://github.com/Andrewww8/Perspective/blob/v2/PROJECT_CONTEXT.md#authenticated-endpoints-shot-clips)

## Verify

```sh
cd frontend
npm test
npm run typecheck
npx expo export --platform ios
```

The tests use temporary files, on-disk SQLite, and HTTP fixtures. For device acceptance, sign in, record a clip, and tag shots with the phone offline. Reconnect and confirm that the signed-in user's `GET /v1/clips` lists the expected clips and outcomes. Sign out and check that recording and replay still work. Download the animated USDZ, turn off Wi-Fi and cellular data, then relaunch the Release app and open the model in Quick Look. Reopen the clip after a force quit, scrub and play at 0.5×, edit a shot tag, and remove the local video while retaining its stats.
