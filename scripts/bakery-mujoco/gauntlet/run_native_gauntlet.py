"""Sim-to-Real Gauntlet runner for the production Rust `bakery-native` controller.

Runs unmodified `robosim_gauntlet` (`preflight`, `episode`, `perturb`, `proxy`,
`grade`, `scorecard`) against the out-of-process Rust `bakery-gauntlet` binary on
the verified production `bakery-native` MJCF fixtures (`spanner-oven`, `combined`,
`separate`, `pan-staging`).

Suites:
- `preflight`: Scene physics + negative/positive goal control audit on each task.
- `crn`: Paired CRN T0-T4 + held-out T2 comparing `--mode shipped` (exact shipped
  `bakery_native::transfer::Operation`) vs `--mode hardened` (closed-loop Rust
  RGB-D + T3/T4 controller built on `bakery_native::ik` + `servo::command`).
- `stress`: Single-axis & payload CoM-shift physical envelope stress matrix on
  `--mode shipped` (friction drift, mass + forward/lateral CoM shift, gain &
  gravcomp drift, proprio noise/bias, tray XY/yaw jig tolerance, fixture & base
  Z/tilt misalignment, T3 slip/push/knockout).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
from typing import Any

import mujoco
import numpy as np

GAUNTLET_DIR = pathlib.Path(__file__).resolve().parent
STUDIO_DIR = GAUNTLET_DIR.parent / 'studio_workcell'
for _p in (str(GAUNTLET_DIR), str(STUDIO_DIR)):
  if _p not in sys.path:
    sys.path.insert(0, _p)

import bakery_native_task as bnt  # noqa: E402
import workcell_scene as ws  # noqa: E402

from robosim_gauntlet import (  # noqa: E402
    episode,
    grade as grade_lib,
    perturb,
    preflight,
    proxy,
    scorecard,
)


def run_custom_episode(
    task: bnt.BakeryNativeTask,
    controller_cmd: list[str],
    pspec: perturb.PSpec,
    *,
    seed: int = 0,
    include_latency: bool = False,
) -> tuple[episode.EpisodeResult, dict[str, float]]:
  """Run one episode with an explicit `PSpec` through unmodified `robosim_gauntlet`."""
  rng = perturb.streams(seed, task.task_id, pspec.tier, pspec.idx)
  extra = perturb.privileged_devices(task, pspec)
  dl, reset, close = task.build_device_layer(mode='sim', extra_devices=extra)
  try:
    reset()
    raw = dl
    perturb.apply_static(raw, task, pspec)
    sha = hashlib.sha256(raw.sim.mj_spec.to_xml().encode()).hexdigest()
    names = raw.get_device(perturb.MONITOR).body_names
    top, rec, _, fault = episode.wrap_episode_layer(
        dl,
        task,
        pspec,
        rng.sensor,
        sim=True,
        include_latency=include_latency,
    )
    max_ticks = round(task.episode_s / task.control_dt_s)
    allow = task.deployment_keys()
    outcome = proxy.serve(
        top,
        controller_cmd,
        allow=allow,
        max_ticks=max_ticks,
        wall_timeout_s=10.0 * task.episode_s + 60.0,
        prompt=task.prompt,
        tick_fn=lambda: max(0, len(rec.log) - 1),
    )
    if not rec.log:
      rec.begin_stepping()
    settle_start = len(rec.log)
    episode.settle(
        rec,
        dl.commands_spec(),
        task.control_dt_s,
        status=outcome['status'],
        command_to_joint=task.safety.command_to_joint,
    )
    onset = fault.onset_tick if fault is not None else None
    g = grade_lib.grade(
        rec.log,
        task,
        body_names=names,
        joint_bounds=episode._joint_bounds(dl.commands_spec(), task.safety.command_to_joint),
        outcome=outcome,
        fault=pspec.fault,
        onset_tick=onset,
        settle_start=settle_start,
        fault_restamp=pspec.fault_restamp,
    )
    p_final = grade_lib.poses_at(rec.log[-1], names)
    perr = task.placement_error(p_final)
  finally:
    close()
  res = episode.EpisodeResult(
      task_id=task.task_id,
      tier=pspec.tier,
      idx=pspec.idx,
      seed=seed,
      mode='sim',
      pspec=pspec,
      outcome=outcome,
      grade=g,
      log=rec.log,
      settle_start=settle_start,
      onset_tick=onset,
      scene_sha256=sha,
      body_names=names,
  )
  return res, perr


def build_stress_cases(preset: bnt.NativeTaskPreset) -> list[dict[str, Any]]:
  """Build single-axis & CoM-shift physical envelope cases for shipped `bakery-native`."""
  cases: list[dict[str, Any]] = [
      {'label': 'nominal_t0', 'axis': 'nominal', 'pspec': perturb.PSpec(tier='T0', idx=0)},
  ]
  # 1. Friction drift (applied to both tray and gripper pads!)
  for idx, fr in enumerate((0.4, 0.6, 0.8, 1.2, 1.4), 1):
    cases.append({
        'label': f'friction_{fr:.1f}x',
        'axis': 'friction',
        'pspec': perturb.PSpec(tier='T1', idx=idx, friction_scale=fr),
        'task_kwargs': {'plant_pad_friction_scale': fr},
    })
  # 2. Payload mass + CoM shift (controller assumes nominal mass & centered CoM!)
  base_mass = preset.ingredient_mass_kg
  mass_vals = (0.0, 0.5, 1.5, 2.0) if base_mass > 0 else (0.5, 1.0)
  for idx, m_kg in enumerate(mass_vals, 1):
    cases.append({
        'label': f'mass_{m_kg:.1f}kg',
        'axis': 'payload_mass',
        'pspec': perturb.PSpec(tier='T1', idx=10 + idx),
        'task_kwargs': {'plant_ingredient_mass_kg': m_kg},
    })
  if base_mass > 0:
    for idx, fwd in enumerate((-100, -50, 50, 100), 1):
      cases.append({
          'label': f'com_fwd_{fwd:+d}mm',
          'axis': 'payload_com',
          'pspec': perturb.PSpec(tier='T1', idx=20 + idx),
          'task_kwargs': {'plant_ingredient_forward_mm': fwd},
      })
    for idx, lat in enumerate((-60, -30, 30, 60), 1):
      cases.append({
          'label': f'com_lat_{lat:+d}mm',
          'axis': 'payload_com',
          'pspec': perturb.PSpec(tier='T1', idx=30 + idx),
          'task_kwargs': {'plant_ingredient_lateral_mm': lat},
      })
    cases.append({
        'label': 'com_corner_heavy_pos',
        'axis': 'payload_com',
        'pspec': perturb.PSpec(tier='T2', idx=38),
        'task_kwargs': {
            'plant_ingredient_mass_kg': 1.5,
            'plant_ingredient_forward_mm': 80,
            'plant_ingredient_lateral_mm': 40,
        },
    })
    cases.append({
        'label': 'com_corner_heavy_neg',
        'axis': 'payload_com',
        'pspec': perturb.PSpec(tier='T2', idx=39),
        'task_kwargs': {
            'plant_ingredient_mass_kg': 1.5,
            'plant_ingredient_forward_mm': -80,
            'plant_ingredient_lateral_mm': -40,
        },
    })
  # 3. Actuator gain & gravcomp drift
  for idx, gscale in enumerate((0.75, 0.85, 1.15, 1.25), 1):
    cases.append({
        'label': f'gain_{gscale:.2f}x',
        'axis': 'actuator_gain',
        'pspec': perturb.PSpec(tier='T2', idx=40 + idx, gain_scale=gscale),
    })
  for idx, gc in enumerate((-0.10, 0.10), 1):
    cases.append({
        'label': f'gravcomp_{gc:+.2f}',
        'axis': 'gravcomp',
        'pspec': perturb.PSpec(tier='T4', idx=50 + idx, gravcomp_delta=gc),
    })
  # 4. Proprioception noise & bias
  cases.append({
      'label': 'proprio_t2',
      'axis': 'proprio_noise',
      'pspec': perturb.PSpec(tier='T2', idx=60, proprio_noise=0.002, proprio_bias=0.004),
  })
  cases.append({
      'label': 'proprio_heavy',
      'axis': 'proprio_noise',
      'pspec': perturb.PSpec(tier='T2', idx=61, proprio_noise=0.005, proprio_bias=0.008),
  })
  # 5. Tray misalignment (mechanical jig tolerance)
  for idx, dmm in enumerate((-15, -10, -5, 5, 10, 15), 1):
    cases.append({
        'label': f'tray_dx_{dmm:+d}mm',
        'axis': 'tray_misalign_xy',
        'pspec': perturb.PSpec(tier='T1', idx=70 + idx, target_xy_m=(dmm / 1000.0, 0.0)),
    })
  for idx, dmm in enumerate((-15, -10, -5, 5, 10, 15), 1):
    cases.append({
        'label': f'tray_dy_{dmm:+d}mm',
        'axis': 'tray_misalign_xy',
        'pspec': perturb.PSpec(tier='T1', idx=80 + idx, target_xy_m=(0.0, dmm / 1000.0)),
    })
  for idx, deg in enumerate((-10.0, -5.0, -2.0, 2.0, 5.0, 10.0), 1):
    cases.append({
        'label': f'tray_yaw_{deg:+.0f}deg',
        'axis': 'tray_misalign_yaw',
        'pspec': perturb.PSpec(tier='T1', idx=90 + idx, target_yaw_deg=deg),
    })
  # 6. Destination fixture & pedestal Z/tilt misalignment
  for idx, dmm in enumerate((-10, -5, 5, 10), 1):
    cases.append({
        'label': f'dest_dx_{dmm:+d}mm',
        'axis': 'dest_misalign',
        'pspec': perturb.PSpec(tier='T1', idx=100 + idx, dest_xy_m=(dmm / 1000.0, 0.0)),
    })
  for idx, dmm in enumerate((-10, -5, 5, 10), 1):
    cases.append({
        'label': f'dest_dy_{dmm:+d}mm',
        'axis': 'dest_misalign',
        'pspec': perturb.PSpec(tier='T1', idx=110 + idx, dest_xy_m=(0.0, dmm / 1000.0)),
    })
  for idx, dmm in enumerate((-10, -5, -3, 3, 5, 10), 1):
    cases.append({
        'label': f'base_dz_{dmm:+d}mm',
        'axis': 'base_z_tilt',
        'pspec': perturb.PSpec(tier='T1', idx=120 + idx, table_dz_m=dmm / 1000.0),
    })
  for idx, deg in enumerate((-1.0, -0.5, 0.5, 1.0), 1):
    cases.append({
        'label': f'base_tilt_{deg:+.1f}deg',
        'axis': 'base_z_tilt',
        'pspec': perturb.PSpec(tier='T2', idx=130 + idx, table_tilt_deg=deg),
    })
  # 7. Online T3 disturbances (slip, push, knockout)
  for idx, dist in enumerate(('slip', 'push', 'knockout'), 1):
    cases.append({
        'label': f'dist_{dist}',
        'axis': 'disturbance',
        'pspec': perturb.PSpec(tier='T3', idx=140 + idx, disturbance=dist, push_dir_rad=0.7),
    })
  return cases


def run_stress_suite(
    task_ids: list[str], out_dir: pathlib.Path, binary: pathlib.Path
) -> dict[str, Any]:
  report: dict[str, Any] = {}
  for tid in task_ids:
    preset = bnt.PRESETS[tid]
    cases = build_stress_cases(preset)
    print(f'\n================ STRESS MATRIX: {tid} ({len(cases)} cases, shipped Rust) ================')
    rows: list[dict[str, Any]] = []
    for c in cases:
      tkw = dict(c.get('task_kwargs', {}))
      task = bnt.make_task(tid, binary=binary, include_cameras=False, **tkw)
      res, perr = run_custom_episode(
          task, task.controller_cmd('shipped'), c['pspec'], seed=42, include_latency=False
      )
      g = res.grade
      row = {
          'label': c['label'],
          'axis': c['axis'],
          'safe_pass': bool(g.safe_pass),
          'success': bool(g.success),
          'safe': bool(g.safe),
          'violations': list(g.violations),
          'grasp_force_n': round(float(g.metrics.get('grasp_force_n', 0.0)), 2),
          'contact_force_n': round(float(g.metrics.get('contact_force_n', 0.0)), 2),
          'impact_force_n': round(float(g.metrics.get('impact_force_n', 0.0)), 2),
          'self_force_n': round(float(g.metrics.get('self_force_n', 0.0)), 2),
          'joint_speed': round(float(g.metrics.get('joint_speed', 0.0)), 3),
          'pos_err_mm': round(perr['pos_err_m'] * 1000.0, 2),
          'dx_mm': round(perr['dx_m'] * 1000.0, 2),
          'dy_mm': round(perr['dy_m'] * 1000.0, 2),
          'dz_mm': round(perr['dz_m'] * 1000.0, 2),
          'tilt_deg': round(perr['tilt_deg'], 2),
          'bakery_10mm_pass': bool(perr['pos_err_m'] < 0.010 and perr['tilt_deg'] < 5.0 and g.safe),
      }
      rows.append(row)
      status_s = 'PASS' if g.safe_pass else 'FAIL'
      print(
          f'  {c["label"]:22s} {status_s:4s} succ={str(g.success):5s} safe={str(g.safe):5s} '
          f'err={row["pos_err_mm"]:5.1f}mm ({row["tilt_deg"]:4.1f}deg) '
          f'F=({row["grasp_force_n"]:5.1f}/{row["contact_force_n"]:5.1f}/{row["impact_force_n"]:5.1f}N) '
          f'viol={row["violations"]}'
      )
    passed = sum(1 for r in rows if r['safe_pass'])
    by_axis: dict[str, dict[str, int]] = {}
    for r in rows:
      a = by_axis.setdefault(r['axis'], {'passed': 0, 'total': 0})
      a['total'] += 1
      if r['safe_pass']:
        a['passed'] += 1
    report[tid] = {
        'passed': passed,
        'total': len(rows),
        'pass_rate': round(passed / max(1, len(rows)), 4),
        'by_axis': by_axis,
        'cases': rows,
    }
    print(f'--- {tid} STRESS SUMMARY: {passed}/{len(rows)} safe_pass ({by_axis}) ---')
  out_path = out_dir / 'stress_matrix.json'
  out_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
  print(f'Saved stress matrix -> {out_path}')
  return report


def render_rollout_sheet(
    task: bnt.BakeryNativeTask, mode: str, out_png: pathlib.Path
) -> None:
  """Render a 6-panel visual contact sheet of a live T0 rollout driven by `bakery-gauntlet`."""
  dl, reset, close = task.build_device_layer('sim')
  reset()
  m, d = dl.sim.mj_model, dl.sim.mj_data
  opt = mujoco.MjvOption()
  opt.geomgroup[3] = 1
  r = mujoco.Renderer(m, height=240, width=320)
  cam_hero = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_CAMERA, 'hero_3_4')
  cam_oven = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_CAMERA, 'oven_closeup')
  frames_hero: list[np.ndarray] = []
  frames_oven: list[np.ndarray] = []
  orig_step = dl.step
  tick = [0]

  def snap_both() -> None:
    r.disable_depth_rendering()
    r.update_scene(d, camera=cam_hero, scene_option=opt)
    frames_hero.append(r.render().copy())
    r.update_scene(d, camera=cam_oven, scene_option=opt)
    frames_oven.append(r.render().copy())

  snap_both()

  def hook_step(cmd):
    out = orig_step(cmd)
    tick[0] += 1
    if tick[0] % 25 == 0:
      snap_both()
    return out

  dl.step = hook_step
  allow = task.deployment_keys()
  proxy.serve(
      dl,
      task.controller_cmd(mode),
      allow=allow,
      max_ticks=round(task.episode_s / task.control_dt_s),
      wall_timeout_s=10.0 * task.episode_s + 60.0,
      prompt=task.prompt,
  )
  snap_both()
  r.close()
  close()

  n = len(frames_hero)
  fracs = (
      (0.0, 0.16, 0.34, 0.54, 0.78, 1.0)
      if task.preset.door_op == 'cycle'
      else (0.0, 0.22, 0.42, 0.62, 0.80, 1.0)
  )
  use_oven = (False, True, False, True, True, False)
  panels = []
  for frac, oven_cam in zip(fracs, use_oven):
    idx = min(n - 1, int(round(frac * (n - 1))))
    panels.append(frames_oven[idx] if oven_cam else frames_hero[idx])
  rows = [
      np.concatenate(panels[0:3], axis=1),
      np.concatenate(panels[3:6], axis=1),
  ]
  grid = np.concatenate(rows, axis=0)
  grid[238:242, :, :] = 24
  grid[:, 318:322, :] = 24
  grid[:, 638:642, :] = 24
  ws._write_rgb_png(out_png, grid.astype(np.float32) / 255.0)
  print(f'Rendered 6-panel rollout sheet -> {out_png} ({tick[0]} ticks)')


def run_crn_suite(
    task_ids: list[str],
    variants: list[str],
    out_dir: pathlib.Path,
    binary: pathlib.Path,
    *,
    base_seed: int = 42,
    heldout_t2: int = 4,
    include_latency: bool = True,
) -> dict[str, Any]:
  os.environ.setdefault('GAUNTLET_CRN_SECRET', 'seams-pantry-bakery-native-rust-v1')
  tiers = ('T0', 'T1', 'T2', 'T3', 'T4')
  counts = {'T0': 2, 'T1': 3, 'T2': 4, 'T3': 3, 'T4': 4}

  all_summary: dict[str, Any] = {}
  for tid in task_ids:
    task = bnt.make_task(tid, binary=binary, include_cameras=True)
    t_dir = out_dir / tid
    t_dir.mkdir(parents=True, exist_ok=True)
    results_by_var: dict[str, list[episode.EpisodeResult]] = {}

    for var in variants:
      mcap_dir = t_dir / 'mcap' / var
      mcap_dir.mkdir(parents=True, exist_ok=True)
      cmd = task.controller_cmd(var)
      res_list: list[episode.EpisodeResult] = []
      print(
          f'\n================ CRN T0-T4: {tid} [{var.upper()}] '
          f'(16 episodes, latency={include_latency}) ================'
      )
      for tier in tiers:
        for idx in range(counts[tier]):
          r = episode.run_episode(
              task,
              cmd,
              tier=tier,
              idx=idx,
              base_seed=base_seed,
              mcap_dir=mcap_dir,
              include_latency=include_latency,
          )
          res_list.append(r)
          g = r.grade
          extra = ''
          if r.pspec.disturbance:
            extra = f' dist={r.pspec.disturbance}'
          if r.pspec.fault:
            extra += (
                f' fault={r.pspec.fault}'
                f'(trig={r.pspec.fault_trigger},restamp={r.pspec.fault_restamp})'
            )
          if r.outcome.get('status') in ('crash', 'timeout'):
            extra += f' stderr={r.outcome.get("stderr_tail", "").strip()[-160:]!r}'
          print(
              f'  {var:8s} {tier}[{idx}]: safe_pass={str(g.safe_pass):5s} '
              f'succ={str(g.success):5s} safe={str(g.safe):5s} abort_ok={str(g.aborted_ok):5s} '
              f'viol={list(g.violations)} '
              f'F=({g.metrics.get("grasp_force_n",0):.1f}/{g.metrics.get("contact_force_n",0):.1f}/'
              f'{g.metrics.get("impact_force_n",0):.1f}N){extra}'
          )
      results_by_var[var] = res_list
      scorecard.save_json(t_dir / f'{var}_scorecard.json', res_list)
      summ = scorecard.summary(res_list)
      print(f'\n--- {tid} {var.upper()} SUMMARY ---')
      for k, v in summ.items():
        print(f'  {k}: {v:.4f}' if isinstance(v, float) else f'  {k}: {v}')

    task_out: dict[str, Any] = {
        f'{v}_summary': scorecard.summary(rs) for v, rs in results_by_var.items()
    }
    if 'shipped' in results_by_var and 'hardened' in results_by_var:
      cmp = scorecard.compare(results_by_var['shipped'], results_by_var['hardened'])
      print(f'\n================ PAIRED CRN ({tid}: shipped -> hardened) ================')
      print(cmp)
      task_out['compare_shipped_to_hardened'] = {
          'verdict': cmp.verdict,
          'n_pairs': cmp.n_pairs,
          'a_only': cmp.a_only,
          'b_only': cmp.b_only,
          'p_better': cmp.p_better,
          'p_worse': cmp.p_worse,
          'vetoes': cmp.vetoes,
      }

    if heldout_t2 > 0 and variants:
      top_var = variants[-1]
      cmd = task.controller_cmd(top_var)
      held_list: list[episode.EpisodeResult] = []
      print(
          f'\n================ HELD-OUT UNSEEN T2 ({tid} [{top_var.upper()}], '
          f'idx 4..{3 + heldout_t2}) ================'
      )
      for idx in range(4, 4 + heldout_t2):
        r = episode.run_episode(
            task,
            cmd,
            tier='T2',
            idx=idx,
            base_seed=base_seed,
            include_latency=include_latency,
        )
        held_list.append(r)
        g = r.grade
        print(
            f'  {top_var:8s} T2[{idx}]: safe_pass={str(g.safe_pass):5s} '
            f'viol={list(g.violations)} '
            f'F=({g.metrics.get("grasp_force_n",0):.1f}/{g.metrics.get("contact_force_n",0):.1f}/'
            f'{g.metrics.get("impact_force_n",0):.1f}N)'
        )
      scorecard.save_json(t_dir / f'{top_var}_heldout_t2_scorecard.json', held_list)
      task_out[f'{top_var}_heldout_t2_safe_pass_rate'] = scorecard.summary(held_list)[
          'safe_pass_rate'
      ]

    (t_dir / 'crn_comparison.json').write_text(
        json.dumps(task_out, indent=2) + '\n', encoding='utf-8'
    )
    all_summary[tid] = task_out
  (out_dir / 'crn_summary.json').write_text(
      json.dumps(all_summary, indent=2) + '\n', encoding='utf-8'
  )
  return all_summary


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
      '--suite',
      choices=('preflight', 'stress', 'crn', 'all'),
      default='all',
  )
  parser.add_argument(
      '--tasks',
      nargs='+',
      default=['fr10_spanner_oven_load', 'ur5e_combined_oven_load'],
  )
  parser.add_argument(
      '--variants',
      nargs='+',
      default=['shipped', 'hardened'],
  )
  parser.add_argument(
      '--binary',
      type=pathlib.Path,
      default=bnt.DEFAULT_BINARY,
  )
  parser.add_argument(
      '--out-dir',
      type=pathlib.Path,
      default=pathlib.Path('output/bakery-native-gauntlet'),
  )
  parser.add_argument('--base-seed', type=int, default=42)
  parser.add_argument('--heldout-t2', type=int, default=4)
  parser.add_argument('--no-latency', action='store_true')
  parser.add_argument('--render-sheet', action='store_true')
  args = parser.parse_args()

  args.out_dir.mkdir(parents=True, exist_ok=True)

  if args.suite in ('preflight', 'all'):
    pf: dict[str, list[str]] = {}
    for tid in args.tasks:
      task = bnt.make_task(tid, binary=args.binary)
      issues = preflight.run(task)
      pf[tid] = issues
      print(f'PREFLIGHT {tid:28s}: {issues}')
    (args.out_dir / 'preflight.json').write_text(
        json.dumps(pf, indent=2) + '\n', encoding='utf-8'
    )

  if args.suite in ('stress', 'all'):
    run_stress_suite(args.tasks, args.out_dir, args.binary)

  if args.suite in ('crn', 'all'):
    run_crn_suite(
        args.tasks,
        args.variants,
        args.out_dir,
        args.binary,
        base_seed=args.base_seed,
        heldout_t2=args.heldout_t2,
        include_latency=not args.no_latency,
    )

  if args.render_sheet:
    for tid in args.tasks:
      task = bnt.make_task(tid, binary=args.binary)
      render_rollout_sheet(task, args.variants[-1], args.out_dir / f'{tid}_rollout.png')


if __name__ == '__main__':
  main()
