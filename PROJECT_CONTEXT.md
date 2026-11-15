# Perspective project context

Perspective is an iPhone sports coaching app starting with basketball. A player records a practice clip, reviews the movement and their statistics, and opens a 3D example of the same skill. The long-term goal is to coach athletes across sports and experience levels. The first milestone is a reliable demo of one catch-and-shoot three-point drill for one player on one iPhone.

[GitHub repository](https://github.com/Andrewww8/Perspective)

## What the demo must do

1. **Record.** Capture a real clip on the iPhone and save it on the device. Start with a stationary, shooting-side camera angle that keeps the player and ball in frame through release.
2. **Replay and coaching.** Replay the saved clip with a scrubber and slow motion. Show a prepared coaching cue for the demo player. Label it as a practice tip when shown alongside a fresh recording. A cue tied to a specific frame belongs to the prepared example it was written for.
3. **Saved clips and stats.** Reopen practice sessions after an app restart. Show the clip and its shot statistics from local storage.
4. **3D example.** Download a prebuilt animated athlete model from the cloud API and open it on the iPhone. After a successful download, reopen it offline with its coaching cue.
5. **Shot clips in the cloud.** For a signed-in player, keep a copy of every tagged shot in the cloud: the window from 3 seconds before the release to 1 second after it. These clips feed later review and computer-vision work.

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
| iPhone database | `expo-sqlite` | Sessions, shot outcomes, downloaded model metadata, and the shot-clip upload queue. The phone is the source of truth for practice history; the cloud keeps a copy of each tagged shot's clip. |
| iPhone auth | `@supabase/supabase-js` | Player sign-in. Signed-in players upload shot clips; signed out, the app is fully local. |
| Cloud API | Vercel Functions (Node.js, Fluid compute), Fastify, TypeScript | Serve the demo catalog, issue upload URLs, cut shot clips with FFmpeg, authorize worker jobs, and store clip metadata and measurements. |
| Local pose worker | Mac, Python 3.11, Shot Coach and PoseMamba | Download pending shots through private signed URLs, run pose inference, and return the extracted joints to the API. |
| Cloud storage | Vercel Blob (models: public store; recordings and clips: private store), Supabase Postgres | Model exports, shot clips, and clip metadata for review and future CV. |
| Cloud auth | Supabase Auth | The API verifies Supabase access tokens (JWT via the project's JWKS). |
| 3D assets | Blender source files, with exports uploaded to Vercel Blob | Create or source a rigged avatar and animate the catch, release, and follow-through. Export one animated shot first. Keep Blender sources out of Blob and Git; upload only the mobile exports. |

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
- Allow a null `video_path` for sessions whose videos were removed. Show their stats with an unavailable replay state. Capture, replay, and stats never wait on the network; shot-clip uploads run in the background and retry.

## Cloud API (Vercel) and 3D download

The API runs on Vercel at the HTTPS URL set in `EXPO_PUBLIC_API_URL`. The laptop and the shared-Wi-Fi setup are no longer needed. For local development, the same Fastify app still runs with `npm run server`, using local stand-ins for Blob, Postgres, and Supabase Auth.

### Public endpoints

- `GET /health` checks that the phone can reach the API.
- `GET /v1/demos?shotType=three_point` returns the matching demo entries from the catalog.

The catalog shape is unchanged. In production, each asset `url` is an absolute HTTPS Vercel Blob URL from the public model store. Locally, it may still be `/media/<versioned-filename>`. Any other asset URL is rejected. `sizeBytes` must equal the uploaded export; `npm run sync-catalog -w server` sets it. Model filenames are versioned and never overwritten; to publish a new model, upload a new version and bump the catalog.

```json
[
  {
    "id": "three-point-follow-through",
    "version": 2,
    "shotType": "three_point",
    "cue": "Hold your finish until the ball reaches the rim.",
    "assets": [
      {
        "format": "usdz",
        "sizeBytes": 8500000,
        "url": "https://<store>.public.blob.vercel-storage.com/models/three-point-follow-through-v2.usdz"
      }
    ]
  }
]
```

When the player taps **View 3D Demo**, look up the matching demo on the phone first so it can open offline. If the asset is missing or a newer version is selected, show download progress, write to a temporary file, verify the expected byte size, then move it into persistent storage and save the metadata. Keep the last working version available if a replacement download fails. Test the actual model animation in Quick Look on the demo iPhone.

### Authenticated endpoints (shot clips)

Every request sends `Authorization: Bearer <Supabase access token>`. The API verifies the token against the Supabase project's JWKS; the token's `sub` is the user id. A missing or invalid token gets `401 {"error":"unauthorized"}`. A player only ever sees or changes their own data.

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /v1/recordings` | `{ sessionId, ext, contentType, sizeBytes, durationMs }` | `{ uploadId, uploadUrl, method: "PUT", headers, expiresAt }`. A short-lived presigned URL for one private Blob path, `recordings/<userId>/<sessionId>/<uploadId>.<ext>`. The phone PUTs the file to it directly, because function bodies are capped at 4.5 MB. Size cap 60 MB; duration cap 30 s. |
| `POST /v1/recordings/:uploadId/clips` | `{ sessionId, shotType, shots: [{ shotNumber, releaseMs, outcome }] }` | Cuts one clip per shot, from `max(0, releaseMs − 3000)` to `min(duration, releaseMs + 1000)` (H.264/AAC MP4, frame-accurate). Stores each at `clips/<userId>/<sessionId>/<shotNumber>.mp4`, upserts its metadata, then deletes the full recording. Returns `{ clips: [{ shotNumber, startMs, endMs, sizeBytes }] }`. Idempotent per `(user, session, shotNumber)`. |
| `PATCH /v1/sessions/:sessionId/shots/:shotNumber` | `{ outcome }` | Updates the clip's outcome. No re-cut is needed. |
| `DELETE /v1/sessions/:sessionId/shots/:shotNumber` | — | Deletes that clip and its row. Idempotent. |
| `DELETE /v1/sessions/:sessionId` | — | Deletes every clip and row for the session. Idempotent. |
| `GET /v1/clips?sessionId=` | — | The player's shots, each with `analysisStatus` and a metrics summary. A signed GET URL is included only while the clip still exists, i.e. before analysis. |

Clip metadata lives in the Supabase Postgres table `shot_clips`: `user_id`, `session_id`, `shot_number`, `shot_type`, `release_ms`, `outcome`, `clip_pathname`, `start_ms`, `end_ms`, `size_bytes`, `analysis_status` (`pending` until CV runs), `analysis` (jsonb), `created_at` and `updated_at`. The primary key is `(user_id, session_id, shot_number)`. Row-level security limits each player to their own rows.

### Phone upload queue

- Uploads happen only while a player is signed in. Signed out, nothing leaves the phone and nothing is queued for later.
- Every new shot starts as `pending`. A background sync, run after tagging, at launch, and when the app returns to the foreground, uploads the session's recording once. It then asks the API to cut clips for all of that session's pending shots and marks them `synced`.
- After a shot is synced, an outcome change marks it for a PATCH. Deleting a shot or a session queues a remote DELETE.
- If the session's video was removed before its clips synced, its pending shots become `unavailable`, because there is nothing left to cut. Stats are unaffected.
- A network failure, an expired token, or a server error leaves the shot pending for the next sync. A sync never blocks recording, tagging, or replay, and never shows the player an error dialog.

## Shot analysis (CV) and storage lifecycle

Shot clips are **temporary inputs to analysis**. Only the data extracted from a shot is kept.

| Stage | Where | Lifetime |
| --- | --- | --- |
| Full recording | Private Blob `recordings/<user>/<session>/...` | Deleted once its clips are cut (2-day TTL as a backstop) |
| Shot clip (4 s mp4) | Private Blob `clips/<user>/<session>/<n>.mp4` | Deleted as soon as its analysis completes (7-day TTL as a backstop) |
| CV output (`.npz`) | Sent directly by the worker. The development `cv-attach` script uses a private Blob. | Discarded once the metrics are saved |
| Extracted shot data | `shot_clips.analysis` (jsonb) | Kept permanently |

- **The CV output format is NumPy `.npz`.** Sample file: `Perspective Project/_EuBHf42Zs8.npz`. Arrays:

  | Array | Shape and type | Contents |
  | --- | --- | --- |
  | `track`, `frame` | int32 (N) | One row per detected person per frame |
  | `kpts2d` | float32 (N×17×2) | 2D keypoints in pixels |
  | `conf` | float32 (N×17) | Per-joint confidence |
  | `bbox` | float32 (N×4) | The person's bounding box |
  | `pose3d`, `pose3d_unit` | float32 (N×17×3) | Pelvis-rooted 3D pose |
  | `joint_names` | (17) | H36M order: pelvis, r_hip, r_knee, r_ankle, l_hip, l_knee, l_ankle, spine, thorax, nose, head, l_shoulder, l_elbow, l_wrist, r_shoulder, r_elbow, r_wrist |
  | `bones` | (16×2) | Joint pairs |
  | `fps`, `eff_fps`, `width`, `height` | scalars | Video metadata |
  | `cuts` | (K) | Scene-cut frame indices |

  There is no ball tracking and there are no shot stats. All shooting metrics are computed by the API from the joints.
- **Analysis.** The Mac worker calls `GET /v1/internal/analysis/jobs` for pending clips and their signed URLs. It returns the computed pose to `POST /v1/internal/analysis` with `{ userId, sessionId, shotNumber, npzBase64 }`. Both requests use `Authorization: Bearer <CV_SERVICE_TOKEN>`. The existing `cv-attach` script can pass an `npzPathname` for a file already in Blob. The API then:
  1. Picks the shooter track at the release frame, `round((releaseMs − startMs) · fps / 1000)`.
  2. Computes versioned metrics:
     - elbow angle at set point and at release
     - knee dip depth
     - dip-to-release time
     - release height
     - trunk lean
     - elbow flare
     - follow-through hold
     - jump proxy
     - balance
     - quality flags
  3. Keeps a **compact shooter pose**: shooter track only, the 4 s window, 2D and 3D joints plus confidence, quantized, under 64 KB. Metrics can be recomputed from it later.
  4. Writes `analysis` and `analysis_status = 'complete'` (or `'failed'`) in a single update.
  5. Then deletes the npz and the mp4, and sets `media_deleted_at`.
  - A shot whose files expire unanalyzed becomes `expired`.
  - `GET /v1/clips` returns `url: null` for analyzed shots. The phone keeps its own local video for replay.
- **Professional reference library: averaged pro shot templates.** The CV team provides one `.npz` per pro player and shot type in `server/reference-data/average-shots/<Player>_<three|midrange>.npz`: 10 players × 2 shot types. Each file holds one **averaged shot**:

  | Array | Shape and type | Contents |
  | --- | --- | --- |
  | `player`, `shot_type` | strings | Player name; `three` or `midrange`, mapped to `three_point` / `midrange` |
  | `shooting_hand` | `R` / `L` | Shooting hand |
  | `fps` | 30 | Frame rate |
  | `t_seconds` | (37) | −0.8 s … +0.4 s around release |
  | `release_index` | 24 | Release frame |
  | `pose3d` | (37×17×3) | Joints, H36M order |
  | `extremities3d` | (37×12×3) | `extremity_names`: middle and index fingertips, middle knuckles, big and small toes, heels |
  | `pelvis_rise` | (37) | Vertical travel |
  | `joint_spread` | (37×17) | Per-frame, per-joint variation across the pro's shots, i.e. consistency |
  | `shots_averaged`, `shots_with_confident_distance` | integers | How many shots went into the average, and how many had a confident shot distance |
  | `units` | string | Unit body height, pelvis-relative. x = shooter right→left, **y down**, z = behind the shooter; add −`pelvis_rise` to y for vertical travel |

  - **Ingest.** The ingest script stores each template, with its metrics, curves and a compact pose, in `reference_templates`, one row per (player, shot type). Re-running it updates rows instead of duplicating them.
  - **Reliability.** Templates averaged from fewer than 10 shots (currently Kennard midrange, 5) are flagged low-confidence and down-weighted. Templates with 0 confident-distance shots are flagged for an uncertain shot-type label.
  - **Comparing a player's shot with the pros.** Player shots are aligned at release and compared over the same −0.8 s … +0.4 s window, with the same metric definitions and body-height normalization. The comparison returns:
    - metric deltas against the pro range for that shot type;
    - per-phase curve differences: load, rise, release, follow-through;
    - deviation expressed in units of the pro's own `joint_spread`;
    - the closest-matching pros.
  - **Coaching thresholds** are calibrated from these templates. Pro baselines per shot type are weighted by `shots_averaged`. Pros differ in style, so coaching targets the pro range and the closest matches, not a single pro.
  - **Raw broadcast footage**, in the clip format above, can still be ingested through the candidate-detector and review path. Only verified shots are used. Pro video is never shown to players; only derived metrics and comparisons are.

## AI coach

After a signed-in player's session has synced, the player can chat with an AI coach about that session; no new upload is needed.

- **Architecture.** The coach is a LangChain Deep Agent (`deepagents` JS) running on Claude Sonnet 5.5 (`claude-sonnet-5-5`) inside the API.
  - Every number comes from deterministic tools: session overview, shot metrics, made vs. missed comparison, a 10 Hz time series, player history, and comparison with the pro reference library.
  - Tools take the player and session from the authenticated request, never from the model.
  - A curated three-point-form skill supplies cues and drills.
  - The coach compares against the pro templates for the session's shot type (`three_point` or `midrange`), citing each template's reliability.
- **Endpoints**, authenticated with the player's Supabase token:

  | Endpoint | Result |
  | --- | --- |
  | `POST /v1/sessions/:sessionId/coach/messages` with `{ message }` | Streams Server-Sent Events: `token`, `tool_status`, `done`, and `error { code }` |
  | `GET /v1/sessions/:sessionId/coach/messages` | The chat history: user and assistant text only |
  | `DELETE /v1/sessions/:sessionId/coach` | Resets the conversation |

- **Errors.**
  - `404 session_not_found`: no synced clips for this session.
  - `429 coach_daily_limit`: per-player daily message cap.
- **Behaviour.**
  - Conversations persist per `(user, session)` in Postgres.
  - The coach never invents numbers, flags missing or low-quality data, gives no medical advice, and stays on basketball.
  - Offline or signed out, the coach is unavailable, and local stats still work.

## Build order and acceptance

1. Save one real recording and verify local playback after relaunch.
2. Tag a small set of shots and verify that edits update the stored session totals.
3. Create the first animated catch-and-shoot model. Verify the export in Quick Look on the demo iPhone, then upload it to Vercel Blob, publish it in the catalog, and verify the in-app download and playback.
4. Turn Wi-Fi off, quit and relaunch the app, and verify that a new recording saves, an existing recording and its stats reopen, and the downloaded 3D model plays.
5. Sign in, record, and tag three shots. When back online, verify that three shot rows appear in `GET /v1/clips` with the right outcomes, and that the full recording is gone from Blob.
6. Attach CV output for those shots. Verify that each shot keeps only its extracted data (the mp4 and npz are deleted), then ask the coach about the session and confirm its answers cite the session's real metrics.

If the API is unreachable and there is no saved model yet, show a retry state in the demo viewer. Keep recording, playback, and local stats accessible throughout.

Mobile and API integration can start with a small placeholder model while the shooting animation is being made. The 3D acceptance check uses the finished catch-and-shoot animation.

## How the demo can grow

- The API and model exports now run on Vercel (Functions and Blob). Consider moving the catalog into Postgres when the team needs a catalog editing workflow.
- Pose inference runs on the Mac. The hosted API tracks jobs through `shot_clips.analysis_status` and stores the derived form measurements in `shot_clips.analysis`. The iPhone currently tags releases manually.
- The phone remains the source of truth for practice history; the cloud keeps shot clips for signed-in players. Full cross-device history would be a separate feature. Public distribution of recognizable NBA models depends on clearing the relevant likeness and source-footage rights.

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
- Keep capture, tagging, and replay usable when the cloud API is unreachable or the player is signed out. The API serves the 3D catalog and model files, and stores shot clips for signed-in players.
- Keep raw practice footage, database exports, and large model source files out of Git. Check in code, catalog structure, and intentionally selected demo assets suitable for the repository.
- Update this file when the team changes the demo drill, stats workflow, asset format, or API contract.
