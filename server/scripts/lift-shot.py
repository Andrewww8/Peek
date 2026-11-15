"""Use the local Shot Coach models to export the API's frame-indexed pose format."""

import argparse
import importlib.util

import numpy as np


def lift_extremities(coach, video, data, frames, joints, pose, tagged_frame):
    if not frames.size or not hasattr(coach, "EXT_NAMES"):
        return {}
    coach._load("ext")
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
    coach._load("2d")
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
        coach._load("lift")
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot_coach")
    parser.add_argument("video")
    parser.add_argument("release_offset_ms", type=int)
    parser.add_argument("output")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("shot_coach", args.shot_coach)
    if spec is None or spec.loader is None:
        parser.error("SHOT_COACH_PATH must point to shot_coach.py")
    coach = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(coach)
    export_pose(coach, args.video, args.release_offset_ms, args.output)


if __name__ == "__main__":
    main()
