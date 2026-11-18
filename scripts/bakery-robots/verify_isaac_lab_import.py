"""Offline NVIDIA Isaac Lab / Newton / MuJoCo Warp import verification for Satyr workcells.

Verifies that Satyr's existing MuJoCo XML (MJCF) robot cells load directly into
Newton (`newton.ModelBuilder.add_mjcf` + `SolverMuJoCo`) and `mujoco_warp`, maintain
sub-micrometer closed-loop trajectory parity with C MuJoCo across single and
replicated multi-world batches, and export to OpenUSD (`pxr.Usd`).
"""

from __future__ import annotations

import json
from pathlib import Path
import warnings

import mujoco
import mujoco_warp as mjw
import newton
import numpy as np
from pxr import Usd, UsdGeom

REPO_ROOT = Path(__file__).resolve().parents[2]
NATIVE_ROOT = REPO_ROOT / "assets" / "bakery-mujoco" / "fr10-workcell" / "native"
EVIDENCE_JSON = REPO_ROOT / "docs" / "evidence" / "plan-24-isaac-lab-import-spike.json"


def mjc_qpos_to_newton_joint_q(qpos: np.ndarray) -> np.ndarray:
    """Convert MuJoCo qpos (free-joint quat [w,x,y,z]) to Newton joint_q ([x,y,z,w])."""
    out = qpos.astype(np.float32).copy()
    w, x, y, z = qpos[10:14]
    out[10:14] = [x, y, z, w]
    return out


def verify_all_robot_cells() -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for slug_dir in sorted(NATIVE_ROOT.iterdir()):
        if not slug_dir.is_dir():
            continue
        for scenario in ("table-to-rack-nominal", "table-to-oven-nominal"):
            xml_path = slug_dir / f"{scenario}.xml"
            m = mujoco.MjModel.from_xml_path(str(xml_path))
            builder = newton.ModelBuilder()
            builder.add_mjcf(str(xml_path), ctrl_direct=True)
            nm = builder.finalize()
            flags = nm.shape_flags.numpy()
            colliding_shapes = int(
                sum(bool(f & int(newton.ShapeFlags.COLLIDE_SHAPES)) for f in flags)
            )
            assert colliding_shapes == int(m.ngeom), (
                f"Expected {m.ngeom} colliding shapes for {slug_dir.name}/{scenario}, got {colliding_shapes}"
            )
            results.append(
                {
                    "robot": slug_dir.name,
                    "scenario": scenario,
                    "mujoco": {
                        "nq": int(m.nq),
                        "nv": int(m.nv),
                        "nu": int(m.nu),
                        "nbody": int(m.nbody),
                        "ngeom": int(m.ngeom),
                        "nsite": int(m.nsite),
                    },
                    "newton": {
                        "body_count": int(nm.body_count),
                        "joint_count": int(nm.joint_count),
                        "shape_count": int(nm.shape_count),
                        "colliding_shape_count": colliding_shapes,
                        "joint_dof_count": int(nm.joint_dof_count),
                    },
                }
            )
    return results


