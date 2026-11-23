"""Paired CRN T0-T4 `robosim_gauntlet` verification runner for FR10 tray pickup & MBCO-4ME Rail #2 insertion.

Runs:
1. `robosim_gauntlet.preflight.run(task)` (must return zero issues).
2. Paired Common Random Numbers (CRN) T0-T4 suite for `v0` (nominal baseline) vs
   `v1` (closed-loop RGB-D + T3/T4 fault-aware controller) with `.mcap` logging.
3. Saves `v0_scorecard.json`, `v1_scorecard.json`, `crn_comparison.json`, and a
   6-panel rendered verification sheet `fr10_contact_rollout.png`.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

import mujoco
import numpy as np

GAUNTLET_DIR = pathlib.Path(__file__).resolve().parent
STUDIO_DIR = GAUNTLET_DIR.parent / 'studio_workcell'
for _p in (str(GAUNTLET_DIR), str(STUDIO_DIR)):
  if _p not in sys.path:
    sys.path.insert(0, _p)

import bakery_tray_task as btt  # noqa: E402
import tray_controller as tc  # noqa: E402
import workcell_scene as ws  # noqa: E402

from robosim_gauntlet import episode, preflight, scorecard  # noqa: E402


def _render_rollout_sheet(out_png: pathlib.Path) -> None:
  """Render a 6-panel visual contact sheet of a live physical T0 pickup + Rail #2 insertion."""
  task = btt.BakeryTrayRail2Task()
  dl, _, close = task.build_device_layer('sim')
  ctrl = tc.BakeryTrayController('v2')
  m, d = dl.sim.mj_model, dl.sim.mj_data
  r = mujoco.Renderer(m, height=240, width=320)
  cam_hero = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_CAMERA, 'hero_3_4')
  cam_oven = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_CAMERA, 'oven_closeup')
  frames: list[tuple[str, np.ndarray]] = []
  orig_step = dl.step
  tick = [0]

  def snap(label: str, cam_id: int) -> None:
    r.disable_depth_rendering()
    r.update_scene(d, camera=cam_id)
    frames.append((label, r.render().copy()))

  snap('01_home', cam_hero)

  def hook_step(cmd):
    out = orig_step(cmd)
    tick[0] += 1
    if tick[0] == 305:
      snap('02_grasp_clamp', cam_hero)
    elif tick[0] == 395:
      snap('03_air_carry', cam_hero)
    elif tick[0] == 515:
      snap('04_oven_mouth', cam_oven)
    elif tick[0] == 580:
      snap('05_rail2_insert', cam_oven)
    return out

  dl.step = hook_step
  ctrl(dl)
  snap('06_released_home', cam_hero)
  r.close()
  close()

  # Tile 2x3 contact sheet (480 x 960) with clean thin border lines
  rows = []
  for r_i in range(2):
    row = np.concatenate([frames[r_i * 3 + c_i][1] for c_i in range(3)], axis=1)
    rows.append(row)
  grid = np.concatenate(rows, axis=0)
  grid[238:242, :, :] = 24
  grid[:, 318:322, :] = 24
  grid[:, 638:642, :] = 24
  ws._write_rgb_png(out_png, grid.astype(np.float32) / 255.0)
  print(f'Rendered 6-panel rollout sheet -> {out_png} ({len(frames)} panels, {tick[0]} ticks)')


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument(
      '--out-dir',
      type=pathlib.Path,
      default=pathlib.Path(
          '/Users/pta/.gemini/antigravity/brain/2e1aa3ed-0202-4ebe-9805-b06e25ebaa37/gauntlet_out'
      ),
  )
  parser.add_argument('--base-seed', type=int, default=42)
  parser.add_argument('--variants', nargs='+', default=['v0', 'v1', 'v2'])
  parser.add_argument('--heldout-t2', type=int, default=4)
  args = parser.parse_args()

  os.environ.setdefault('GAUNTLET_CRN_SECRET', 'seams-pantry-fr10-mbco4-rail2-v1')
  args.out_dir.mkdir(parents=True, exist_ok=True)

  task = btt.BakeryTrayRail2Task()
  issues = preflight.run(task)
  print('PREFLIGHT ISSUES:', issues)
  if issues:
    raise SystemExit(f'Preflight failed: {issues}')

  tiers = ('T0', 'T1', 'T2', 'T3', 'T4')
  counts = {'T0': 2, 'T1': 3, 'T2': 4, 'T3': 3, 'T4': 4}

  results_by_var: dict[str, list[episode.EpisodeResult]] = {}
  variants = tuple(args.variants)

  for var in variants:
    ctrl = tc.BakeryTrayController(var)
    mcap_dir = args.out_dir / 'mcap' / var
    mcap_dir.mkdir(parents=True, exist_ok=True)
    res_list: list[episode.EpisodeResult] = []
    print(f'\n================ RUNNING {var.upper()} (16 CRN EPISODES T0-T4) ================')
    for tier in tiers:
      for idx in range(counts[tier]):
        r = episode.run_episode(
            task,
            ctrl,
            tier=tier,
            idx=idx,
            base_seed=args.base_seed,
            mcap_dir=mcap_dir,
        )
        res_list.append(r)
        g = r.grade
        extra = ''
        if r.pspec.disturbance:
          extra = f' dist={r.pspec.disturbance}'
        if r.pspec.fault:
          extra += f' fault={r.pspec.fault}(trig={r.pspec.fault_trigger},restamp={r.pspec.fault_restamp})'
        print(
            f'  {var} {tier}[{idx}]: safe_pass={str(g.safe_pass):5s} '
            f'succ={str(g.success):5s} safe={str(g.safe):5s} abort_ok={str(g.aborted_ok):5s} '
            f'viol={list(g.violations)} '
            f'F=({g.metrics.get("grasp_force_n",0):.1f}/{g.metrics.get("contact_force_n",0):.1f}/{g.metrics.get("impact_force_n",0):.1f}N){extra}'
        )
    results_by_var[var] = res_list
    scorecard.save_json(args.out_dir / f'{var}_scorecard.json', res_list)
    summ = scorecard.summary(res_list)
    print(f'\n--- {var.upper()} SUMMARY ---')
    for k, v in summ.items():
      print(f'  {k}: {v:.4f}' if isinstance(v, float) else f'  {k}: {v}')

  # Paired CRN comparisons
  comp_out: dict[str, object] = {
      f'{v}_summary': scorecard.summary(rs) for v, rs in results_by_var.items()
  }
  for va, vb in (('v0', 'v1'), ('v1', 'v2'), ('v0', 'v2')):
    if va in results_by_var and vb in results_by_var:
      cmp = scorecard.compare(results_by_var[va], results_by_var[vb])
      print(f'\n================ PAIRED CRN COMPARISON ({va} -> {vb}) ================')
      print(cmp)
      comp_out[f'compare_{va}_to_{vb}'] = str(cmp)
  (args.out_dir / 'crn_comparison.json').write_text(json.dumps(comp_out, indent=2, default=str))

  # Held-out unseen T2 seeds (idx 4..4+heldout_t2-1) on the newest variant
  if args.heldout_t2 > 0 and variants:
    top_var = variants[-1]
    ctrl = tc.BakeryTrayController(top_var)
    held_list: list[episode.EpisodeResult] = []
    print(f'\n================ HELD-OUT UNSEEN T2 SEEDS ({top_var.upper()}, idx 4..{3 + args.heldout_t2}) ================')
    for idx in range(4, 4 + args.heldout_t2):
      r = episode.run_episode(task, ctrl, tier='T2', idx=idx, base_seed=args.base_seed)
      held_list.append(r)
      g = r.grade
      tidx = list(r.body_names).index('tray/mbco4_tray')
      oidx = list(r.body_names).index('oven/mbco4_oven')
      rel = r.log[-1].meas['gauntlet/poses'][tidx][:3] - r.log[-1].meas['gauntlet/poses'][oidx][:3]
      print(
          f'  {top_var} T2[{idx}]: safe_pass={str(g.safe_pass):5s} '
          f'viol={list(g.violations)} '
          f'F=({g.metrics.get("grasp_force_n",0):.1f}/{g.metrics.get("contact_force_n",0):.1f}/{g.metrics.get("impact_force_n",0):.1f}N) '
          f'rel={np.round(rel, 4).tolist()}'
      )
    scorecard.save_json(args.out_dir / f'{top_var}_heldout_t2_scorecard.json', held_list)
    print(f'  HELD-OUT T2 safe_pass_rate: {scorecard.summary(held_list)["safe_pass_rate"]:.4f}')

  _render_rollout_sheet(args.out_dir / 'fr10_contact_rollout.png')


if __name__ == '__main__':
  main()
