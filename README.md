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

## Connect the 3D demo

Copy `frontend/.env.example` to `frontend/.env.local` and set `EXPO_PUBLIC_API_URL` to the laptop’s address. Connect the iPhone and laptop to the same Wi-Fi and allow local network access when prompted. If the laptop's IP changes, regenerate the iOS project with `npx expo prebuild --platform ios` and rebuild so the HTTP exception uses the new address.

The app requests `GET /v1/demos?shotType=three_point`. The catalog should expose a versioned animated `.usdz` URL, its exact byte size, and the coaching cue. A downloaded model opens with iOS Quick Look. Recording, replay, history, and shot tags use storage on the phone.

## Verify

```sh
cd frontend
npm test
npm run typecheck
npx expo export --platform ios
```

The tests use temporary files, on-disk SQLite, and a local HTTP server. For device acceptance, record a real clip and check the 30-second limit. Reopen the clip after a force quit, scrub and play at 0.5×, edit a shot tag, and remove the video while retaining its tags. Download the team's animated USDZ, turn off Wi-Fi and cellular data, then force quit and reopen the Release app. Confirm a new recording saves and the previously downloaded model animates in Quick Look. With an empty model cache and the server off, check that retry is available and that practice still works.
