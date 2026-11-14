"""Export one contiguous NPZ pose track as a stick-figure Quick Look preview."""

import argparse
import math
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import numpy as np


def read_track(source, track_id, start, end):
    if start < 0 or not 1 <= end - start <= 600:
        raise ValueError("select an inclusive span of 2–601 sequential source frames")
    with np.load(source, allow_pickle=False) as data:
        track, frame = data["track"], data["frame"]
        indices = np.flatnonzero((track == track_id) & (frame >= start) & (frame <= end))
        indices = indices[np.argsort(frame[indices])]
        if not np.array_equal(frame[indices], np.arange(start, end + 1)):
            raise ValueError("the selected track must have exactly one pose for every frame")
        poses = data["pose3d_unit"][indices].astype(np.float64)
        names = list(data["joint_names"])
        bones = data["bones"]
        fps = float(data["fps"])
    if poses.shape != (len(indices), len(names), 3) or not np.isfinite(poses).all():
        raise ValueError("the selected span contains missing or invalid 3D joints")
    if (bones.ndim != 2 or bones.shape[1] != 2 or not np.issubdtype(bones.dtype, np.integer)
            or np.any(bones < 0) or np.any(bones >= len(names)) or np.any(bones[:, 0] == bones[:, 1])):
        raise ValueError("invalid bone connections")
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("invalid source frame rate")

    left, right = names.index("l_ankle"), names.index("r_ankle")
    # The input pose is body-relative and uses image-down Y. Size the preview
    # approximately for AR; these normalized coordinates do not measure height.
    poses *= np.array([1.0, -1.0, -1.0])
    floor = np.median(np.minimum(poses[:, left, 1], poses[:, right, 1]))
    height = np.median(poses[:, names.index("head"), 1]) - floor
    if height <= 0:
        raise ValueError("the selected poses do not have a usable upright orientation")
    poses[:, :, 1] -= floor
    poses *= 1.7 / height
    return poses, names, bones, fps


def vector(values):
    return "(" + ", ".join(f"{value:.6f}" for value in values) + ")"


def animated(kind, op, values):
    samples = ",\n".join(f"            {i}: {vector(values[i])}" for i in range(len(values)))
    return (
        f"        {kind} xformOp:{op} = {vector(values[0])}\n"
        f"        {kind} xformOp:{op}.timeSamples = {{\n{samples}\n        }}\n"
    )


def orient_y(directions):
    quaternions = []
    for x, y, z in directions:
        # Quaternion rotating the cylinder's local +Y to the bone direction.
        q = np.array([1 + y, z, 0, -x])
        norm = np.linalg.norm(q)
        q = q / norm if norm > 1e-8 else np.array([0, 1, 0, 0])
        if quaternions and np.dot(q, quaternions[-1]) < 0:
            q = -q
        quaternions.append(q)
    return quaternions


def make_stage(poses, names, bones, fps):
    lines = [f"""#usda 1.0
(
    defaultPrim = "PosePreview"
    metersPerUnit = 1
    upAxis = "Y"
    startTimeCode = 0
    endTimeCode = {len(poses) - 1}
    timeCodesPerSecond = {fps}
    framesPerSecond = {fps}
)

def Xform "PosePreview" (
    kind = "component"
)
{{"""]
    base = (0.56, 0.70, 0.74)
    upper = (0.09, 0.62, 0.65)
    highlight = (0.95, 0.58, 0.19)
    for index, name in enumerate(names):
        color = highlight if name.endswith("wrist") else upper
        radius = 0.062 if name == "head" else 0.034
        lines.append(f'    def Sphere "Joint_{index}"\n    {{\n        double radius = {radius}')
        lines.append(f"        color3f[] primvars:displayColor = [{vector(color)}]")
        lines.append(animated("double3", "translate", poses[:, index]))
        lines.append('        uniform token[] xformOpOrder = ["xformOp:translate"]\n    }')
    for index, (parent, child) in enumerate(bones):
        start, end = poses[:, parent], poses[:, child]
        diff = end - start
        lengths = np.linalg.norm(diff, axis=1)
        if np.any(lengths <= 1e-6):
            raise ValueError(f"bone {index} collapses within the selected span")
        color = upper if names[child].endswith(("shoulder", "elbow", "wrist")) else base
        lines.append(f'    def Cylinder "Bone_{index}"\n    {{\n        uniform token axis = "Y"')
        lines.append("        double height = 2\n        double radius = 0.023")
        lines.append(f"        color3f[] primvars:displayColor = [{vector(color)}]")
        lines.append(animated("double3", "translate", (start + end) / 2))
        lines.append(animated("quatf", "orient", orient_y(diff / lengths[:, None])))
        lines.append(animated("float3", "scale", [(1, length / 2, 1) for length in lengths]))
        lines.append('        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]\n    }')
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("--track", type=int, required=True)
    cli.add_argument("--start-frame", type=int, required=True)
    cli.add_argument("--end-frame", type=int, required=True)
    args = cli.parse_args()
    if args.output.suffix != ".usdz" or args.output.exists():
        cli.error("choose a new output filename ending in .usdz")
    try:
        stage = make_stage(*read_track(args.source, args.track, args.start_frame, args.end_frame))
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "pose.usda").write_text(stage, encoding="utf-8")
            subprocess.run(["usdcat", "pose.usda", "-o", "pose.usdc"], cwd=root, check=True)
            subprocess.run(["usdzip", str(args.output.resolve()), "pose.usdc"], cwd=root, check=True)
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        cli.exit(1, f"Could not export the pose: {error}\n")
    print(f"Exported {args.output}: {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
