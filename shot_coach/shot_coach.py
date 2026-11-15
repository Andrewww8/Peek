"""shot_coach.py - one script: basketball shot video -> cleaned 3D pose -> comparison with ten NBA shooters.

USAGE
  python shot_coach.py similar    <shot> <three|mid>            which NBA player the shot is closest to
  python shot_coach.py difference <shot> <three|mid> <player>   what to change to look like that player
  python shot_coach.py lift       <shot>                        only make the pose file

INPUTS
  <shot>       ONE shot: a video (.mov .mp4 .m4v .avi .mkv) of one person taking one jump shot, or a pose .npz this script made before.
  <three|mid>  the shot type; the NBA players' shots of the same type are the reference.
  <player>     any unambiguous part of a name: curry, "ray allen", sga, luka, dame, ant, melo ...
  options      --hand R|L   shooting hand (auto-detected if omitted; set it if the detection is wrong)
               --relift     redo the 3D lift even if a pose file already exists for this video
               --clip       also save an overlay clip (video + 2D skeleton + 3D skeleton)
               --out DIR    where to save (default: the outputs/ folder next to this script)
               --all        include the measures that rely on estimated depth / fingertip position
               --explain    print what each measure means
               --top N      how many differences to list (default 8)

OUTPUTS (all in outputs/)
  <video>.npz                               the pose, clipped to 1.0 s before the release .. 0.5 s after, 30 fps, 46 samples, release at index 30:
        pose3d (46,17,3)  kpts2d (46,17,2)  extremities3d (46,12,3)  extremities2d  extremity_conf  pelvis_rise (46,)  t_seconds
        joint_names  extremity_names  release_idx  release_video_frame  release_s  release_conf  clip_start_s  clip_end_s
        valid_from  valid_to  hand  accuracy (0-100)  view  yaw_deg  camera  cam_compensated  swap_frames  fps  height_px
        units: body heights, pelvis-relative, x right, y down, z away from the camera
  <video>_similar_<type>.txt / .json        the printed report and the same result as data
  <video>_difference_<type>_<player>.txt / .json / .csv     report, data, and the full table of measures
  ..._similar_<type>.glb / ..._difference_<type>_<player>.glb       animated 3D file: your skeleton (grey) over the player's average shot (orange),
                                            46 keys at 30 fps, release at 1.0 s; similar = the closest player, difference = the player you chose
  <video>.mp4                               only with --clip

REQUIREMENTS (all next to this script)
  nba_reference.json          the NBA players' measures, measure names, descriptions, cues and average shots
  assets/skeleton.glb         the skeleton model used to write the .glb files
  third_party/PoseMamba/      the PoseMamba model code (Apache-2.0)
  sscan.c                     selective-scan kernel; compiled to libsscan.dylib on first run (needs the Xcode command line tools)
  weights/PoseMamba_L.bin     3D lifting model weights; downloaded on first run (114 MB, from Hugging Face)
  Python 3.11 with the packages in requirements.txt
  rtmlib downloads its 2D models on first use (~/.cache/rtmlib); compiled CoreML copies are cached in ~/.cache/rtmlib/coreml
  macOS on Apple silicon (CoreML + MPS).

PIPELINE (video input, about 5 s after the first run)
  decode once -> person detection + 2D pose + tracking -> pick the shooter -> left/right swap repair -> camera motion from the
  background (undone before lifting if the camera moves) -> PoseMamba 3D lift (mirrored average) -> zero-phase Butterworth ->
  fingertips/toes -> release point (fingertip peak) -> quality score -> 34 measures -> comparison
"""
import argparse
import contextlib
import csv
import ctypes
import hashlib
import io
import json
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time
import types
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(ROOT, "third_party", "PoseMamba")
WEIGHTS = os.path.join(ROOT, "weights")
OUTPUTS = os.path.join(ROOT, "outputs")
KERNEL = os.path.join(ROOT, "libsscan.dylib")
WEIGHTS_URL = "https://huggingface.co/nankingjings/PoseMamba-weights/resolve/732bd6d262b628cf2daf979bbd660a7d0974631a/PoseMamba_L.bin"
WEIGHTS_SHA256 = "031a033dbb4266f093d048e55758e55025c663f65db8d84291b6116794124501"
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".avi", ".mkv")
PRE, POST, NT = 1.0, 0.5, 46                       # shot window: seconds before / after the release, samples at 30 fps
EXT_THREADS = 3                                        # fingertip/toe frames processed at once
FRAME_BUDGET = 1.6e9                               # bytes of decoded frames kept in memory (longer videos are re-read instead)
PLAYER_HEIGHT_CM = {"Stephen Curry": 188, "Damian Lillard": 188, "Kyrie Irving": 188, "Ray Allen": 196, "Anthony Edwards": 193, "Luke Kennard": 196,
                    "Luka Doncic": 198, "Donte DiVincenzo": 193, "LaMelo Ball": 201, "Shai Gilgeous-Alexander": 198}      # listed heights; the .glb draws both skeletons at the player's height
ALIAS = {"sga": "Shai Gilgeous-Alexander", "steph": "Stephen Curry", "ant": "Anthony Edwards", "dame": "Damian Lillard", "luka": "Luka Doncic", "melo": "LaMelo Ball"}
from concurrent.futures import ThreadPoolExecutor

import cv2
import torch
import torch.nn.functional as F
from scipy.signal import butter, filtfilt


# ===================================================================== constants (copied from the pipeline modules)