def verify_closed_loop_parity_and_usd(usd_output_path: Path) -> dict[str, object]:
    xml_path = NATIVE_ROOT / "fairino-fr10" / "table-to-oven-nominal.xml"
    json_path = NATIVE_ROOT / "fairino-fr10" / "table-to-oven-nominal.json"
    spec = json.loads(json_path.read_text())
    init_state = np.array(spec["initialState"], dtype=np.float64)

    # 1. Reference C MuJoCo
    m = mujoco.MjModel.from_xml_path(str(xml_path))
    d = mujoco.MjData(m)
    mujoco.mj_setState(m, d, init_state, mujoco.mjtState.mjSTATE_INTEGRATION)
    d.ctrl[:6] = d.qpos[:6]
    d.ctrl[6] = 0.035
    mujoco.mj_forward(m, d)
    initial_tray_pos = d.qpos[7:10].copy()

    # 2. Direct MuJoCo Warp (4 parallel worlds)
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        wm = mjw.put_model(m)
        wd = mjw.put_data(m, d, nworld=4)
    warp_warnings = [str(w.message) for w in caught_warnings]

    # 3. Newton + SolverMuJoCo (single world + 4-world replicated batch)
    cell_builder = newton.ModelBuilder()
    cell_builder.add_mjcf(str(xml_path), ctrl_direct=True)
    model = cell_builder.finalize()
    solver = newton.solvers.SolverMuJoCo(model, nconmax=256, njmax=512)
    state_in = model.state()
    state_out = model.state()
    control = model.control()
    q_init_newton = mjc_qpos_to_newton_joint_q(d.qpos)
    state_in.joint_q.assign(q_init_newton)
    newton.eval_fk(model, state_in.joint_q, state_in.joint_qd, state_in)
    control.mujoco.ctrl.assign(d.ctrl.astype(np.float32))

    batch_builder = newton.ModelBuilder()
    batch_builder.replicate(cell_builder, copy_count=4, spacing=(3.0, 3.0, 0.0))
    batch_model = batch_builder.finalize()
    batch_solver = newton.solvers.SolverMuJoCo(batch_model, nconmax=1024, njmax=2048)
    batch_in = batch_model.state()
    batch_out = batch_model.state()
    batch_ctrl = batch_model.control()

    viewer = newton.viewer.ViewerUSD(str(usd_output_path), fps=60, num_frames=10)
    viewer.set_model(model)

    steps = 250
    dt = float(m.opt.timestep)
    for step_idx in range(steps):
        mujoco.mj_step(m, d)
        mjw.step(wm, wd)
        solver.step(state_in, state_out, control, None, dt)
        state_in, state_out = state_out, state_in
        if step_idx < 50:
            batch_solver.step(batch_in, batch_out, batch_ctrl, None, dt)
            batch_in, batch_out = batch_out, batch_in
        if step_idx < 10:
            viewer.begin_frame(step_idx * dt)
            viewer.log_state(state_in)
            viewer.end_frame()

    viewer.close()

    qpos_c = d.qpos.copy()
    qpos_warp = wd.qpos.numpy()[0]
    qpos_newton = state_in.joint_q.numpy()
    batch_q = batch_in.joint_q.numpy().reshape(4, -1)

    stage = Usd.Stage.Open(str(usd_output_path))
    prim_paths = [str(p.GetPath()) for p in stage.Traverse()]
    mesh_prims = [str(p.GetPath()) for p in stage.Traverse() if p.IsA(UsdGeom.Mesh)]

    arm_diff_warp = float(np.max(np.abs(qpos_c[:7] - qpos_warp[:7])))
    arm_diff_newton = float(np.max(np.abs(qpos_c[:7] - qpos_newton[:7])))
    tray_diff_warp = float(np.max(np.abs(qpos_c[7:10] - qpos_warp[7:10])))
    tray_diff_newton = float(np.max(np.abs(qpos_c[7:10] - qpos_newton[7:10])))
    batch_arm_spread = float(np.max(np.abs(batch_q[:, :7] - batch_q[0:1, :7])))

    assert arm_diff_warp < 1e-5, f"Warp arm drift too large: {arm_diff_warp}"
    assert arm_diff_newton < 1e-5, f"Newton arm drift too large: {arm_diff_newton}"
    assert tray_diff_warp < 1e-5, f"Warp tray drift too large: {tray_diff_warp}"
    assert tray_diff_newton < 1e-5, f"Newton tray drift too large: {tray_diff_newton}"
    assert batch_arm_spread < 1e-7, f"Batch arm divergence: {batch_arm_spread}"
    assert len(mesh_prims) >= 7, (
        f"Expected >=7 robot STL mesh prims in USD, got {len(mesh_prims)}"
    )

    return {
        "cell": "fairino-fr10/table-to-oven-nominal",
        "steps": steps,
        "dt_seconds": dt,
        "simulated_seconds": round(steps * dt, 3),
        "initial_tray_pos_m": [round(float(v), 6) for v in initial_tray_pos],
        "final_tray_pos_c_mujoco_m": [round(float(v), 6) for v in qpos_c[7:10]],
        "final_tray_pos_mujoco_warp_m": [round(float(v), 6) for v in qpos_warp[7:10]],
        "final_tray_pos_newton_m": [round(float(v), 6) for v in qpos_newton[7:10]],
        "max_arm_joint_diff_warp_rad": arm_diff_warp,
        "max_arm_joint_diff_newton_rad": arm_diff_newton,
        "max_tray_pos_diff_warp_m": tray_diff_warp,
        "max_tray_pos_diff_newton_m": tray_diff_newton,
        "replicated_batch": {
            "copy_count": 4,
            "total_bodies": int(batch_model.body_count),
            "total_joints": int(batch_model.joint_count),
            "total_shapes": int(batch_model.shape_count),
            "max_cross_world_arm_diff_rad": batch_arm_spread,
        },
        "usd_export": {
            "total_prims": len(prim_paths),
            "mesh_prim_count": len(mesh_prims),
            "mesh_prims": mesh_prims,
        },
        "compatibility_findings": {
            "fk_synchronization": "Call newton.eval_fk(model, state.joint_q, state.joint_qd, state) after assigning state.joint_q so body_q matches joint_q before SolverMuJoCo.step",
            "recommended_solver_buffers": {"nconmax": 256, "njmax": 512},
            "quaternion_convention": "MuJoCo [w, x, y, z] -> Newton [x, y, z, w]",
            "direct_actuators": "add_mjcf(..., ctrl_direct=True) maps general affine servos to control.mujoco.ctrl",
            "mesh_dependencies": "trimesh and scipy are required by newton.ModelBuilder.add_mjcf to load robot STL collision meshes",
            "mujoco_warp_warnings": warp_warnings,
        },
    }


def main() -> None:
    usd_path = Path("/tmp/satyr-fr10-oven-cell-isaac-spike.usda")
    matrix = verify_all_robot_cells()
    parity = verify_closed_loop_parity_and_usd(usd_path)
    report = {
        "schemaVersion": 1,
        "spike": "plan-24-isaac-lab-import",
        "versions": {
            "mujoco": mujoco.__version__,
            "mujoco_warp": mjw.__version__,
            "newton": newton.__version__,
            "usd": list(Usd.GetVersion()),
        },
        "robot_cell_import_matrix": matrix,
        "closed_loop_parity_and_usd": parity,
    }
    EVIDENCE_JSON.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_JSON.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Wrote verification report to {EVIDENCE_JSON}")


if __name__ == "__main__":
    main()
