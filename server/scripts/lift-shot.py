"""Use the local Shot Coach models to export the API's frame-indexed pose format."""

import argparse
import importlib.util
import json
import os
import sys
import threading

import numpy as np

# The models each _load key creates. A resident worker keeps them between jobs.
MODELS = {"2d": ("det", "pose"), "lift": ("lift",), "ext": ("wb", "hand")}


def ensure_loaded(coach, key):
    if not all(name in coach._M for name in MODELS[key]):
        coach._load(key)


def lift_extremities(coach, video, data, frames, joints, pose, tagged_frame):
    if not frames.size or not hasattr(coach, "EXT_NAMES"):
        return {}
    ensure_loaded(coach, "ext")
    points = np.full((len(frames), len(coach.EXT_NAMES), 2), np.nan, dtype=np.float32)
    fps = data["fps"]
    window = np.flatnonzero((frames >= tagged_frame - 1.2 * fps) & (frames <= tagged_frame + fps))
    capture = None
    try:
        for row in window:
            frame = int(frames[row])
            image = data["store"].get(frame)
            if image is None:
                if capture is None:
                    capture = coach.cv2.VideoCapture(video)
                capture.set(coach.cv2.CAP_PROP_POS_FRAMES, frame)
                ok, image = capture.read()
                if not ok:
                    continue
            kpts, scores = coach.extremities_2d(image, joints[row], coach._M["wb"], coach._M["hand"])
            points[row] = np.where((scores >= 0.2)[:, None], kpts, np.nan)
    finally:
        if capture is not None:
            capture.release()
    lifted = coach.extremities_3d(points.astype(float), joints.astype(float), pose.astype(float))
    return {"extremities3d": lifted.astype("<f4"), "extremity_names": np.array(coach.EXT_NAMES)}


def export_pose(coach, video, release_offset_ms, output):
    coach.setup()
    ensure_loaded(coach, "2d")
    data = coach.track(video)
    if not data["W"] or not data["H"]:
        raise ValueError("Could not decode the clip")

    fps = data["fps"]
    tagged_frame = round(release_offset_ms * fps / 1000)
    nearby = np.abs(data["frame"] - tagged_frame) <= 5
    joints = coach.halpe2h36m(data["kpts"]).astype(np.float32)
    confidence = coach.halpe2h36m(data["conf"][..., None])[..., 0]
    boxes = np.concatenate((joints.min(axis=1), joints.max(axis=1)), axis=1)
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    scores = area * confidence.mean(axis=1)
    tracks = np.unique(data["track"][nearby])
    if tracks.size:
        shooter = max(tracks, key=lambda track_id: scores[nearby & (data["track"] == track_id)].mean())
        selected = data["track"] == shooter
    else:
        selected = np.zeros(len(data["frame"]), dtype=bool)

    frames = data["frame"][selected]
    joints = joints[selected]
    confidence = confidence[selected]
    pose = np.empty((0, 17, 3), dtype=np.float32)
    if frames.size:
        joints = coach.fill_gaps(joints, confidence).astype(np.float64)
        joints, confidence, _ = coach.fix_swaps(joints, confidence)
        ensure_loaded(coach, "lift")
        model_input = coach.normalize(joints).astype(np.float32)
        pose = coach.lift_track(coach._M["lift"], model_input, True)
        pose /= max(float(np.median(coach.skeleton_height(pose))), 1e-6)
        pose = coach.lowpass(pose, data["eff"])
        joints = coach.lowpass(joints, data["eff"])

    # Keep the source video frame numbers, including gaps when the tracker
    # skips frames. The API aligns the user's tag against this time base.
    extremities = lift_extremities(coach, video, data, frames, joints, pose, tagged_frame)
    np.savez_compressed(
        output,
        track=data["track"][selected].astype("<i4"),
        frame=frames.astype("<i4"),
        kpts2d=joints.astype("<f4"),
        conf=confidence.astype("<f4"),
        bbox=boxes[selected].astype("<f4"),
        pose3d_unit=pose.astype("<f4"),
        joint_names=np.array(coach.H36M_NAMES),
        fps=np.float64(fps),
        eff_fps=np.float64(data["eff"]),
        width=np.int32(data["W"]),
        height=np.int32(data["H"]),
        **extremities,
    )


def load_coach(path):
    spec = importlib.util.spec_from_file_location("shot_coach", path)
    if spec is None or spec.loader is None:
        return None
    coach = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(coach)
    return coach


def serve(coach_path):
    """Resident mode for the pose worker: load the models once, then run one job per stdin line.

    Each request is a JSON line {"video", "release_offset_ms", "output"}; each answer is one JSON
    line {"ok": true} or {"ok": false, "error": "..."} on the original stdout. Anything the
    libraries print goes to stderr, so it can never corrupt the answers.
    """
    replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    coach = load_coach(coach_path)
    if coach is None:
        sys.exit("SHOT_COACH_PATH must point to shot_coach.py")
    coach.setup()
    # Load all three model sets at once, as shot_coach.lift does; ONNX and torch release the GIL.
    loaders = [threading.Thread(target=ensure_loaded, args=(coach, key)) for key in MODELS]
    for loader in loaders:
        loader.start()
    for loader in loaders:
        loader.join()
    replies.write(json.dumps({"ready": True}) + "\n")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            job = json.loads(line)
            export_pose(coach, job["video"], int(job["release_offset_ms"]), job["output"])
            reply = {"ok": True}
        except Exception as error:  # one bad clip must not stop the worker
            reply = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        replies.write(json.dumps(reply) + "\n")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve(sys.argv[2])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot_coach")
    parser.add_argument("video")
    parser.add_argument("release_offset_ms", type=int)
    parser.add_argument("output")
    args = parser.parse_args()
    coach = load_coach(args.shot_coach)
    if coach is None:
        parser.error("SHOT_COACH_PATH must point to shot_coach.py")
    export_pose(coach, args.video, args.release_offset_ms, args.output)


if __name__ == "__main__":
    main()