H36M_NAMES = ['pelvis', 'r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle', 'spine', 'thorax', 'nose', 'head', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_shoulder', 'r_elbow', 'r_wrist']
WIN = 243
STRIDE = 203
TARGET_H = 0.8
GROUPS = {'legs': [(1, 4), (2, 5), (3, 6)], 'arms': [(14, 11), (15, 12), (16, 13)]}
LAMBDA = 0.004
SWITCH = 0.12
FC_BODY = 6.0
FC_ARMS = 10.0
ARM_JOINTS = [12, 13, 15, 16]
ARMS = {'R': (14, 15, 16), 'L': (11, 12, 13)}
OFF_TIP = -0.29
OFF_WRIST95 = 0.55
EXT_NAMES = ['l_middle_tip', 'r_middle_tip', 'l_index_tip', 'r_index_tip', 'l_middle_knuckle', 'r_middle_knuckle', 'l_big_toe', 'r_big_toe', 'l_small_toe', 'r_small_toe', 'l_heel', 'r_heel']
HAND_IDX = {'middle_tip': 12, 'index_tip': 8, 'middle_knuckle': 9}
FOOT_IDX = {'big_toe': (17, 20), 'small_toe': (18, 21), 'heel': (19, 22)}
LEN = {'middle_tip': 0.108, 'index_tip': 0.1, 'middle_knuckle': 0.055, 'big_toe': 0.12, 'small_toe': 0.105, 'heel': 0.045}
WB_SCORE_FULL = 6.0
VARIANTS = {'S': (64, 10), 'B': (128, 10), 'L': (128, 20)}
_LEFT = [4, 5, 6, 11, 12, 13]
_RIGHT = [1, 2, 3, 14, 15, 16]
DET_EVERY = 15
DET_EVERY_EMPTY = 4
LOST_CONF = 0.35
LOST_PATIENCE = 6
QBONES = {'r_upper_arm': (14, 15), 'r_forearm': (15, 16), 'l_upper_arm': (11, 12), 'l_forearm': (12, 13), 'r_thigh': (1, 2), 'r_shin': (2, 3), 'l_thigh': (4, 5), 'l_shin': (5, 6)}
QPAIRS = [('r_upper_arm', 'l_upper_arm'), ('r_forearm', 'l_forearm'), ('r_thigh', 'l_thigh'), ('r_shin', 'l_shin')]
Q_REL = 30
BONES = [(0, 1), (1, 2), (2, 3), (0, 4), (4, 5), (5, 6), (0, 7), (7, 8), (8, 9), (9, 10), (8, 11), (11, 12), (12, 13), (8, 14), (14, 15), (15, 16)]
SIDE = ['r', 'r', 'r', 'l', 'l', 'l', 'c', 'c', 'c', 'c', 'l', 'l', 'l', 'r', 'r', 'r']
COL = {'r': (60, 60, 255), 'l': (255, 140, 40), 'c': (60, 220, 60)}
EXTRA_COL = [(0, 255, 255), (0, 255, 255), (0, 200, 0), (0, 200, 0), (255, 0, 255), (255, 0, 255), (0, 128, 255), (0, 128, 255), (255, 128, 0), (255, 128, 0), (255, 255, 255), (255, 255, 255)]


# ===================================================================== PoseMamba on Apple silicon (native selective scan)


_lib = None
_patched = False


def setup():
    """First run only: compile the scan kernel and download the lifting weights."""
    if not os.path.exists(KERNEL):
        print("First run: compiling sscan.c ...", flush=True)
        try:
            subprocess.run(["cc", "-O3", "-ffast-math", "-mcpu=native", "-shared", "-fPIC", "-o", KERNEL, os.path.join(ROOT, "sscan.c")], check=True)
        except (OSError, subprocess.CalledProcessError) as ex:
            sys.exit(f"Could not compile sscan.c ({ex}). Install the Xcode command line tools: xcode-select --install")
    dst = os.path.join(WEIGHTS, "PoseMamba_L.bin")
    if not os.path.exists(dst):
        print("First run: downloading the 3D lifting weights (114 MB) ...", flush=True)
        os.makedirs(WEIGHTS, exist_ok=True); tmp = dst + ".part"; sha = hashlib.sha256()
        try:
            with urllib.request.urlopen(urllib.request.Request(WEIGHTS_URL, headers={"User-Agent": "shot-coach"})) as r, open(tmp, "wb") as fh:
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    fh.write(chunk); sha.update(chunk)
        except OSError as ex:
            sys.exit(f"Could not download the weights ({ex}). Get PoseMamba_L.bin from {WEIGHTS_URL} and put it in weights/")
        if sha.hexdigest() != WEIGHTS_SHA256:
            os.remove(tmp); sys.exit("The downloaded weights do not match the expected checksum; nothing was saved.")
        os.replace(tmp, dst)


def _native():
    global _lib
    if _lib is None:
        _lib = ctypes.CDLL(KERNEL)
        fp = ctypes.c_void_p
        _lib.sscan.argtypes = [fp] * 7 + [ctypes.c_int] * 4
        _lib.sscan.restype = None
    return _lib


def selective_scan_native(u, delta, A, B, C, D=None, delta_bias=None, delta_softplus=True):
    """Same semantics as selective_scan_torch, run by libsscan (sscan.c) on CPU threads."""
    dev = u.device
    u = u.detach().float().cpu().contiguous()
    delta = delta.detach().float().cpu()
    if delta_bias is not None:
        delta = delta + delta_bias.detach().float().cpu()[None, :, None]
    if delta_softplus:
        delta = F.softplus(delta)
    delta = delta.contiguous()
    b, d, L = u.shape
    g, n = B.shape[1], A.shape[1]
    assert n == 16 and d % g == 0
    A = A.detach().float().cpu().contiguous()
    Bm = B.detach().float().cpu().permute(0, 1, 3, 2).contiguous()
    Cm = C.detach().float().cpu().permute(0, 1, 3, 2).contiguous()
    Dp = D.detach().float().cpu().contiguous() if D is not None else None
    y = torch.empty_like(u)
    _native().sscan(u.data_ptr(), delta.data_ptr(), A.data_ptr(), Bm.data_ptr(), Cm.data_ptr(),
                    Dp.data_ptr() if Dp is not None else None, y.data_ptr(), b, d, g, L)
    return y.to(dev)


class _TorchSelectiveScan(torch.autograd.Function):
    @staticmethod
    def forward(ctx, u, delta, A, B, C, D=None, delta_bias=None,
                delta_softplus=False, nrows=1, backnrows=1, oflex=True):
        return selective_scan_native(u, delta, A, B, C, D, delta_bias, delta_softplus)

    @staticmethod
    def backward(ctx, *a):
        raise NotImplementedError("inference only")


def _patch_imports():
    global _patched
    if _patched:
        return
    if REPO not in sys.path:
        sys.path.insert(0, REPO)
    # Triton isn't available on macOS; the PoseMamba forward path never uses these.
    stub = types.ModuleType("lib.model.csm_triton")
    for name in ["CrossScanTriton", "CrossMergeTriton", "CrossScanTriton1b1",
                 "CrossScanTritonF", "CrossMergeTritonF", "CrossScanTriton1b1F"]:
        setattr(stub, name, None)
    stub.getCSM = lambda *a, **k: (None, None)
    sys.modules["lib.model.csm_triton"] = stub
    sys.modules["csm_triton"] = stub
    import lib.model.csms6s as csms6s
    csms6s.SelectiveScanCore = _TorchSelectiveScan
    csms6s.SelectiveScanOflex = _TorchSelectiveScan
    csms6s.SelectiveScanMamba = _TorchSelectiveScan
    import lib.model.mambablocks as mb
    mb.SelectiveScanCore = _TorchSelectiveScan
    mb.SelectiveScanOflex = _TorchSelectiveScan
    mb.SelectiveScanMamba = _TorchSelectiveScan
    _patched = True


def default_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_posemamba(variant="L", device=None):
    _patch_imports()
    from lib.model.PoseMamba import PoseMamba
    dim, depth = VARIANTS[variant]
    model = PoseMamba(num_frame=243, embed_dim_ratio=dim, mlp_ratio=2, depth=depth)
    # Checkpoint holds a numpy scalar (min_loss); allowlist just that, keep weights_only=True.
    torch.serialization.add_safe_globals([
        (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
        np.dtype, type(np.dtype("float64")),
    ])
    ckpt = torch.load(os.path.join(WEIGHTS, f"PoseMamba_{variant}.bin"),
                      map_location="cpu", weights_only=True)
    sd = {k.removeprefix("module."): v for k, v in ckpt["model_pos"].items()}
    model.load_state_dict(sd, strict=True)
    model.eval()
    return model.to(device or default_device())


def flip_pose(x):
    x = x.clone()
    x[..., 0] *= -1
    x[..., _LEFT + _RIGHT, :] = x[..., _RIGHT + _LEFT, :]
    return x


@torch.no_grad()
def lift_clip(model, kp2d, flip=True):
    """kp2d: (T<=243, 17, 2) float array already normalized to [-1, 1]
    (crop_scale). Returns (T, 17, 3) root-relative 3D (root = pelvis = 0)."""
    T = kp2d.shape[0]
    assert T <= 243
    dev = next(model.parameters()).device
    x = torch.as_tensor(kp2d, dtype=torch.float32)  # model accepts any T <= 243
    x = x[None].to(dev)
    if flip:
        out = model(torch.cat([x, flip_pose(x)], 0))
        out = (out[0] + flip_pose(out[1:2])[0]) / 2
    else:
        out = model(x)[0]
    out = out - out[:, :1]  # root-relative
    return out[:T].float().cpu().numpy()



# ===================================================================== 2D helpers, lifting, cleanup


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def kpt_bbox(k, c, w, h, pad=0.2):
    m = c > 0.3
    if m.sum() < 6:
        return None
    x1, y1 = k[m].min(0)
    x2, y2 = k[m].max(0)
    px, py = (x2 - x1) * pad, (y2 - y1) * pad
    return np.array([max(0, x1 - px), max(0, y1 - py), min(w, x2 + px), min(h, y2 + py)], np.float32)


def halpe2h36m(x):
    """(T,26,C) Halpe-26 -> (T,17,C) Human3.6M (same mapping as the PoseMamba repo)."""
    y = np.zeros((x.shape[0], 17, x.shape[2]), x.dtype)
    y[:, 0] = x[:, 19]; y[:, 1] = x[:, 12]; y[:, 2] = x[:, 14]; y[:, 3] = x[:, 16]
    y[:, 4] = x[:, 11]; y[:, 5] = x[:, 13]; y[:, 6] = x[:, 15]
    y[:, 7] = (x[:, 18] + x[:, 19]) * 0.5
    y[:, 8] = x[:, 18]; y[:, 9] = x[:, 0]; y[:, 10] = x[:, 17]
    y[:, 11] = x[:, 5]; y[:, 12] = x[:, 7]; y[:, 13] = x[:, 9]
    y[:, 14] = x[:, 6]; y[:, 15] = x[:, 8]; y[:, 16] = x[:, 10]
    return y


def fill_gaps(k, c, thr=0.3):
    """Linearly interpolate joints whose confidence is below thr (per joint, over time)."""
    k = k.copy()
    T = len(k)
    t = np.arange(T)
    for j in range(k.shape[1]):
        good = c[:, j] >= thr
        if good.all() or good.sum() < 2:
            continue
        for a in range(2):
            k[~good, j, a] = np.interp(t[~good], t[good], k[good, j, a])
    return k


def shot_candidates(k, fps):
    """Loose 2D test, per frame: a wrist peaks above the head after rising from chest level."""
    torso = np.median(np.linalg.norm(k[:, 8] - k[:, 0], axis=-1)) + 1e-6
    w = max(2, int(round(0.8 * fps)))
    out = set()
    for s_, w_ in ((14, 16), (11, 13)):
        rise = (k[:, s_, 1] - k[:, w_, 1]) / torso
        up = (rise > 0.4) & (k[:, w_, 1] < k[:, 9, 1])   # wrist above the nose
        for t in np.where(up)[0]:
            lo = max(0, t - w)
            if rise[t] >= rise[max(0, t - 3):t + 4].max() - 1e-9 and rise[t] - rise[lo:t + 1].min() > 0.7:
                out.add(int(t))
    return sorted(out)


def normalize(k):
    """One center + scale for the whole track, so in-track motion (the jump) is preserved."""
    ext = k[:, :, 1].max(1) - k[:, :, 1].min(1)
    s = max(np.median(ext), 1e-3) / TARGET_H
    ctr = np.median(k[:, 0], axis=0)
    return (k - ctr) / s


def lift_track(model, k2, flip):
    T = len(k2)
    if T <= WIN:
        return lift_clip(model, k2, flip)
    out = np.zeros((T, 17, 3), np.float32)
    wsum = np.zeros((T, 1, 1), np.float32)
    starts = list(range(0, T - WIN, STRIDE)) + [T - WIN]
    ramp = np.minimum(np.arange(1, WIN + 1), np.arange(WIN, 0, -1)).astype(np.float32)[:, None, None]
    for s in starts:
        out[s:s + WIN] += lift_clip(model, k2[s:s + WIN], flip) * ramp
        wsum[s:s + WIN] += ramp
    return out / wsum


def skeleton_height(p):
    """leg + torso + head chain length, per frame."""
    seg = lambda a, b: np.linalg.norm(p[:, a] - p[:, b], axis=-1)
    leg = (seg(1, 2) + seg(2, 3) + seg(4, 5) + seg(5, 6)) / 2
    return leg + seg(0, 7) + seg(7, 8) + seg(8, 10)


def viterbi_swaps(k2, pairs, h):
    """Return a bool array: True where this limb group's left/right labels should be swapped."""
    T = len(k2)
    L = np.stack([k2[:, a] for a, b in pairs], 1) / h          # (T, P, 2) "right" labelled
    R = np.stack([k2[:, b] for a, b in pairs], 1) / h
    pos = {0: (L, R), 1: (R, L)}                                # state 1 = swapped

    def trans(t, s_prev, s):
        a0, b0 = pos[s_prev]; a1, b1 = pos[s]
        return np.linalg.norm(a1[t] - a0[t - 1], axis=-1).sum() + np.linalg.norm(b1[t] - b0[t - 1], axis=-1).sum()

    cost = np.array([0.0, LAMBDA])
    back = np.zeros((T, 2), np.int8)
    for t in range(1, T):
        new = np.empty(2)
        for s in (0, 1):
            c = [cost[sp] + trans(t, sp, s) + (SWITCH if sp != s else 0.0) for sp in (0, 1)]
            back[t, s] = int(np.argmin(c)); new[s] = min(c) + LAMBDA * s
        cost = new
    s = int(np.argmin(cost)); out = np.zeros(T, bool)
    for t in range(T - 1, -1, -1):
        out[t] = bool(s); s = back[t, s]
    return out


def fix_swaps(k2, cf):
    k2, cf = k2.copy(), cf.copy()
    h = max(np.median(k2[:, :, 1].max(1) - k2[:, :, 1].min(1)), 1.0)
    n = 0
    for pairs in GROUPS.values():
        sw = viterbi_swaps(k2, pairs, h)
        if sw.any():
            for a, b in pairs:
                k2[sw, a], k2[sw, b] = k2[sw, b].copy(), k2[sw, a].copy()
                cf[sw, a], cf[sw, b] = cf[sw, b].copy(), cf[sw, a].copy()
            n += int(sw.sum())
    return k2, cf, n


def lowpass(x, fs):
    """Zero-phase Butterworth (2nd order run forward and backward = 4th order, no time shift)."""
    x = x.copy()
    if len(x) < 16:
        return x
    for joints, fc in ((ARM_JOINTS, FC_ARMS), ([j for j in range(17) if j not in ARM_JOINTS], FC_BODY)):
        b, a = butter(2, min(fc / (fs / 2), 0.95))
        x[:, joints] = filtfilt(b, a, x[:, joints], axis=0, padlen=min(15, len(x) - 1))
    return x


def angle(a, b, c):
    v1, v2 = a - b, c - b
    cos = (v1 * v2).sum(-1) / (np.linalg.norm(v1, axis=-1) * np.linalg.norm(v2, axis=-1) + 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def smooth(x, k=3):
    if len(x) < k:
        return x
    return np.convolve(np.pad(x, k // 2, mode="edge"), np.ones(k) / k, mode="valid")


def find_releases(k2, p3, fps):
    """Return list of (frame_idx_in_track, hand). A shot = the wrist travels from around
    shoulder level to well above the head while the elbow extends."""
    T = len(k2)
    torso = np.median(np.linalg.norm(k2[:, 8] - k2[:, 0], axis=-1)) + 1e-6
    cands = []
    w = max(2, int(round(0.8 * fps)))
    for hand, (s, e, wr) in ARMS.items():
        rise = smooth((k2[:, s, 1] - k2[:, wr, 1]) / torso)       # wrist above shoulder, in torso lengths
        above_head = k2[:, wr, 1] < k2[:, 9, 1]                  # wrist above the nose
        elb = smooth(angle(p3[:, s], p3[:, e], p3[:, wr]))
        for t in range(2, T - 2):
            if np.isnan(elb[t]) or rise[t] < 0.35 or not above_head[t] or np.nanmax(elb[max(0, t - 4):t + 1]) < 125:
                continue
            if rise[t] < rise[max(0, t - 3):t + 4].max() - 1e-9:   # local max of wrist height
                continue
            lo = max(0, t - w)
            if t - lo < int(0.3 * fps) or rise[t] - rise[lo:t].min() < 0.8:  # must have come up from waist/chest level
                continue
            if np.nanmin(elb[lo:t]) > 120:                               # elbow must have been bent (the set point)
                continue
            # release = first frame on the way up where the elbow is ~extended and wrist is above head
            lo2 = lo + int(np.nanargmin(elb[lo:t + 1]))                 # set point = most-bent elbow
            seg = np.where((elb[lo2:t + 1] >= 135) & (rise[lo2:t + 1] > 0.2))[0]
            rel = lo2 + seg[0] if len(seg) else t
            cands.append((rel, hand, rise[t]))
    cands.sort()
    out = []
    for rel, hand, score in cands:                                  # non-max suppression, 0.6 s
        if out and rel - out[-1][0] < 0.6 * fps:
            if score > out[-1][2]:
                out[-1] = (rel, hand, score)
            continue
        out.append((rel, hand, score))
    return [(r, h) for r, h, _ in out]


def similarity(prev, cur, mask):
    pts = cv2.goodFeaturesToTrack(prev, 400, 0.01, 8, mask=mask)
    if pts is None or len(pts) < 12:
        return None, 0.0
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
    good = st.ravel() == 1
    if good.sum() < 12:
        return None, 0.0
    M, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None:
        return None, 0.0
    return M, float(inl.mean())


def peak(x, lo, hi):
    """Sub-frame location of the maximum of x within [lo, hi) (parabolic refinement)."""
    j = lo + int(np.argmax(x[lo:hi]))
    if 0 < j < len(x) - 1:
        a, b, c = x[j - 1], x[j], x[j + 1]; den = a - 2 * b + c
        if abs(den) > 1e-9:
            return j + float(np.clip(0.5 * (a - c) / den, -1, 1))
    return float(j)



# ===================================================================== quality score and camera view


def clip01(x):
    return float(np.clip(x, 0.0, 1.0))


def view_of(p):
    """Camera coords: x right, y down, z away. Returns yaw (0 square-on .. 90 side-on) and facing."""
    w = slice(8, Q_REL + 1)                                   # set-up through release
    lat = (p[w, 4] - p[w, 1]) + (p[w, 11] - p[w, 14])       # right->left across hips and shoulders
    lat = np.median(lat, axis=0)
    yaw = float(np.degrees(np.arctan2(abs(lat[2]), abs(lat[0]) + 1e-9)))
    # facing: nose in front of (closer to camera than) the thorax -> facing the camera
    toward = float(np.median(p[w, 8, 2] - p[w, 9, 2]))
    if yaw >= 60:
        view = "side"
    elif yaw >= 30:
        view = "oblique"
    else:
        view = "front" if toward > 0 else "back"
    return yaw, view


def base_quality(p, k2, hpx, conf):
    # 1. 3D bone-length stability over the shot (a rigid bone that changes length = depth error)
    L = {n: np.linalg.norm(p[:, a] - p[:, b], axis=-1) for n, (a, b) in QBONES.items()}
    cv = np.array([L[n].std() / (L[n].mean() + 1e-9) for n in QBONES])
    q_bone = 1 - clip01(np.median(cv) / 0.12)
    # 2. left/right symmetry of bone lengths
    sym = np.array([abs(L[a].mean() - L[b].mean()) / (0.5 * (L[a].mean() + L[b].mean()) + 1e-9) for a, b in QPAIRS])
    q_sym = 1 - clip01(sym.mean() / 0.15)
    # 3. does the 3D pose, viewed from the camera, match the detected 2D keypoints?
    res = []
    for t in range(0, len(p), 3):
        A = p[t, :, :2] - p[t, :, :2].mean(0)
        B = k2[t] - k2[t].mean(0)
        s = (A * B).sum() / ((A * A).sum() + 1e-9)          # best scale
        res.append(np.linalg.norm(A * s - B, axis=-1).mean() / max(hpx, 1))
    reproj = float(np.median(res))
    q_reproj = 1 - clip01(reproj / 0.06)
    # 4. smoothness of trunk + legs in 3D (arms move fast on purpose)
    body = [1, 2, 3, 4, 5, 6, 7, 8]
    acc = np.linalg.norm(np.diff(p[:, body], n=2, axis=0), axis=-1)
    q_smooth = 1 - clip01(np.median(acc) / 0.012)
    # 5. how many pixels / how confident the 2D detector was
    q_res = clip01((hpx - 120) / 260.0)
    q_conf = clip01((conf - 0.45) / 0.35)
    parts = dict(q_bone=q_bone, q_sym=q_sym, q_reproj=q_reproj, q_smooth=q_smooth, q_res=q_res, q_conf=q_conf)
    w = dict(q_bone=0.25, q_sym=0.15, q_reproj=0.15, q_smooth=0.15, q_res=0.15, q_conf=0.15)
    acc_score = 100 * sum(w[k] * parts[k] for k in w)
    return acc_score, parts, float(np.median(cv)), float(sym.mean()), reproj



# ===================================================================== fingertips / toes


def resample(x, t_src, t_dst):
    flat = x.reshape(len(x), -1)
    out = np.stack([np.interp(t_dst, t_src, flat[:, i]) for i in range(flat.shape[1])], 1)
    return out.reshape((len(t_dst),) + x.shape[1:])


def smooth_ext(e, fs):
    """Zero-phase Butterworth for the 12 extremity points (9 Hz fingers, 6 Hz feet)."""
    from scipy.signal import butter, filtfilt
    if len(e) < 16:
        return e
    e = e.copy()
    for sl, fc in ((slice(0, 6), 9.0), (slice(6, 12), 6.0)):
        b, a = butter(2, min(fc / (fs / 2), 0.95)); e[:, sl] = filtfilt(b, a, e[:, sl], axis=0, padlen=15)
    return e


def extremities_2d(img, k17, wb, hm):
    """12 fingertip/knuckle/toe/heel points for one frame, sides matched to the body pose."""
    x0, y0 = k17.min(0); x1, y1 = k17.max(0); h = max(y1 - y0, 20.0)
    kk, ss = wb(img, bboxes=np.array([[x0 - .18 * h, y0 - .22 * h, x1 + .18 * h, y1 + .12 * h]], np.float32)); kk, ss = kk[0], ss[0]
    hb = []
    for sl in (slice(91, 112), slice(112, 133)):
        hp = kk[sl]; c = hp.mean(0); r = max((hp.max(0) - hp.min(0)).max() * 0.9, 0.09 * h); hb.append([c[0] - r, c[1] - r, c[0] + r, c[1] + r])
    hk, hs = hm(img, bboxes=np.array(hb, np.float32))
    hsw = np.linalg.norm(kk[9] - k17[13]) + np.linalg.norm(kk[10] - k17[16]) > np.linalg.norm(kk[9] - k17[16]) + np.linalg.norm(kk[10] - k17[13])
    fsw = np.linalg.norm(kk[15] - k17[6]) + np.linalg.norm(kk[16] - k17[3]) > np.linalg.norm(kk[15] - k17[3]) + np.linalg.norm(kk[16] - k17[6])
    out = np.zeros((12, 2)); cf = np.zeros(12)
    for side in (0, 1):
        src = side ^ int(hsw)
        for n, hi in enumerate(HAND_IDX.values()):
            k = n * 2 + side
            if hs[src, hi] >= 0.3:
                out[k], cf[k] = hk[src, hi], min(float(hs[src, hi]), 1.0)
            else:
                wi = (91 if src == 0 else 112) + hi; out[k], cf[k] = kk[wi], min(float(ss[wi]) / WB_SCORE_FULL, 1.0) * 0.7
        src = side ^ int(fsw)
        for n, (li, ri) in enumerate(FOOT_IDX.values()):
            k = 6 + n * 2 + side; wi = li if src == 0 else ri; out[k], cf[k] = kk[wi], min(float(ss[wi]) / WB_SCORE_FULL, 1.0)
    return out, cf


def extremities_3d(e2, k2, p3):
    out = np.full((len(e2), 12, 3), np.nan)
    for t in range(len(e2)):
        A = p3[t, :, :2] - p3[t, :, :2].mean(0); B = k2[t] - k2[t].mean(0)
        ppu = (A * B).sum() / ((A * A).sum() + 1e-9)
        if ppu <= 1e-6:
            continue
        fz = np.sign(np.cross(p3[t, 4] - p3[t, 1], [0.0, -1.0, 0.0])[2])
        for k, nm in enumerate(EXT_NAMES):
            side, part = nm[0], nm[2:]
            if k < 6:
                J, E = (13, 12) if side == "l" else (16, 15); sgn = np.sign(p3[t, J, 2] - p3[t, E, 2])
            else:
                J = 6 if side == "l" else 3; sgn = -fz if part == "heel" else fz
            off = (e2[t, k] - k2[t, J]) / ppu
            out[t, k] = [p3[t, J, 0] + off[0], p3[t, J, 1] + off[1], p3[t, J, 2] + sgn * np.sqrt(max(LEN[part] ** 2 - float(off @ off), 0.0))]
    return out



# ===================================================================== overlay clip


def _draw3d(p, size, label, extra=None):
    img = np.full((size, size, 3), 250, np.uint8)
    a = np.radians(55)                               # rotate about the vertical axis so depth is visible
    x = p[:, 0] * np.cos(a) + p[:, 2] * np.sin(a)
    pts = np.stack([size / 2 + x * size * 0.62, size * 0.52 + p[:, 1] * size * 0.62], 1).astype(int)
    for (i, j), s in zip(BONES, SIDE):
        cv2.line(img, tuple(pts[i]), tuple(pts[j]), COL[s], 3, cv2.LINE_AA)
    for q in pts:
        cv2.circle(img, tuple(q), 3, (40, 40, 40), -1, cv2.LINE_AA)
    if extra is not None:                            # fingertips / toes (depth is estimated)
        for q3, col in zip(extra, EXTRA_COL):
            if np.isnan(q3).any(): continue
            xx = q3[0] * np.cos(a) + q3[2] * np.sin(a)
            cv2.circle(img, (int(size / 2 + xx * size * 0.62), int(size * 0.52 + q3[1] * size * 0.62)), 4, col, -1, cv2.LINE_AA)
    cv2.putText(img, label, (10, 24), 0, 0.6, (60, 60, 60), 2, cv2.LINE_AA)
    return img


def render_span(video, fps, f0, f1, frames, k2, p3, e2, e3, t_win, rel_frame, dst, label, banner=""):
    """Overlay clip from video frame f0 to f1: 2D skeleton on the video + 3D skeleton, wherever the shooter was tracked."""
    cap = cv2.VideoCapture(video); cap.set(cv2.CAP_PROP_POS_FRAMES, f0); P = 480; vw = None
    def lerp(arr, src, x):
        if x < src[0] or x > src[-1]: return None
        j = int(np.clip(np.searchsorted(src, x) - 1, 0, len(src) - 2)); a = (x - src[j]) / max(src[j + 1] - src[j], 1e-9)
        return arr[j] * (1 - a) + arr[j + 1] * a
    for fi in range(f0, f1 + 1):
        ok, img = cap.read()
        if not ok: break
        H, W = img.shape[:2]; lw = int(round(W * P / H / 2) * 2); sc = P / H
        if vw is None:
            vw = cv2.VideoWriter(dst, cv2.VideoWriter_fourcc(*"avc1"), fps, (lw + P, P))
        img = cv2.resize(img, (lw, P)); k = lerp(k2, frames, fi); p = lerp(p3, frames, fi)
        ee2 = lerp(e2, t_win, fi) if e2 is not None else None; ee3 = lerp(e3, t_win, fi) if e3 is not None else None
        if k is not None:
            for (a, b), s_ in zip(BONES, SIDE):
                cv2.line(img, tuple((k[a] * sc).astype(int)), tuple((k[b] * sc).astype(int)), COL[s_], 2, cv2.LINE_AA)
            if ee2 is not None:
                for q, col in zip(ee2 * sc, EXTRA_COL):
                    cv2.circle(img, tuple(q.astype(int)), 4, col, -1, cv2.LINE_AA)
        cv2.putText(img, f"{(fi - rel_frame) / fps:+.2f}s", (10, P - 12), 0, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        if banner: cv2.putText(img, banner, (10, 56), 0, 0.6, (0, 200, 255), 2, cv2.LINE_AA)
        if abs(fi - rel_frame) <= 0.5: cv2.putText(img, "RELEASE", (10, 30), 0, 0.9, (0, 255, 255), 2, cv2.LINE_AA)
        side = _draw3d(p, P, label, ee3) if p is not None else np.full((P, P, 3), 250, np.uint8)
        vw.write(np.hstack([img, side]))
    if vw is not None: vw.release()
    cap.release()



# ===================================================================== the 34 measures


def ang(a, b, c):
    v1, v2 = a - b, c - b
    return np.degrees(np.arccos(np.clip((v1 * v2).sum(-1) / (np.linalg.norm(v1, axis=-1) * np.linalg.norm(v2, axis=-1) + 1e-9), -1, 1)))


def at(x, t):
    t = float(np.clip(t, 0, len(x) - 1)); a = int(np.floor(t)); b = min(a + 1, len(x) - 1); return x[a] * (1 - (t - a)) + x[b] * (t - a)


def metrics(p, rel, hand, rise, v0=0, v1=45, ext=None):
    """p (46,17,3) unit body height; rel = release index (30 fps); rise (46,) pelvis vertical travel."""
    s, e, w = (14, 15, 16) if hand == "R" else (11, 12, 13); gw = 13 if hand == "R" else 16
    r = int(round(rel)); lo = max(v0, r - 27); hi = min(v1, 45)
    if r - lo < 12 or r > hi:
        return None
    elbow = ang(p[:, s], p[:, e], p[:, w]); knee = 0.5 * (ang(p[:, 1], p[:, 2], p[:, 3]) + ang(p[:, 4], p[:, 5], p[:, 6]))
    hip = 0.5 * (ang(p[:, 8], p[:, 1], p[:, 2]) + ang(p[:, 8], p[:, 4], p[:, 5])); up = p[:, 8] - p[:, 0]
    shoulder = ang(p[:, e], p[:, s], p[:, s] - up)
    lean = np.degrees(np.arccos(np.clip(-up[:, 1] / (np.linalg.norm(up, axis=-1) + 1e-9), -1, 1)))
    wrist_rel = (p[:, s, 1] - p[:, w, 1]) * 100                       # wrist above shoulder, % height (y is down)
    pre = slice(lo, r + 1); td = lo + int(np.argmin(wrist_rel[pre])); tk = lo + int(np.argmin(knee[pre]))
    ts = td + int(np.argmin(elbow[td:r + 1]))
    m = dict(dip_depth=-wrist_rel[td], dip_time=(rel - td) / 30, knee_min=knee[tk], knee_time=(rel - tk) / 30, hip_min=hip[pre].min(),
             elbow_set=elbow[ts], elbow_rel=at(elbow, rel), elbow_speed=np.gradient(elbow)[ts:min(r + 3, hi) + 1].max() * 30,
             shoulder_rel=at(shoulder, rel), release_height=at((p[:, 10, 1] - p[:, w, 1]) * 100, rel), trunk_lean=at(lean, rel),
             stance=np.linalg.norm(p[tk, 3] - p[tk, 6]) * 100, guide_gap=at(np.linalg.norm(p[:, w] - p[:, gw], axis=-1) * 100, rel))
    # ---- added measures
    U = np.array([0.0, -1.0, 0.0]); H = lambda v: v * np.array([1.0, 0.0, 1.0])
    lat = H((p[:, 4] - p[:, 1]) + (p[:, 11] - p[:, 14])); l0 = np.median(lat[pre], 0); l0 /= np.linalg.norm(l0) + 1e-9; f0 = np.cross(l0, U)
    sgn = -1.0 if hand == "R" else 1.0; ank_s, ank_o = (3, 6) if hand == "R" else (6, 3)
    dk, de, dsh = np.gradient(knee), np.gradient(elbow), np.gradient(shoulder)
    tke = tk + int(np.argmax(dk[tk:r + 1])); tee = ts + int(np.argmax(de[ts:min(r + 3, hi) + 1]))
    lean_f = np.degrees(np.arctan2(up @ f0, -up[:, 1]))
    yawv = lambda v: np.degrees(np.arctan2(v[..., 2], v[..., 0]))
    wrap = lambda a: (a + 180) % 360 - 180
    twist = wrap(yawv(p[:, 11] - p[:, 14]) - yawv(p[:, 4] - p[:, 1])); hipyaw = yawv(p[:, 4] - p[:, 1])
    ua = p[ts, e] - p[ts, s]; fa = p[:, w] - p[:, e]
    vw = np.gradient(-p[:, w, 1]); vmax = vw[td:r + 1].max()
    post = min(r + 9, hi)
    m.update(set_time=(rel - ts) / 30, set_height=(p[ts, 10, 1] - p[ts, w, 1]) * 100, set_forward=float((p[ts, w] - p[ts, 10]) @ f0) * 100,
             shoulder_set=shoulder[ts], shoulder_speed=dsh[td:r + 1].max() * 30,
             elbow_flare=float(np.degrees(np.arctan2(sgn * (ua @ l0), ua @ f0))),
             forearm_vert=at(np.degrees(np.arccos(np.clip(-fa[:, 1] / (np.linalg.norm(fa, axis=-1) + 1e-9), -1, 1))), rel),
             knee_rel=at(knee, rel), hip_rel=at(hip, rel), knee_speed=dk[tk:r + 1].max() * 30, chain_lag=(tee - tke) / 30,
             knee_asym=abs(ang(p[tk, 1], p[tk, 2], p[tk, 3]) - ang(p[tk, 4], p[tk, 5], p[tk, 6])),
             stagger=float((p[tk, ank_s] - p[tk, ank_o]) @ f0) * 100, lean_load=lean_f[tk], lean_rel=at(lean_f, rel), lean_change=at(lean_f, rel) - lean_f[tk],
             twist_rel=at(twist, rel), body_turn=abs(wrap(hipyaw[min(r + 4, hi)] - hipyaw[tk])),
             head_sway=np.linalg.norm(H(p[lo:r + 1, 10] - p[lo, 10]), axis=-1).max() * 100,
             one_motion=float(vw[max(ts - 2, td):min(ts + 3, r) + 1].min() / vmax) if vmax > 1e-6 else np.nan,
             wrist_path=np.linalg.norm(np.diff(p[td:r + 1, w], axis=0), axis=-1).sum() * 100, guide_set=np.linalg.norm(p[ts, w] - p[ts, gw]) * 100,
             follow_elbow=elbow[r:min(r + 8, hi) + 1].max(), follow_hold=((p[r, w, 1] - p[post, w, 1]) * 100) if post - r >= 6 else np.nan)
    if ext is not None and not np.isnan(ext[lo:hi + 1]).any():
        tip = ext[:, 1 if hand == "R" else 0]; wf = ang(p[:, e], p[:, w], tip)
        toe, heel = ext[tk, 7 if hand == "R" else 6], ext[tk, 11 if hand == "R" else 10]; ft = H(toe - heel)
        m.update(wrist_flex_rel=at(wf, rel), wrist_snap=at(wf, rel) - at(wf, min(rel + 4, hi)),
                 toe_out=float(np.degrees(np.arctan2(sgn * (ft @ l0), ft @ f0))))
    if rise is not None and not np.isnan(rise[lo:hi + 1]).any():
        m["rise_time"] = (rel - (lo + int(np.argmin(rise[lo:r + 1])))) / 30
        tp = lo + int(np.argmax(rise[lo:hi + 1])); m.update(rise_at_rel=at(rise, rel) * 100, rise_peak=rise[tp] * 100, rel_vs_peak=(tp - rel) / 30)
    return m


def shot_window(d):
    """(pose 46x17x3, release index, pelvis rise, valid_from, valid_to, extremities) for the measures, from a lift_video.py pose file.
    Pose files hold 1.0 s before .. 0.5 s after the release (46 samples). Longer ones are cut down to that part."""
    p = d["pose3d"].astype(float); r = float(d["release_idx"]); v0, v1 = int(d["valid_from"]), int(d["valid_to"])
    if len(p) == 46:                                                       # older pose files
        return p, r, d["pelvis_rise"].astype(float), v0, v1, d["extremities3d"].astype(float)
    a = int(round(r)) - 30; sl = slice(a, a + 46)
    return p[sl], r - a, d["pelvis_rise"].astype(float)[sl], max(v0 - a, 0), min(v1 - a, 45), d["extremities3d"].astype(float)[sl]



# ===================================================================== models (loaded in background threads)
_M = {}


def _load(key):
    from rtmlib import BodyWithFeet, Wholebody, Hand, YOLOX, RTMPose
    import onnxruntime as ort
    cache = os.path.expanduser("~/.cache/rtmlib/coreml"); os.makedirs(cache, exist_ok=True)
    coreml = [("CoreMLExecutionProvider", {"ModelCacheDirectory": cache}), "CPUExecutionProvider"]       # compiled model cached on disk

    def pose_model(cfg, size):
        m = RTMPose(cfg["pose"], model_input_size=size, backend="onnxruntime", device="cpu")
        m.session = ort.InferenceSession(m.session._model_path, providers=coreml); return m
    if key == "2d":
        B = BodyWithFeet.MODE
        _M["det"] = YOLOX(B["lightweight"]["det"], model_input_size=B["lightweight"]["det_input_size"], backend="onnxruntime", device="cpu")
        _M["pose"] = pose_model(B["balanced"], (192, 256))
    elif key == "ext":
        W = Wholebody.MODE["performance"]; H = Hand.MODE["performance"] if "performance" in Hand.MODE else list(Hand.MODE.values())[0]
        _M["wb"] = pose_model(W, W["pose_input_size"]); _M["hand"] = pose_model(H, H["pose_input_size"])
    else:
        _M["lift"] = load_posemamba("L")


# ===================================================================== one pass over the video: decode, detect, 2D pose, track, camera motion
def track(video):
    cap = cv2.VideoCapture(video); fps = cap.get(cv2.CAP_PROP_FPS) or 30.0; step = max(1, int(round(fps / 30.0)))
    q = queue.Queue(maxsize=8)

    def reader():                                          # decoding runs in its own thread
        fi = -1
        while cap.grab():
            fi += 1
            if fi % step: continue
            ok, fr = cap.retrieve()
            if not ok: break
            sc = 640.0 / max(fr.shape[:2])
            q.put((fi, fr, cv2.cvtColor(cv2.resize(fr, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY), sc))
        q.put(None)
    threading.Thread(target=reader, daemon=True).start()
    mq = queue.Queue(maxsize=16); Mrel = []

    def motion():                                          # background optical flow runs in its own thread
        prevg = None
        while True:
            it = mq.get()
            if it is None: break
            g, boxes, cut, sc = it; Mx = None
            if prevg is not None and not cut:
                mask = np.full(g.shape, 255, np.uint8)
                for bb in boxes:
                    h = bb[3] - bb[1]; cv2.rectangle(mask, (int(bb[0] - .15 * h), int(bb[1] - .1 * h)), (int(bb[2] + .15 * h), int(bb[3] + .1 * h)), 0, -1)
                Mx, _ = similarity(prevg, g, mask)
            Mx = np.eye(2, 3) if Mx is None else Mx.copy(); Mx[:, 2] /= sc
            Mrel.append(Mx); prevg = g
    mt = threading.Thread(target=motion, daemon=True); mt.start()
    det, pose = _M["det"], _M["pose"]
    tracks, next_id, n = {}, 0, 0
    rec = {k: [] for k in ("track", "frame", "kpts", "conf")}
    pf, store, used = [], {}, 0
    prev_small = prev_hist = None; W = H = 0
    while True:
        item = q.get()
        if item is None: break
        fi, frame, g, sc = item; n += 1; H, W = frame.shape[:2]
        if used + frame.nbytes <= FRAME_BUDGET:
            store[fi] = frame; used += frame.nbytes
        # camera cut: thumbnail jump + colour-histogram decorrelation
        thumb = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA); small = cv2.cvtColor(thumb, cv2.COLOR_BGR2GRAY).astype(np.float32)
        hist = cv2.calcHist([cv2.cvtColor(thumb, cv2.COLOR_BGR2HSV)], [0, 1], None, [16, 8], [0, 180, 0, 256]); cv2.normalize(hist, hist)
        cut = False
        if prev_small is not None:
            diff = np.abs(small - prev_small).mean(); cut = (diff > 12 and cv2.compareHist(hist, prev_hist, cv2.HISTCMP_CORREL) < 0.3) or diff > 50
        prev_small, prev_hist = small, hist
        if cut: tracks.clear()
        # detection + association
        if cut or n % DET_EVERY == 1 or (not tracks and n % DET_EVERY_EMPTY == 1):
            b = det(frame)
            if len(b):
                b = b[(b[:, 3] - b[:, 1]) >= 0.12 * H]; b = b[np.argsort(-(b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1]))]
            taken = set()
            for tid, tr in list(tracks.items()):
                best, bj = 0.3, -1
                for j, bb in enumerate(b):
                    if j not in taken and iou(tr["bbox"], bb) > best: best, bj = iou(tr["bbox"], bb), j
                if bj >= 0: taken.add(bj); tr["bbox"] = b[bj].astype(np.float32)
            for j, bb in enumerate(b):
                if j in taken or len(tracks) >= 4 or any(iou(bb, t["bbox"]) > 0.5 for t in tracks.values()): continue
                tracks[next_id] = {"bbox": bb.astype(np.float32), "lost": 0}; next_id += 1
        # 2D pose on every active track
        if tracks:
            ids = list(tracks); k, c = pose(frame, bboxes=np.stack([tracks[i]["bbox"] for i in ids]))
            for i, tid in enumerate(ids):
                tr = tracks[tid]
                if c[i].mean() < LOST_CONF:
                    tr["lost"] += 1
                    if tr["lost"] >= LOST_PATIENCE: del tracks[tid]
                    continue
                tr["lost"] = 0; rec["track"].append(tid); rec["frame"].append(fi); rec["kpts"].append(k[i].astype(np.float32)); rec["conf"].append(c[i].astype(np.float32))
                nb = kpt_bbox(k[i], c[i], W, H)
                if nb is not None: tr["bbox"] = nb
            ids = sorted(tracks)
            for i, ta in enumerate(ids):
                for tb in ids[i + 1:]:
                    if ta in tracks and tb in tracks and iou(tracks[ta]["bbox"], tracks[tb]["bbox"]) > 0.6: del tracks[tb]
        mq.put((g, [tr["bbox"] * sc for tr in tracks.values()], cut, sc)); pf.append(fi)   # camera motion, people masked out
    mq.put(None); mt.join(); Ms = []
    for Mx in Mrel:                                        # this frame -> first frame coordinates
        Ms.append(np.eye(3) if not Ms else Ms[-1] @ np.linalg.inv(np.vstack([Mx, [0, 0, 1]])))
    N = len(rec["track"])
    return dict(track=np.array(rec["track"], np.int32), frame=np.array(rec["frame"], np.int32), kpts=np.array(rec["kpts"], np.float32).reshape(N, 26, 2),
                conf=np.array(rec["conf"], np.float32).reshape(N, 26), fps=fps, eff=fps / step, W=W, H=H, pf={f: i for i, f in enumerate(pf)}, C=np.array(Ms), store=store)


# ===================================================================== video -> pose file
def lift(video, out_dir, hand=None, clip=False):
    name = os.path.splitext(os.path.basename(video))[0]; os.makedirs(out_dir, exist_ok=True)
    th = {k: threading.Thread(target=_load, args=(k,)) for k in ("2d", "ext", "lift") if k not in _M and not (k == "2d" and "pose" in _M) and not (k == "ext" and "wb" in _M)}
    for t in th.values(): t.start()
    if "2d" in th: th["2d"].join()
    d = track(video); fps, eff = d["fps"], d["eff"]
    for k, t in th.items():
        if k != "2d": t.join()
    best = None; ids, cnt = np.unique(d["track"], return_counts=True)
    for tid in ids[cnt >= 30]:
        idx = np.where(d["track"] == tid)[0]
        k = fill_gaps(halpe2h36m(d["kpts"][idx]).astype(np.float64), halpe2h36m(d["conf"][idx][..., None])[..., 0])
        c = shot_candidates(k, eff); score = (len(c) > 0, float(np.median(k[:, :, 1].max(1) - k[:, :, 1].min(1))) * len(idx))
        if best is None or score > best[0]: best = (score, idx, k, c)
    if best is None:
        raise RuntimeError("no person was tracked for 1 s or more")
    _, idx, k2, cands = best
    cf = halpe2h36m(d["conf"][idx][..., None])[..., 0]; frames = d["frame"][idx]; tsec = frames / fps
    k2, cf, nsw = fix_swaps(k2, cf)
    C = d["C"][[d["pf"][int(f)] for f in frames]]; C = np.linalg.inv(C[0])[None] @ C
    ks = np.einsum("nij,nkj->nki", C[:, :2, :2], k2) + C[:, None, :2, 2]
    ph = np.concatenate([k2[:, 0], np.ones((len(k2), 1))], 1); speed = np.zeros(len(k2))
    for j in range(1, len(k2)):
        s_ = max(np.hypot(C[j, 0, 0], C[j, 1, 0]), 1e-6); hh = max(k2[j, :, 1].max() - k2[j, :, 1].min(), 10.0)
        speed[j] = np.linalg.norm(((C[j] - C[j - 1]) @ ph[j])[:2]) / s_ * eff / hh
    model = _M["lift"]

    def lift3(k):
        p = lift_track(model, normalize(k).astype(np.float32), True).astype(np.float64)
        return lowpass(p / max(np.median(skeleton_height(p)), 1e-6), eff)
    cap = [None]; lock = threading.Lock(); done = {}

    def image(j):
        fi = int(frames[j])
        if fi in d["store"]: return d["store"][fi]
        with lock:
            if cap[0] is None: cap[0] = cv2.VideoCapture(video)
            cap[0].set(cv2.CAP_PROP_POS_FRAMES, fi); ok, img = cap[0].read()
        return img if ok else np.zeros((d["H"], d["W"], 3), np.uint8)

    def ext(j):
        if int(j) not in done: done[int(j)] = extremities_2d(image(j), k2[j], _M["wb"], _M["hand"])

    def ext_plan(j0):                                      # fingertips / toes: every frame where the release is searched, every 2nd frame before that
        sel = np.where((tsec >= tsec[j0] - PRE - 0.1) & (tsec <= tsec[j0] + POST + 0.1))[0]; dense = tsec[sel] >= tsec[j0] - 0.3
        return sel, [n for n in range(len(sel)) if dense[n] or n % 2 == 0 or n == len(sel) - 1]

    def cam_speed(j0):
        near = (tsec >= tsec[j0] - 1.0) & (tsec <= tsec[j0] + 0.2); return float(speed[near].max()) if near.any() else 0.0
    # a first guess of the release from 2D alone, so the fingertip model can run while the lifter runs
    g0 = min(cands, key=lambda c: min(k2[c, 16, 1], k2[c, 13, 1])) if cands else int(np.argmin(np.minimum(k2[:, 16, 1], k2[:, 13, 1])))
    sel, run = ext_plan(g0); pool = ThreadPoolExecutor(EXT_THREADS); early = [pool.submit(ext, sel[n]) for n in run]
    comp = cam_speed(g0) >= 0.25; p3 = lift3(ks if comp else k2); rels = find_releases(k2, p3, eff)
    if rels:
        r0, h0 = rels[int(np.argmin([k2[r, 16 if h_ == "R" else 13, 1] for r, h_ in rels]))]
    else:
        r0, h0 = g0, ("R" if k2[g0, 16, 1] <= k2[g0, 13, 1] else "L")
    hand = hand or h0; pk = cam_speed(r0)
    camera = "moving" if pk >= 0.8 else ("slight" if pk >= 0.25 else "static")
    if (camera != "static") != comp:
        comp = not comp; p3 = lift3(ks if comp else k2)
    k2s = lowpass(k2, eff)
    for f_ in early: f_.result()
    t0, t1 = tsec[r0] - PRE, tsec[r0] + POST; tt = np.linspace(t0, t1, NT)
    sel, run = ext_plan(r0); list(pool.map(ext, [sel[n] for n in run]))
    e2 = np.stack([done[int(sel[n])][0] for n in run]); ec = np.stack([done[int(sel[n])][1] for n in run])
    if len(run) < len(sel): e2, ec = resample(e2, tsec[sel][run], tsec[sel]), resample(ec, tsec[sel][run], tsec[sel])
    K = resample(k2s, tsec, tt); E2 = resample(smooth_ext(e2, eff), tsec[sel], tt); EC = resample(ec, tsec[sel], tt)
    v1 = int(np.floor(min(45.0, (tsec[-1] - t0) * 30))); w = 16 if hand == "R" else 13; tipk = 1 if hand == "R" else 0
    hgt = float(np.median(K[:, :, 1].max(1) - K[:, :, 1].min(1)))
    # release: fingertip peak, cross-checked with the wrist reaching 95% of its rise
    wy = -K[:, w, 1] / hgt; wr = wy - wy[15:24].min(); thr = 0.95 * wr[22:v1 + 1].max(); t_w = float(22 + np.argmax(wr[22:v1 + 1]))
    for j in range(22, v1 + 1):
        if wr[j] >= thr > wr[j - 1]: t_w = j - 1 + (thr - wr[j - 1]) / max(wr[j] - wr[j - 1], 1e-9); break
    t_w += OFF_WRIST95
    if float(np.median(EC[24:38, tipk])) >= 0.2:
        rel = peak(-E2[:, tipk, 1], 24, max(v1 + 1, 28)) + OFF_TIP; spread = abs(rel - t_w); rconf = 0.9 if spread <= 1.5 else (0.7 if spread <= 3 else 0.4)
    else:
        rel, rconf = t_w, 0.6
    rel = float(np.clip(rel, 20, 44)); rel_frame = float(frames[r0] + (rel - 30) / 30.0 * fps); t_rel = rel_frame / fps
    # the saved pose: 1.0 s before the release .. 0.5 s after, release exactly at index 30
    t4 = t_rel + (np.arange(NT) - 30) / 30.0; inside = (t4 >= tsec[0] - 1e-6) & (t4 <= tsec[-1] + 1e-6)
    w0 = int(np.argmax(inside)); w1 = int(NT - 1 - np.argmax(inside[::-1]))
    extra = [j for j in np.where((tsec >= t4[0] - 0.05) & (tsec <= t4[-1] + 0.05))[0] if int(j) not in set(int(x) for x in sel)][::2]
    list(pool.map(ext, extra)); pool.shutdown()
    pos = {int(j): n for n, j in enumerate(sel)}; je = np.array(sorted(set(int(x) for x in sel) | set(int(x) for x in extra)))
    ea = np.stack([e2[pos[j]] if j in pos else done[j][0] for j in je]); ca = np.stack([ec[pos[j]] if j in pos else done[j][1] for j in je])

    def span(x, src):
        y = resample(x, src, t4).astype(np.float32); y[~inside] = np.nan; return y
    P4, K4, KS4 = span(p3, tsec), span(k2s, tsec), span(lowpass(ks, eff), tsec)
    E24, EC4 = span(smooth_ext(ea, eff), tsec[je]), span(ca, tsec[je]); E34 = extremities_3d(E24.astype(float), K4.astype(float), P4.astype(float)).astype(np.float32)
    rise = -KS4[:, 0, 1] / hgt; rise = rise - np.nanmedian(rise[w0:w0 + 12])
    acc = base_quality(P4[w0:w1 + 1].astype(float), K4[w0:w1 + 1].astype(float), hgt, float(cf.mean()))[0]
    Pv = P4.astype(float).copy(); Pv[~inside] = P4[w0] if w0 > 0 else P4[w1]; yaw, view = view_of(Pv)
    npz = os.path.join(out_dir, name + ".npz")
    np.savez_compressed(npz, video=os.path.abspath(video), pose3d=P4, kpts2d=K4, joint_names=np.array(H36M_NAMES), extremities3d=E34, extremities2d=E24, extremity_conf=EC4,
                        extremity_names=np.array(EXT_NAMES), pelvis_rise=rise.astype(np.float32), t_seconds=((np.arange(NT) - 30) / 30.0).astype(np.float32), pose_fps=30,
                        release_idx=30, release_time_s=0.0, release_video_frame=rel_frame, release_s=t_rel, release_conf=rconf, clip_start_s=float(t4[0]), clip_end_s=float(t4[-1]),
                        valid_from=w0, valid_to=w1, hand=hand, accuracy=acc, view=view, yaw_deg=yaw, camera=camera, camera_speed=pk, cam_compensated=comp, swap_frames=nsw,
                        fps=fps, height_px=hgt, shot_candidates=len(rels))
    if clip:
        render_span(video, fps, max(0, int(round(t4[0] * fps))), int(round(t4[-1] * fps)), frames.astype(float), k2s, p3, E24[w0:w1 + 1], E34[w0:w1 + 1], t4[w0:w1 + 1] * fps, rel_frame,
                    os.path.join(out_dir, name + ".mp4"), f"{name}  acc {acc:.0f}  {view}", "" if camera == "static" else f"camera {camera} (corrected)")
    return npz, (f"{name}: hand {hand}, release at {t_rel:.2f} s into the video (confidence {rconf}), pose accuracy {acc:.0f}/100, view {view} ({yaw:.0f} deg), "
                 f"camera {camera}{' (corrected)' if comp else ''}, {nsw} swapped frames fixed, shooter {hgt:.0f} px tall, {len(rels)} shot(s) found")


# ===================================================================== skeleton rig for the .glb file
RIG_SEGMENTS = ["pelvis", "torso", "head", "l_uarm", "r_uarm", "l_larm", "r_larm", "l_hand", "r_hand", "l_thigh", "r_thigh", "l_shank", "r_shank", "l_foot", "r_foot"]
# where the bones of the skeleton model join, in the model's own units (metres): hip and shoulder sockets, top of the sacrum, neck, sole of the foot
RIG = dict(hipX=0.085, shX=0.17, shY=0.0, shZ=-0.04, sacrum=0.07, neck=0.147, sole=0.075, torso=0.361, head=0.102, uarm=0.313, larm=0.254, thigh=0.438, shank=0.488)


def rig_skeleton(pose, ext, rise, hand, height):
    """Joint positions -> one position + rotation per bone and frame, for a skeleton `height` metres tall. World: x right, y forward, z up, floor at z = 0.

    Every bone keeps one length and thickness for the whole clip and the joints are chained from the pelvis outwards, so a bone can only swing,
    never stretch or spin about its own length. The whole body gets one fixed turn: upright (over the last frames on the ground the weight between
    hips and chest sits above the feet, which removes the camera's tilt) and square (at lift-off, the fastest rise of the hips before the release,
    the shoulder line faces the shot head on). Feet stay planted until lift-off; after it the measured rise of the hips drives the jump.
    Palms face each other; the guide hand runs straight on from its forearm and the shooting hand bends at the wrist with the measured flick."""
    P, E, rise = np.asarray(pose, float), np.asarray(ext, float), np.nan_to_num(np.asarray(rise, float))
    ok = ~np.isnan(P).any((1, 2)); v0 = int(np.argmax(ok)); v1 = int(len(ok) - 1 - np.argmax(ok[::-1])); eok = ~np.isnan(E).any((1, 2))
    out = _rig_solve(P, E, eok, rise, hand, 1.8, v0, v1)
    return _rig_solve(P, E, eok, rise, hand, 1.8 * height / out["stand"], v0, v1)


def _rig_solve(P, E, eok, rise, hand, H, v0, v1):
    from scipy.spatial.transform import Rotation
    T, Z = RIG, np.array([0.0, 0.0, 1.0]); fr = range(v0, v1 + 1)
    nrm = lambda v: v / max(float(np.linalg.norm(v)), 1e-12)
    cv = lambda q: np.array([-q[0], -q[2], -q[1]])                        # stored pose (x to the shooter's left, y down, z behind) -> x right, y forward, z up
    quat = lambda x, y, z: Rotation.from_matrix(np.column_stack([x, y, z])).as_quat()

    def perp(h, z, alt):
        x = h - z * (h @ z)
        if x @ x < 1e-4: x = alt - z * (alt @ z)
        return nrm(x)

    def bone(down, hint, alt):
        z = -down; x = perp(hint, z, alt); y = np.cross(z, x); return x, y, z, quat(x, y, z)
    # ---- one fixed turn of the whole body
    lift, best = max(v0, min(30, v1)), -1e9
    for i in range(max(v0 + 1, 12), min(30, v1 - 1) + 1):
        if rise[i + 1] - rise[i - 1] > best: best, lift = rise[i + 1] - rise[i - 1], i
    bal = nrm(sum(0.6 * cv(P[i, 0]) + 0.4 * cv(P[i, 8]) - 0.5 * cv(P[i, 3]) - 0.5 * cv(P[i, 6]) for i in range(max(v0, lift - 6), lift + 1)))
    ax = np.cross(bal, Z); R0 = Rotation.from_rotvec(nrm(ax) * np.arctan2(np.linalg.norm(ax), bal @ Z)).as_matrix() if np.linalg.norm(ax) > 1e-9 else np.eye(3)
    sh = R0 @ cv(P[lift, 14] - P[lift, 11]); R0 = Rotation.from_rotvec(Z * -np.arctan2(sh[1], sh[0])).as_matrix() @ R0

    def W(q, i):
        v = R0 @ cv(q) * H; v[2] += rise[i] * H; return v
    J_all = {i: np.array([W(q, i) for q in P[i]]) for i in fr}
    med = lambda a, b: float(np.median([np.linalg.norm(J_all[i][a] - J_all[i][b]) for i in fr]))
    Lth, Lsh, Lua, Lfa, Ltr = (med(1, 2) + med(4, 5)) / 2, (med(2, 3) + med(5, 6)) / 2, (med(14, 15) + med(11, 12)) / 2, (med(15, 16) + med(12, 13)) / 2, med(0, 8)
    g = (Lth + Lsh) / (T["thigh"] + T["shank"]); st = float(np.clip((Ltr - T["sacrum"] * g) / T["torso"], 0.92 * g, 1.2 * g)); k = lambda a, b: float(np.clip(a / b / g, 0.85, 1.2)) * g
    scale = dict(pelvis=[g, g, g], torso=[st, st, st], head=[g, g, g], uarm=[g, g, k(Lua, T["uarm"])], larm=[g, g, k(Lfa, T["larm"])], hand=[g, g, g],
                 thigh=[g, g, Lth / T["thigh"]], shank=[g, g, Lsh / T["shank"]], foot=[g, g, g])
    LEN = dict(uarm=T["uarm"] * scale["uarm"][2], larm=T["larm"] * scale["larm"][2], thigh=Lth, shank=Lsh)
    # ---- wrist flick of the shooting hand: how far the fingertip is bent forward-and-down from the forearm line (+) or cocked back (-), smoothed
    s_sh, tip, el, wr = ("l", 0, 12, 13) if hand == "L" else ("r", 1, 15, 16); flick, last = {}, 0.0
    for i in fr:
        if eok[i]:
            J = J_all[i]; f = nrm(J[wr] - J[el]); dd = nrm(W(E[i, tip], i) - J[wr]); fw = nrm(np.cross(nrm(J[8] - J[0]), nrm(J[1] - J[4])))
            nn = perp(fw + np.array([0, 0, -0.5]), f, -Z); last = float(np.clip(np.arctan2(dd @ nn, dd @ f), -1.3, 1.3))
        flick[i] = last
    sm = {i: sum(flick[j] * (3 - abs(j - i)) for j in range(i - 2, i + 3) if v0 <= j <= v1) / sum(3 - abs(j - i) for j in range(i - 2, i + 3) if v0 <= j <= v1) for i in fr}

    def set_leg(F, s):
        q = F["_leg"][s]; tx_, ty_, _, tq_ = bone(nrm(q["K"] - q["P"]), F["_px"], F["_py"]); _, cy_, _, cq_ = bone(nrm(q["A"] - q["K"]), tx_, ty_)
        fy = np.array([cy_[0], cy_[1], 0.0])
        if fy @ fy < 1e-4: fy = np.array([F["_py"][0], F["_py"][1], 0.0])
        fy = nrm(fy); F[s + "_thigh"] = [q["P"].copy(), tq_]; F[s + "_shank"] = [q["K"].copy(), cq_]; F[s + "_foot"] = [q["A"].copy(), quat(np.cross(fy, Z), fy, Z)]
    prev, FR = {}, {}
    for i in fr:
        J, F = J_all[i], {}; d = lambda a, b: nrm(J[b] - J[a])
        up = d(0, 8); px = perp(J[1] - J[4], up, np.array([1.0, 0, 0])); py = np.cross(up, px); O = J[0].copy(); F["pelvis"] = [O, quat(px, py, up)]
        tz = nrm(d(7, 8) + up); tx = perp(J[14] - J[11], tz, px); ty = np.cross(tz, tx); T0 = O + tz * (T["sacrum"] * g + T["torso"] * st); tq = quat(tx, ty, tz)
        F["torso"] = [T0, tq]; F["head"] = [T0 + tz * T["neck"] * g, tq]; hands = {}
        for s, sg, a_sh, a_el, a_wr in (("r", 1, 14, 15, 16), ("l", -1, 11, 12, 13)):
            Ps = T0 + tx * sg * T["shX"] * st + tz * T["shZ"] * st + ty * T["shY"] * st
            ux, uy, uz, uq = bone(d(a_sh, a_el), prev.get(s + "u", tx), ty); prev[s + "u"] = ux; F[s + "_uarm"] = [Ps, uq]; El = Ps - uz * LEN["uarm"]
            lx, ly, lz, lq = bone(d(a_el, a_wr), prev.get(s + "l", ux), uy); prev[s + "l"] = lx; F[s + "_larm"] = [El, lq]; hz = lz
            if s == s_sh:
                f = -lz; nn = perp(ty + np.array([0, 0, -0.5]), f, -Z); hz = -nrm(f * np.cos(sm[i]) + nn * np.sin(sm[i]))
            hands[s] = dict(p=El - lz * LEN["larm"], z=hz, x=lx)
        for s, o in (("r", "l"), ("l", "r")):                               # palms face each other
            h = hands[s]; m = hands[o]["p"] - h["p"]; m = m - h["z"] * (m @ h["z"])
            y = nrm(m) if np.linalg.norm(m) > 0.06 else (perp(prev[s + "h"], h["z"], h["x"]) if s + "h" in prev else h["x"] * (-1 if s == "r" else 1))
            prev[s + "h"] = y; F[s + "_hand"] = [h["p"], quat(np.cross(y, h["z"]), y, h["z"])]
        F["_px"], F["_py"], F["_leg"] = px, py, {}
        for s, sg, hp, kn, an in (("r", 1, 1, 2, 3), ("l", -1, 4, 5, 6)):
            Ph = O + px * sg * T["hipX"] * g; K = Ph + d(hp, kn) * LEN["thigh"]; A = K + d(kn, an) * LEN["shank"]; F["_leg"][s] = dict(P=Ph, K=K, A=A); set_leg(F, s)
        FR[i] = F
    # ---- feet planted until lift-off: working back from lift-off, move the body so a grounded foot neither slides nor sinks; with both feet down, re-bend each knee to reach its own spot
    sole = T["sole"] * g

    def move(F, o):
        for n_ in RIG_SEGMENTS: F[n_][0] = F[n_][0] + o
        for s in "rl":
            for kk in "PKA": F["_leg"][s][kk] = F["_leg"][s][kk] + o

    def reach(F, s, Tg):
        q = F["_leg"][s]; a, b = LEN["thigh"], LEN["shank"]; v = Tg - q["P"]; dd = float(np.clip(np.linalg.norm(v), abs(a - b) + 1e-3, a + b - 1e-3)); al = nrm(v)
        x = (a * a - b * b + dd * dd) / (2 * dd); h = np.sqrt(max(a * a - x * x, 0.0)); kd = q["K"] - q["P"]; kd = kd - al * (kd @ al)
        if kd @ kd < 1e-6: kd = F["_py"] - al * (F["_py"] @ al)
        q["K"] = q["P"] + al * x + nrm(kd) * h; q["A"] = q["P"] + al * dd; set_leg(F, s)
    o, oL, Tg = np.zeros(3), np.zeros(3), {}
    for i in range(lift, v0 - 1, -1):
        F = FR[i]; q = F["_leg"]; zm = min(q["r"]["A"][2], q["l"]["A"][2]); down = {s: q[s]["A"][2] - zm < 0.06 for s in "rl"}
        ds = [Tg[s] - q[s]["A"] for s in "rl" if down[s] and Tg.get(s) is not None]
        o = np.mean(ds, 0) if ds else np.array([o[0], o[1], sole - zm])
        if i == lift: oL = o.copy()
        move(F, o)
        for s in "rl":
            if not down[s]: Tg[s] = None; continue
            if Tg.get(s) is None: Tg[s] = np.array([q[s]["A"][0], q[s]["A"][1], sole])
            reach(F, s, Tg[s])
    for i in range(lift + 1, v1 + 1): move(FR[i], oL)
    N = len(P); idx = np.clip(np.arange(N), v0, v1); pos, rot = {}, {}                          # frames outside the usable range hold the nearest pose
    for n_ in RIG_SEGMENTS:
        pos[n_] = np.array([FR[i][n_][0] for i in idx]); qq = np.array([FR[i][n_][1] for i in idx])
        for j in range(1, N):
            if qq[j] @ qq[j - 1] < 0: qq[j] = -qq[j]                                             # keep the rotation continuous for interpolation
        rot[n_] = qq
    return dict(pos=pos, rot=rot, scale={n_: scale[n_.split("_")[-1]] for n_ in RIG_SEGMENTS}, lift=lift,
                stand=T["sole"] * g + Lsh + Lth + T["sacrum"] * g + T["torso"] * st + (T["neck"] + T["head"]) * g)


def write_glb(path, skeletons, fps=30.0):
    """Animated 3D file: each (name, rig, rgba) in `skeletons` becomes a group of 15 bone meshes with one position + rotation key per frame. glTF is y-up, so the root turns z-up into y-up."""
    with open(os.path.join(ROOT, "assets", "skeleton.glb"), "rb") as fh:
        raw = fh.read()
    jl = struct.unpack_from("<I", raw, 12)[0]; src = json.loads(raw[20:20 + jl]); binc = raw[20 + jl + 8:]
    DT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}; NC = dict(SCALAR=1, VEC2=2, VEC3=3, VEC4=4)

    def read(ai):
        a = src["accessors"][ai]; bv = src["bufferViews"][a["bufferView"]]; dt = np.dtype(DT[a["componentType"]]); nc = NC[a["type"]]
        return np.ndarray((a["count"], nc), dt, binc, bv.get("byteOffset", 0) + a.get("byteOffset", 0), (bv.get("byteStride") or dt.itemsize * nc, dt.itemsize)).copy()
    out = dict(asset=dict(version="2.0", generator="shot_coach"), scene=0, scenes=[dict(nodes=[0])], nodes=[], meshes=[], materials=[], accessors=[], bufferViews=[], buffers=[], animations=[])
    blob = bytearray()

    def add(arr, typ, target=None, minmax=False):
        arr = np.ascontiguousarray(arr)
        while len(blob) % 4: blob.append(0)
        bv = dict(buffer=0, byteOffset=len(blob), byteLength=arr.nbytes)
        if target: bv["target"] = target
        blob.extend(arr.tobytes()); out["bufferViews"].append(bv)
        acc = dict(bufferView=len(out["bufferViews"]) - 1, componentType={v: k for k, v in DT.items()}[arr.dtype.type], count=len(arr), type=typ)
        if minmax: acc["min"], acc["max"] = np.atleast_1d(arr.min(0)).astype(float).tolist(), np.atleast_1d(arr.max(0)).astype(float).tolist()
        out["accessors"].append(acc); return len(out["accessors"]) - 1
    geo = {}
    for nd in src["nodes"]:
        if nd.get("name") in RIG_SEGMENTS and "mesh" in nd:
            pr = src["meshes"][nd["mesh"]]["primitives"][0]; ix = read(pr["indices"]).ravel()
            geo[nd["name"]] = dict(POSITION=add(read(pr["attributes"]["POSITION"]).astype(np.float32), "VEC3", 34962, True), NORMAL=add(read(pr["attributes"]["NORMAL"]).astype(np.float32), "VEC3", 34962),
                                   indices=add(ix.astype(np.uint16 if ix.max() < 65535 else np.uint32), "SCALAR", 34963))
    n_fr = len(next(iter(skeletons[0][1]["pos"].values()))); t_acc = add((np.arange(n_fr) / fps).astype(np.float32), "SCALAR", None, True)
    out["nodes"].append(dict(name="shot", rotation=[0, 0.7071067811865476, 0.7071067811865476, 0], children=[])); anim = dict(name="shot", samplers=[], channels=[])   # root: z up, facing +y  ->  y up, facing +z
    for k, (name, rg, rgba) in enumerate(skeletons):
        mat = dict(name=name, pbrMetallicRoughness=dict(baseColorFactor=list(rgba), metallicFactor=0.0, roughnessFactor=0.9))
        if rgba[3] < 1: mat["alphaMode"] = "BLEND"
        out["materials"].append(mat); grp = dict(name=name, children=[]); out["nodes"].append(grp); out["nodes"][0]["children"].append(len(out["nodes"]) - 1)
        for seg in RIG_SEGMENTS:
            if seg not in geo: continue
            out["meshes"].append(dict(name=f"{name} {seg}", primitives=[dict(attributes=dict(POSITION=geo[seg]["POSITION"], NORMAL=geo[seg]["NORMAL"]), indices=geo[seg]["indices"], material=k)]))
            p, q = rg["pos"][seg].astype(np.float32), rg["rot"][seg].astype(np.float32); q = q / np.linalg.norm(q, axis=1, keepdims=True)
            out["nodes"].append(dict(name=f"{name} {seg}", mesh=len(out["meshes"]) - 1, translation=p[0].tolist(), rotation=q[0].tolist(), scale=[float(x) for x in rg["scale"][seg]]))
            ni = len(out["nodes"]) - 1; grp["children"].append(ni)
            for pth, arr, typ in (("translation", p, "VEC3"), ("rotation", q, "VEC4")):
                anim["samplers"].append(dict(input=t_acc, output=add(arr, typ), interpolation="LINEAR")); anim["channels"].append(dict(sampler=len(anim["samplers"]) - 1, target=dict(node=ni, path=pth)))
    out["animations"].append(anim); out["scenes"][0]["extras"] = dict(release_s=30 / fps, fps=fps, units="metres, y up", skeletons=[s[0] for s in skeletons])
    while len(blob) % 4: blob.append(0)
    out["buffers"].append(dict(byteLength=len(blob))); js = json.dumps(out, separators=(",", ":")).encode(); js += b" " * (-len(js) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\x00") + bytes(blob))


# ===================================================================== 3D file (your skeleton over the player's average shot)
def canon_rot(p):
    """Rotation about the vertical axis that puts the right->left body line along +x (so shots filmed from any side line up)."""
    lat = np.nanmedian((p[:, 4] - p[:, 1]) + (p[:, 11] - p[:, 14]), axis=0)
    th = np.arctan2(lat[2], lat[0]); c, s = np.cos(th), np.sin(th)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def refine_arm_depth(p):
    """Re-solve how far each arm bone points towards or away from the camera. A single camera measures a bone's sideways and vertical extent well but
    its depth poorly: the lifter can flatten one arm into the picture and stretch the other. Each bone has one true length (the same left and right), so
    the size of its depth is whatever is left once the in-picture length is taken out. Which way it points (towards or away) is the lifter's, except:
      - an upper arm raised above the shoulder cannot point behind the chest, so it takes the direction that puts it in front of the body;
      - until just after the release both hands are on or near the ball, so the two forearms take the directions that bring the wrists closest together
        (the lifter's choice wins ties); later in the follow-through the hands separate and the lifter's directions are kept.
    Input and output: (T,17,3) in the camera frame (x right, y down, z away)."""
    p = p.copy(); ok = ~np.isnan(p).any((1, 2))
    if ok.sum() < 8: return p
    q = p[ok]; unit = lambda v: v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)
    up = unit(q[:, 8] - q[:, 0]); fwd = unit(np.cross(up, unit((q[:, 14] - q[:, 11]) + (q[:, 1] - q[:, 4]))))      # the way the chest faces
    smooth = lambda x: np.convolve(np.pad(x, 2, mode="edge"), np.ones(5) / 5, mode="valid")
    depth = lambda a, b, L: np.sqrt(np.clip(L * L - ((q[:, b] - q[:, a])[:, :2] ** 2).sum(-1), 0, None))
    length = lambda pair: float(np.median(np.concatenate([np.linalg.norm(q[:, b] - q[:, a], axis=-1) for a, b in pair])))
    L = length(((14, 15), (11, 12)))
    for sh, el, wr in ((14, 15, 16), (11, 12, 13)):                                         # upper arms; the wrist follows the moved elbow
        v = q[:, el] - q[:, sh]; sign = np.where(-v[:, 1] > 0.2 * L, np.where(fwd[:, 2] >= 0, 1.0, -1.0), np.where(v[:, 2] >= 0, 1.0, -1.0))
        shift = smooth(sign * depth(sh, el, L)) - v[:, 2]; q[:, el, 2] += shift; q[:, wr, 2] += shift
    L = length(((15, 16), (12, 13))); mR, mL = depth(15, 16, L), depth(12, 13, L); zR, zL = (q[:, 16] - q[:, 15])[:, 2], (q[:, 13] - q[:, 12])[:, 2]
    best, pick = np.full(len(q), np.inf), np.zeros((len(q), 2)); held = (np.where(ok)[0] <= 32).astype(float)        # the release is sample 30
    for sR in (1.0, -1.0):
        for sL in (1.0, -1.0):
            gap = np.sqrt(((q[:, 16, :2] - q[:, 13, :2]) ** 2).sum(-1) + ((q[:, 15, 2] + sR * mR) - (q[:, 12, 2] + sL * mL)) ** 2)
            cost = gap * held + 0.1 * L * ((np.sign(zR) != sR).astype(float) + (np.sign(zL) != sL))          # small preference for the lifter's own choice
            upd = cost < best; best[upd] = cost[upd]; pick[upd] = (sR, sL)
    q[:, 16, 2] = q[:, 15, 2] + smooth(pick[:, 0] * mR); q[:, 13, 2] = q[:, 12, 2] + smooth(pick[:, 1] * mL)
    p[ok] = q; return p


def write_3d(path, p, ext, rise, r, hand, ref, player, stype):
    """Animated .glb: your skeleton (grey) and the player's average skeleton (orange) overlaid, release-aligned. Returns False if there is no average for that player."""
    avg = ref.get("averages", {}).get(player, {}).get(stype)
    if avg is None or not os.path.exists(os.path.join(ROOT, "assets", "skeleton.glb")): return False
    p, ext, rise = p.astype(float).copy(), ext.astype(float).copy(), rise.astype(float).copy()
    if abs(r - 30) > 1e-3:                                                 # older pose files: put the release at sample 30
        def shift(x):
            out = np.full(x.shape, np.nan)
            for j in range(len(x)):
                q = r + j - 30
                if 0 <= q <= len(x) - 1:
                    a = int(np.floor(q)); b = min(a + 1, len(x) - 1); out[j] = x[a] * (1 - (q - a)) + x[b] * (q - a)
            return out
        p, ext, rise = shift(p), shift(ext), shift(rise)
    rise = np.nan_to_num(rise); p = refine_arm_depth(p)
    Rm = canon_rot(p[18:31]); p, ext = p @ Rm.T, ext @ Rm.T
    h = PLAYER_HEIGHT_CM.get(player, 193) / 100                                            # both skeletons are drawn at the player's height
    nan = lambda x: np.array([[[np.nan] * 3] * len(x[0] if x[0] is not None else x[-1]) if f is None else f for f in x], float)
    you = rig_skeleton(p, ext, rise, hand, h); pro = rig_skeleton(nan(avg["pose"]), nan(avg["ext"]), avg["rise"], avg.get("hand", "R"), h)
    write_glb(path, [("You", you, (0.604, 0.604, 0.604, 1.0)), (player, pro, (1.0, 0.402, 0.0, 0.8))])     # #cccccc and #ffaa00 (glTF colours are linear)
    return True


# ===================================================================== comparison
def find_player(q, names):
    q = ALIAS.get(q.lower().strip(), q).lower().strip()
    hit = [n for n in names if q == n.lower()] or [n for n in names if q in n.lower()] or [n for n in names if any(q == w for w in n.lower().replace("-", " ").split())]
    if len(hit) != 1:
        sys.exit(f"Player '{q}' {'is ambiguous: ' + ', '.join(hit) if hit else 'not found'}. Choose from: {', '.join(names)}")
    return hit[0]


def _fmt(v, u):
    return f"{v:.2f}" if u in ("s", "ratio") else f"{v:.0f}"


def difference(a, stype, ref, shot):
    names = sorted(p for p in ref["players"] if stype in ref["players"][p]); target = find_player(a.player, names); T = ref["players"][target][stype]
    nT = max(len(v) for v in T.values())
    if nT < 8: sys.exit(f"{target} has only {nT} usable {stype} shots - not enough to compare against")
    rows = []
    for M_ in ref["measures"]:
        k = M_["key"]
        if (M_["low_trust"] and not a.all) or k not in shot["m"] or np.isnan(shot["m"][k]) or len(T.get(k, [])) < 8: continue
        tv = np.array(T[k]); med = float(np.median(tv)); sd = max(float(np.subtract(*np.percentile(tv, [75, 25]))) / 1.349, 0.05 * abs(med), 1e-6)
        you = float(shot["m"][k]); gap = (you - med) / sd
        rows.append(dict(key=k, measure=M_["name"], unit=M_["unit"], you=you, target=med, target_low=float(np.percentile(tv, 25)), target_high=float(np.percentile(tv, 75)),
                         gap=gap, advice=M_["if_below"] if gap < 0 else M_["if_above"], low_trust=M_["low_trust"], why=M_["low_trust_why"], meaning=M_["description"]))
    rows.sort(key=lambda r: -abs(r["gap"])); short = target.split()[-1]

    def line(r, cue=True):
        u = r["unit"]; flag = f"   [less reliable: {r['why']}]" if r["low_trust"] else ""
        print(f"   - {r['measure']}: you {_fmt(r['you'], u)} {u}, {short} {_fmt(r['target'], u)} {u} (usually {_fmt(r['target_low'], u)} to {_fmt(r['target_high'], u)}), gap {r['gap']:+.1f}{flag}")
        if a.explain: print(f"       what it is: {r['meaning']}")
        if cue: print(f"       -> {r['advice']}")
    print(f"\nYour {stype} shot vs {target}'s {stype} shots ({nT} of them)")
    print(f"  your shot: {shot['name']}   pose accuracy {shot['acc']:.0f}/100; release confidence {shot['rconf']:.1f}" + ("  (low: timing measures are shaky for this clip)" if shot["rconf"] < 0.6 else "") + "\n")
    print(f"TOP 3 - what you already do like {short} (closest to his typical value):")
    for r in sorted(rows, key=lambda r: abs(r["gap"]))[:3]: line(r, cue=False)
    print(f"\nBOTTOM 3 - furthest from {short} (gap = how many of his own shot-to-shot spreads you are away):")
    for r in rows[:3]: line(r)
    rest = [r for r in rows[3:] if abs(r["gap"]) >= 1][:max(a.top - 3, 0)]
    if rest:
        print("\nOther differences, largest first:")
        for r in rest: line(r)
    print(f"\nInside {short}'s normal range on {sum(abs(r['gap']) < 1 for r in rows)} of {len(rows)} measures.")
    print("\nNotes: phone footage and NBA broadcast footage are not perfectly comparable, so treat the order as a guide, not exact numbers.\n"
          "Timing, knee bend, dip, stance and rise are the most trustworthy; anything marked 'less reliable' is weaker.")
    clean = lambda r: {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}
    return dict(mode="difference", shot=shot["name"], shot_type=stype, player=target, player_shots=nT, pose_accuracy=round(shot["acc"], 1), release_confidence=shot["rconf"],
                already_like=[clean(r) for r in sorted(rows, key=lambda r: abs(r["gap"]))[:3]], furthest=[clean(r) for r in rows[:3]],
                other_differences=[clean(r) for r in rest], measures=[clean(r) for r in rows])


def similar(a, stype, ref, shot):
    m = shot["m"]; P = {p: v[stype] for p, v in ref["players"].items() if stype in v and max(len(x) for x in v[stype].values()) >= 8}
    use = []
    for M_ in ref["measures"]:
        k = M_["key"]
        if (M_["low_trust"] and not a.all) or k not in m or np.isnan(m[k]): continue
        sds = [np.subtract(*np.percentile(v[k], [75, 25])) / 1.349 for v in P.values() if len(v.get(k, [])) >= 8]
        if len(sds) >= 3: use.append((M_, max(float(np.median(sds)), 1e-6)))                  # one common scale per measure
    res = []
    for p, v in P.items():
        z = {M_["key"]: (m[M_["key"]] - float(np.median(v[M_["key"]]))) / sd for M_, sd in use if len(v.get(M_["key"], [])) >= 8}
        if len(z) >= 0.8 * len(use): res.append((float(np.mean([min(abs(x), 4.0) for x in z.values()])), p, z))
    res.sort(); lab = {M_["key"]: M_ for M_, _ in use}
    print(f"\nWhich NBA player is your {stype} shot closest to?")
    print(f"  your shot: {shot['name']}   pose accuracy {shot['acc']:.0f}/100; release confidence {shot['rconf']:.1f}" + ("  (low: timing measures are shaky for this clip)" if shot["rconf"] < 0.6 else ""))
    print(f"  compared on {len(use)} measures. 'average gap' = how far you are from the player's typical shot, in units of a normal shot-to-shot spread.\n")
    for n, (dist, p, z) in enumerate(res, 1):
        print(f"  {n:2d}. {p:26s} average gap {dist:.2f}   within 1 spread on {sum(abs(x) < 1 for x in z.values())}/{len(z)} measures")
    skipped = [p for p in ref["players"] if p not in [r[1] for r in res]]
    if skipped: print(f"  not compared (too few {stype} shots): {', '.join(sorted(skipped))}")
    dist, p, z = res[0]; short = p.split()[-1]; order = sorted(z, key=lambda k: abs(z[k])); med = lambda k: float(np.median(P[p][k]))
    print(f"\nClosest: {p}" + (f"  (but only just: {res[1][1]} is at {res[1][0]:.2f})" if len(res) > 1 and res[1][0] - dist < 0.1 else ""))
    print("  Most alike:")
    for k in order[:3]:
        print(f"   - {lab[k]['name']}: you {_fmt(m[k], lab[k]['unit'])} {lab[k]['unit']}, {short} {_fmt(med(k), lab[k]['unit'])} {lab[k]['unit']}")
        if a.explain: print(f"       what it is: {lab[k]['description']}")
    print("  Still most different:")
    for k in order[::-1][:3]:
        print(f"   - {lab[k]['name']}: you {_fmt(m[k], lab[k]['unit'])} {lab[k]['unit']}, {short} {_fmt(med(k), lab[k]['unit'])} {lab[k]['unit']}  -> {lab[k]['if_below'] if z[k] < 0 else lab[k]['if_above']}")
        if a.explain: print(f"       what it is: {lab[k]['description']}")
    print("\nNote: 'closest' means most similar motion on these measures, not most similar results. An average gap above about 1.5 means no player is a close match.")
    row = lambda k: dict(key=k, measure=lab[k]["name"], unit=lab[k]["unit"], you=round(float(m[k]), 3), player=round(med(k), 3), gap=round(float(z[k]), 3),
                         advice=lab[k]["if_below"] if z[k] < 0 else lab[k]["if_above"], meaning=lab[k]["description"])
    return dict(mode="similar", shot=shot["name"], shot_type=stype, pose_accuracy=round(shot["acc"], 1), release_confidence=shot["rconf"], measures_compared=len(use),
                ranking=[dict(player=p_, average_gap=round(d_, 3), within_one_spread=int(sum(abs(x) < 1 for x in z_.values())), measures=len(z_)) for d_, p_, z_ in res],
                not_compared=sorted(skipped), closest=p, most_alike=[row(k) for k in order[:3]], most_different=[row(k) for k in order[::-1][:3]])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["similar", "difference", "lift"]); ap.add_argument("shot"); ap.add_argument("shot_type", nargs="?", choices=["three", "mid", "midrange"])
    ap.add_argument("player", nargs="?"); ap.add_argument("--hand", choices=["R", "L"]); ap.add_argument("--relift", action="store_true"); ap.add_argument("--clip", action="store_true")
    ap.add_argument("--out"); ap.add_argument("--all", action="store_true"); ap.add_argument("--explain", action="store_true"); ap.add_argument("--top", type=int, default=8)
    a = ap.parse_args(); t_start = time.time()
    if a.mode != "lift" and not a.shot_type: sys.exit(f"{a.mode} needs a shot type: three or mid")
    if a.mode == "difference" and not a.player: sys.exit('difference needs a player, e.g.  shot_coach.py difference shot.mov three curry')
    if os.path.isdir(a.shot) or not os.path.exists(a.shot): sys.exit(f"'{a.shot}' is not a file. Give ONE shot: a video or a pose .npz.")
    npz = a.shot; out_dir = os.path.abspath(a.out or OUTPUTS); os.makedirs(out_dir, exist_ok=True)
    if a.shot.lower().endswith(VIDEO_EXT):
        video = os.path.abspath(a.shot); npz = os.path.join(out_dir, os.path.splitext(os.path.basename(video))[0] + ".npz")
        if a.relift or not os.path.exists(npz):
            setup()
            print(f"Lifting {os.path.basename(video)} to 3D...", flush=True)
            sys.stdout.flush(); fds = [os.dup(1), os.dup(2)]; nul = os.open(os.devnull, os.O_WRONLY); os.dup2(nul, 1); os.dup2(nul, 2)     # hide model-loading chatter
            try:
                npz, msg = lift(video, out_dir, a.hand, a.clip); err = None
            except Exception as ex:
                err = f"{type(ex).__name__}: {ex}"
            finally:
                sys.stdout.flush(); os.dup2(fds[0], 1); os.dup2(fds[1], 2)
            if err: sys.exit(f"Could not lift this video ({err}).")
            print(f"  {msg}\n  saved {npz}" + (" and the overlay clip" if a.clip else "") + f"   [{time.time() - t_start:.1f} s]")
        else:
            print(f"Using the existing pose file {npz}  (--relift to redo it)")
    elif not a.shot.lower().endswith(".npz"):
        sys.exit(f"'{a.shot}' is neither a video nor a pose .npz.")
    if a.mode == "lift": return
    d = np.load(npz, allow_pickle=True)
    if "pose3d" not in d or "release_idx" not in d: sys.exit(f"{os.path.basename(npz)} is not a pose file made by this script")
    p, r, rise, v0, v1, ext = shot_window(d); m = metrics(p, r, str(d["hand"]), rise, v0, v1, ext)
    if not m: sys.exit("The shot window is too short to measure (the release is too close to the start of the video).")
    rf = os.path.join(ROOT, "nba_reference.json")
    if not os.path.exists(rf): sys.exit("nba_reference.json is missing next to this script")
    shot = dict(name=os.path.splitext(os.path.basename(npz))[0], m=m, acc=float(d["accuracy"]), rconf=float(d["release_conf"]))
    stype = "mid" if a.shot_type.startswith("mid") else "three"; buf = io.StringIO(); ref = json.load(open(rf))

    class Tee:                                                             # the report goes to the screen and to a file
        def write(self, x): sys.__stdout__.write(x); buf.write(x)
        def flush(self): sys.__stdout__.flush()
    with contextlib.redirect_stdout(Tee()):
        res = (similar if a.mode == "similar" else difference)(a, stype, ref, shot)
    base = os.path.join(out_dir, f"{shot['name']}_{a.mode}_{stype}" + ("_" + re.sub(r"[^a-z0-9]+", "_", res["player"].lower()).strip("_") if a.mode == "difference" else ""))
    open(base + ".txt", "w").write(buf.getvalue().lstrip("\n")); json.dump(dict(res, pose_file=os.path.abspath(npz)), open(base + ".json", "w"), indent=1)
    saved = [base + ".txt", base + ".json"]
    if a.mode == "difference":
        with open(base + ".csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(res["measures"][0])); w.writeheader(); w.writerows(res["measures"])
        saved.append(base + ".csv")
    who = res["player"] if a.mode == "difference" else res["closest"]
    if write_3d(base + ".glb", p, ext, rise, r, str(d["hand"]), ref, who, stype):
        saved.append(base + ".glb"); print(f"\n3D file, you vs {who}:  {base}.glb")
    print("Saved in " + out_dir + ": " + ", ".join(os.path.basename(x) for x in saved))

if __name__ == "__main__":
    main()
