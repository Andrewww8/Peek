# Shot Coach

One script: a video of a basketball jump shot → a cleaned 3D pose → a comparison with ten NBA shooters
(Stephen Curry, Damian Lillard, Kyrie Irving, Ray Allen, Anthony Edwards, Luke Kennard, Luka Dončić, Donte DiVincenzo, LaMelo Ball, Shai Gilgeous-Alexander).

Everything runs inside this folder and everything it produces goes to `outputs/`.

## Setup

```
cd shot_coach
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

The first run sets up the rest by itself: it compiles `sscan.c`, downloads the 3D model weights (114 MB) into `weights/`,
and rtmlib downloads its 2D pose models into `~/.cache/rtmlib`. After that a video takes about 5 seconds.

## Usage

```
python shot_coach.py similar    <shot> <three|mid>            # which NBA player you're closest to
python shot_coach.py difference <shot> <three|mid> <player>   # what to change to look like that player
python shot_coach.py lift       <shot>                        # only make the pose file
```

Examples:

```
python shot_coach.py similar my_shot.mov three
python shot_coach.py difference my_shot.mov mid curry --hand L
```

## Inputs

- `<shot>`: one shot, either a video (`.mov .mp4 .m4v .avi .mkv`) of one person taking one jump shot, or a pose `.npz` this script made earlier.
- `<three|mid>`: the shot type; you are compared against the NBA players' shots of the same type.
- `<player>` (difference only): any unambiguous part of a name, such as `curry`, `"ray allen"`, `sga`, `luka`, `dame`, `ant`, `melo`.
- Options:
  - `--hand R|L`: shooting hand; auto-detected if omitted.
  - `--relift`: redo the 3D lift even if a pose file already exists.
  - `--clip`: also save an overlay video.
  - `--out DIR`: where to save; the default is the `outputs/` folder next to the script.
  - `--all`: include the less reliable measures.
  - `--explain`: print what each measure means.
  - `--top N`: how many differences to list (default 8).

## Outputs

All in `outputs/`:

- `<video name>.npz`: the pose clipped to 1.0 s before release through 0.5 s after, at 30 fps, 46 samples, release at index 30.
  - Pose arrays: `pose3d (46,17,3)`, `kpts2d`, `extremities3d/2d` (fingertips and toes), `extremity_conf`, `pelvis_rise`, `t_seconds`.
  - Release: `release_video_frame`, `release_s`, `release_conf`, `clip_start_s`, `clip_end_s`.
  - Quality and context: `hand`, `accuracy`, `view`, `yaw_deg`, `camera`, `cam_compensated`, `swap_frames`.
  - Units: body heights, pelvis-relative, x right, y down, z away from the camera.
- `<video name>_similar_<type>.txt` and `.json`: the report and the same result as data.
  - `similar` ranks the players and lists the three most alike and three most different measures.
- `<video name>_difference_<type>_<player>.txt`, `.json` and `.csv`: the report, the same result as data, and the full table of measures.
  - `difference` lists the top 3 you already match, the bottom 3 furthest apart, and other differences, each with a short cue.
- The same name with `.html`: the 3D viewer. Your skeleton (grey) is overlaid on the player's average shot (orange), both scaled to the same height, facing the same way and lined up at the release.
  - `similar` shows you against the closest player; `difference` shows you against the player you chose.
  - Drag to rotate, scroll to zoom, space to play or pause, arrow keys to step a frame. The dashed line on the bar is the release.
  - A left-handed shooter is mirrored so both skeletons shoot with the same hand; the legend says so.
- `<video name>.mp4`: only with `--clip`.

The report is also printed.

## Requirements

These sit next to the script:

- `nba_reference.json` (835 KB): the NBA players' values for the 34 measures, plus names, descriptions, cues and each player's average shot.
- `assets/skeleton.glb`: the skeleton model the 3D viewer draws.
- `third_party/PoseMamba/`: the PoseMamba model code (Apache-2.0).
- `sscan.c`: the scan kernel; compiled to `libsscan.dylib` on first run (needs the Xcode command line tools).
- `weights/PoseMamba_L.bin`: downloaded on first run from Hugging Face and checked against a fixed checksum.

The environment:

- macOS on Apple silicon.
- Python 3.11 with the packages in `requirements.txt` (numpy, scipy, opencv-python, torch, einops, timm, fvcore, onnxruntime, rtmlib).
- An internet connection on the first run, and when opening a viewer page (it loads three.js from a CDN).

## How it works

decode the video once → person detection, 2D pose and tracking → pick the shooter → repair left/right swaps →
measure camera motion from the background (undone before lifting if the camera moves) → PoseMamba 3D lift →
zero-phase Butterworth filter → fingertips and toes → release point → quality score → 34 measures → comparison.

## Things to know

- Film one shooter, whole body in frame, one shot per video. The shot type is not detected; you give it.
- Phone footage and NBA broadcast footage are not perfectly comparable, so treat the order of the differences as a guide rather than exact numbers.
- Timing, knee bend, dip, stance and rise are the most trustworthy measures. Nine measures that depend on estimated depth or fingertip position are left out unless you pass `--all`.
- "Closest player" results are often near-ties; the report says so when they are.
- Luke Kennard has too few mid-range shots in the reference, so he is skipped for `mid`.
