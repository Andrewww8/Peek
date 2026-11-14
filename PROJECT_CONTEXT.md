# Perspective project context

Perspective is an iPhone sports coaching app starting with basketball. A player records a practice clip, reviews the movement and their statistics, and opens a 3D example of the same skill. The long-term goal is to coach athletes across sports and experience levels. The first milestone is a reliable demo of one catch-and-shoot three-point drill for one player on one iPhone.

[GitHub repository](https://github.com/Andrewww8/Perspective)

## What the demo must do

1. **Record.** Capture a real clip on the iPhone and save it on the device. Start with a stationary, shooting-side camera angle that keeps the player and ball in frame through release.
2. **Replay and coaching.** Replay the saved clip with a scrubber and slow motion. Show a prepared coaching cue for the demo player. Label it as a practice tip when shown alongside a fresh recording. A cue tied to a specific frame belongs to the prepared example it was written for.
3. **Saved clips and stats.** Reopen practice sessions after an app restart. Show the clip and its shot statistics from local storage.
4. **3D example.** Download a prebuilt animated athlete model from the laptop and open it on the iPhone. After a successful download, reopen it offline with its coaching cue.

## Demo decisions and asset status

| Item | Status |
| --- | --- |
| First drill | Confirmed. One catch-and-shoot three-pointer. |
| Source of shot stats | Pending. The working default is for the player to tag makes and misses in replay. |
| 3D asset | Creation required. The team starts without a model or shooting animation. The proposed delivery format is animated `.usdz` for iPhone. |

## Stack and ownership

| Where | Stack | Responsibility |
| --- | --- | --- |
| iPhone UI | Expo, React Native, TypeScript | Record, Replay and Coaching, and Saved Clips screens. |
| iPhone media | `expo-camera`, `expo-file-system`, `expo-video` | Capture, durable file storage, local replay, and model downloads. Open the animated USDZ with iOS Quick Look. |
| iPhone database | `expo-sqlite` | Sessions, shot outcomes, and downloaded model metadata. The phone is the source of truth for practice history. |
| Laptop API | Node.js, Fastify, TypeScript, `@fastify/static` | Read a small JSON catalog and serve versioned, prebuilt model exports over the local network. |
| 3D assets | Blender source files and exported models on the laptop | Create or source a rigged avatar and animate the catch, release, and follow-through. Export one animated shot first. Keep source assets in their working folder and serve only the mobile exports from a dedicated directory. |

## Local data on the iPhone

Videos and model files live under separate directories in persistent app storage. SQLite stores relative paths and metadata. On save, move the completed camera recording out of Expo Camera's temporary cache before writing its session row. Retain the recording's actual file extension. Store one video per practice session.

| SQLite table | Starting fields |
| --- | --- |
| `sessions` | `id`, `created_at`, `shot_type`, `video_path`, `duration_ms`, `size_bytes` |
| `shots` | `session_id`, `shot_number`, `release_ms`, `outcome` |
| `downloaded_demos` | `demo_id`, `version`, `format`, `shot_type`, `local_path`, `cue` |

- Give each session a stable ID. Use `(session_id, shot_number)` to identify an individual shot, and `(demo_id, version, format)` to identify a downloaded model.
- For manual tagging, record a timestamp and let the player mark a shot as `made`, `missed`, or `unmarked`. Compute the percentage as makes divided by makes plus misses. Show unmarked shots separately and use an empty state when there are zero tagged attempts. Editing a tag recalculates the totals.
- Start with 720p and a 30-second cap. At a target video bitrate of 4 Mbps, a 30-second clip uses about 15 MB before audio and container overhead. Check available space before recording or downloading. Let the player remove a video to reclaim space while retaining the session's shot stats.
- Allow a null `video_path` for sessions whose videos were removed. Show their stats with an unavailable replay state. Keep capture, replay, and stats entirely on the phone for the demo.

## Laptop API and 3D download

- `GET /health` checks that the phone can reach the laptop.
- `GET /v1/demos?shotType=three_point` returns the matching demo entries from `demos.json`.
- `GET /media/<versioned-filename>` serves the exported asset from the laptop. The phone's download code also accepts absolute HTTPS URLs, so the catalog can point to cloud storage later.

The endpoint returns an array of matching entries. For the demo, use one entry like the example below. Populate `sizeBytes` from the actual export (`npm run sync-catalog -w server`). Resolve relative asset URLs against the API base URL. A relative asset URL must be `/media/<versioned-filename>`, a single file directly in the media directory. Any other asset URL must be absolute HTTPS. The server rejects a catalog that breaks either rule.

```json
[
  {
    "id": "three-point-follow-through",
    "version": 1,
    "shotType": "three_point",
    "cue": "Hold your finish until the ball reaches the rim.",
    "assets": [
      {
        "format": "usdz",
        "sizeBytes": 8500000,
        "url": "/media/three-point-follow-through-v1.usdz"
      }
    ]
  }
]
```

When the player taps **View 3D Demo**, look up the matching demo on the phone first so it can open offline. If the asset is missing or a newer version is selected, show download progress, write to a temporary file, verify the expected byte size, then move it into persistent storage and save the metadata. Keep the last working version available if a replacement download fails. Test the actual model animation in Quick Look on the demo iPhone.

Run Fastify on the laptop, for example on port `3001`. Put the phone and laptop on the same Wi-Fi. Set the laptop URL in `EXPO_PUBLIC_API_URL` for the demo build and configure iOS Local Network permission and any local HTTP allowance for that build. Use an installed preview build for rehearsal so the app can relaunch independently of Metro.

## Build order and acceptance

1. Save one real recording and verify local playback after relaunch.
2. Tag a small set of shots and verify that edits update the stored session totals.
3. Create the first animated catch-and-shoot model. Verify the export in Quick Look on the demo iPhone, then serve it from the laptop and verify the in-app download and playback.
4. Turn Wi-Fi off, quit and relaunch the app, and verify that a new recording saves, an existing recording and its stats reopen, and the downloaded 3D model plays.

If the API is unreachable and there is no saved model yet, show a retry state in the demo viewer. Keep recording, playback, and local stats accessible throughout.

Mobile and API integration can start with a small placeholder model while the shooting animation is being made. The 3D acceptance check uses the finished catch-and-shoot animation.

## How the demo can grow

- Deploy the same Fastify API over HTTPS. Move model exports to S3 and serve them through CloudFront using the same catalog fields and versioned URLs. Consider Postgres when the team needs a catalog editing workflow.
- Add automated form analysis and shot tagging after the manual demo. Use annotated footage for each drill to check that the app finds the right moments and that the visible movement supports the coaching cue.
- Keep phone storage as the default. Cross-device history would be a separate opt-in feature. Public distribution of recognizable NBA models depends on clearing the relevant likeness and source-footage rights.

## Potential skill and sport extensions

These are candidates for later milestones. Start each extension with a single drill that a player can record and repeat.

### Basketball

| Skill | What to review | First stat to track |
| --- | --- | --- |
| Free throws and stationary midrange | Setup, release, and follow-through. | Makes and attempts by drill. |
| Pull-up jumpers | Gather, foot placement on the stop, and rise into the shot. | Makes and attempts by drive direction. |
| Layups and finishing | Gather, takeoff foot, and finishing hand. | Makes and attempts by side and hand. |
| Post moves | Start with a drop step. Review the pivot foot, step, and finish. | Makes and attempts by block and move. |
| Ball handling | Start with a stationary crossover. Review hand changes and ball control. | Completed reps and lost dribbles. |
| Defensive footwork | Start with a cone slide drill. Review stance and changes of direction. | Time to finish the same cone course. |

### Other sports

| Sport and first drill | What to review | First stat to track |
| --- | --- | --- |
| Tennis serve | Ball toss, contact, and follow-through. | Serves in and attempts from each side. |
| Soccer free kick | Run-up, plant foot, and contact with the ball. | Target hits and attempts from a marked spot. |
| Volleyball standing serve | Toss, contact, and finish. | Serves in and attempts, with target zones when used. |
| Golf swing | Setup, backswing, and finish with one club. | Target hits and attempts when the player can verify the result. |

Reuse capture, replay, local history, and model downloads across drills. Give each new drill its own filming instructions, replay markers, coaching cues, stats with units, and 3D example. A player can tag an outcome manually when it happens outside the filming angle.

When a second sport is implemented, add a sport and drill ID to the session and demo catalog. Map existing basketball sessions to their drill IDs and preserve their shot tags. Keep measurements specific to the drill so history compares like with like.

## Agent handoff

- Treat this file as the scope and architecture brief. Inspect the repo to see what has actually been implemented before scaffolding or changing existing files.
- Keep capture, tagging, and replay usable when the laptop is unavailable. The server serves the 3D catalog and model files for the first demo.
- Keep raw practice footage, database exports, and large model source files out of Git. Check in code, catalog structure, and intentionally selected demo assets suitable for the repository.
- Update this file when the team changes the demo drill, stats workflow, asset format, or API contract.
