# PoseMamba (model code only)

The four files in `lib/model/` are copied unchanged from PoseMamba
(https://github.com/nankingjing/PoseMamba, Apache-2.0, see `LICENSE`): the 3D pose lifting network from
"PoseMamba: Monocular 3D Human Pose Estimation with Bidirectional Global-Local Spatio-Temporal State Space Model" (AAAI 2025).

`shot_coach.py` replaces the CUDA selective-scan kernel with its own CPU kernel (`sscan.c`) so the model runs on a Mac.
The weights are not stored here; `shot_coach.py` downloads `PoseMamba_L.bin` on first run.
