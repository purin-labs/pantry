//! Maruzen MBCO-4ME cobot door actuation controller (Plan 24).
//!
//! Physically grasps the vertical rotary latch handle using the spanner
//! gripper's dual-action handle pocket (`cell_handle_grasp`), twists the
//! spring-loaded latch (`mbco4_handle_latch`) past the mechanical strike catch,
//! swings the left-hinged door (`mbco4_door_hinge`) open or closed along its
//! `R = 0.486 m` arc, and physically re-latches it on close.
//!
//! Zero `unsafe` code; compiles for both native targets and `wasm32-unknown-emscripten`.

use anyhow::{Context, Result};
use nalgebra::Matrix3;

use crate::{
    closed_loop::{
        ClosedLoopConfig, ClosedLoopPlant, ControllerState, EpisodeStop, NominalDynamics,
        run_spanner_load,
    },
    perception::{
        CameraModel, MBCO4_OVEN_ROOF_CENTER, MBCO4_OVEN_ROOF_ROI, calibrate_table_plane,
        perceive_fixture_target, perceive_open_door_angle, spanner_table_roi,
    },
};

/// Door actuation operation mode on the articulated MBCO-4ME workcell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoorOp {
    /// Unlatch and swing the closed oven door open (`0 -> 1.76 rad`).
    Open,
    /// Grasp the open oven door handle, swing closed (`theta -> 0`), and physically re-latch.
    Close,
    /// Full autonomous cycle: open closed door -> load tray onto Rail #2 -> close & re-latch.
    ClosedOvenLoad,
    /// Negative control: pull the closed handle without twisting to prove the physical latch locks.
    NoTwistPull,
}

/// Verified Maruzen MBCO-4ME door kinematics & grasp constants (meters / radians).
const NOM_HINGE_WORLD: [f64; 3] = [-0.740, -0.198, 1.166];
const HANDLE_PIVOT_IN_DOOR: [f64; 3] = [0.486, -0.012, -0.010];
const HANDLE_GRIP_Y: f64 = -0.0375;
const HANDLE_GRIP_Z: f64 = -0.122;
const HANDLE_POCKET_OPEN_M: f64 = -0.015;
const HANDLE_POCKET_SWING_M: f64 = 0.004;
const HANDLE_POCKET_CLAMP_M: f64 = 0.016;
const UNLATCH_PHI_RAD: f64 = -0.38;
const CLOSE_UNLATCH_PHI_RAD: f64 = -0.34;
const TARGET_OPEN_THETA_RAD: f64 = 1.76;

/// Constant tool-in-handle rotation (`pitch = +45 deg, roll = -35 deg`) giving
/// `min_sv = 0.248`, zero self-collisions, and zero door/oven collisions from `0` to `106 deg`.
fn handle_tool_rel_rot() -> Matrix3<f64> {
    let (sp, cp) = 45.0_f64.to_radians().sin_cos();
    let r2 = Matrix3::new(-cp, 0.0, sp, 0.0, 1.0, 0.0, -sp, 0.0, -cp);
    let (sr, cr) = (-35.0_f64).to_radians().sin_cos();
    let rx = Matrix3::new(1.0, 0.0, 0.0, 0.0, cr, -sr, 0.0, sr, cr);
    r2 * rx
}

/// Compute world position and row-major rotation matrix of `cell_handle_grasp`
/// for door hinge position `hinge_world`, door angle `theta`, and handle twist `phi`.
pub fn handle_grasp_target(
    hinge_world: [f64; 3],
    theta: f64,
    phi: f64,
    out_m: f64,
    radial_extra_m: f64,
    dz_m: f64,
) -> ([f64; 3], [f64; 9]) {
    let (st, ct) = theta.sin_cos();
    // `mbco4_door_hinge` rotates around axis (0, 0, -1)
    let r_door = Matrix3::new(ct, st, 0.0, -st, ct, 0.0, 0.0, 0.0, 1.0);
    let piv_local = nalgebra::Vector3::from(HANDLE_PIVOT_IN_DOOR);
    let p_piv = nalgebra::Vector3::from(hinge_world) + r_door * piv_local;

    let (sph, cph) = phi.sin_cos();
    // `mbco4_handle_latch` rotates around axis (0, 1, 0) in door frame
    let r_hand_in_door = Matrix3::new(cph, 0.0, sph, 0.0, 1.0, 0.0, -sph, 0.0, cph);
    let r_hand = r_door * r_hand_in_door;

    let grip_local =
        nalgebra::Vector3::new(radial_extra_m, HANDLE_GRIP_Y - out_m, HANDLE_GRIP_Z + dz_m);
    let p_grip = p_piv + r_hand * grip_local;
    let r_des = r_hand * handle_tool_rel_rot();
    let mut rot = [0.0; 9];
    for row in 0..3 {
        for col in 0..3 {
            rot[row * 3 + col] = r_des[(row, col)];
        }
    }
    ([p_grip[0], p_grip[1], p_grip[2]], rot)
}

fn solve_handle_ik<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    handle_site: usize,
    pos: [f64; 3],
    rot: &[f64; 9],
    seed: [f64; 6],
) -> [f64; 6] {
    if let Some(q) = st.nom.solve_ik_site_rot(handle_site, pos, rot, seed) {
        return q;
    }
    let fallbacks = [
        [
            -3.5_f64.to_radians(),
            -60.4_f64.to_radians(),
            108.7_f64.to_radians(),
            -134.8_f64.to_radians(),
            -45.1_f64.to_radians(),
            -39.9_f64.to_radians(),
        ],
        [
            35.0_f64.to_radians(),
            -55.0_f64.to_radians(),
            96.0_f64.to_radians(),
            -136.0_f64.to_radians(),
            -95.0_f64.to_radians(),
            45.0_f64.to_radians(),
        ],
        [
            63.0_f64.to_radians(),
            -48.0_f64.to_radians(),
            86.0_f64.to_radians(),
            -138.0_f64.to_radians(),
            -133.0_f64.to_radians(),
            130.0_f64.to_radians(),
        ],
    ];
    for fb in fallbacks {
        if let Some(q) = st.nom.solve_ik_site_rot(handle_site, pos, rot, fb) {
            return q;
        }
    }
    seed
}

fn safe_transit_q() -> [f64; 6] {
    [
        -15.0_f64.to_radians(),
        -90.0_f64.to_radians(),
        125.0_f64.to_radians(),
        -125.0_f64.to_radians(),
        -45.0_f64.to_radians(),
        -40.0_f64.to_radians(),
    ]
}

fn closed_handle_seed() -> [f64; 6] {
    [
        -3.5_f64.to_radians(),
        -60.4_f64.to_radians(),
        108.7_f64.to_radians(),
        -134.8_f64.to_radians(),
        -45.1_f64.to_radians(),
        -39.9_f64.to_radians(),
    ]
}

fn perceive_hinge_and_z<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    use_perception: bool,
) -> Result<([f64; 3], f64, f64), EpisodeStop> {
    if !use_perception || !st.has_camera {
        return Ok((NOM_HINGE_WORLD, 0.0, TARGET_OPEN_THETA_RAD));
    }
    let table_z_nom = st.nom.source_site[2] - 0.0005;
    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, spanner_table_roi(table_z_nom), table_z_nom);
    let hinge = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        MBCO4_OVEN_ROOF_ROI,
        MBCO4_OVEN_ROOF_CENTER,
        NOM_HINGE_WORLD,
        0.012,
    );
    let open_theta = perceive_open_door_angle(&st.cam, &cloud0, cal, hinge, TARGET_OPEN_THETA_RAD);

    // Measure eye-to-hand EE Z offset right near the clear home standby pose
    // so base Z / tilt / gravcomp droop are compensated before approaching the handle.
    let p_cal = st.nom.fk_grasp(&st.cmd_q);
    let dz_ee = st.measure_spanner_z(cal, [p_cal[0], p_cal[1]], 0.0)?;
    Ok((hinge, dz_ee, open_theta))
}

fn execute_door_open<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    handle_site: usize,
    home_q: [f64; 6],
    use_perception: bool,
    with_twist: bool,
) -> Result<[f64; 3], EpisodeStop> {
    let (mut hinge, dz_ee, _) = perceive_hinge_and_z(st, use_perception)?;
    hinge[2] -= dz_ee;

    let q_mid = safe_transit_q();
    let (p_far, r_far) = handle_grasp_target(hinge, 0.0, 0.0, 0.25, 0.0, -0.044);
    let q_far = solve_handle_ik(st, handle_site, p_far, &r_far, closed_handle_seed());
    let (p_pre, r_pre) = handle_grasp_target(hinge, 0.0, 0.0, 0.09, 0.0, -0.044);
    let q_pre = solve_handle_ik(st, handle_site, p_pre, &r_pre, q_far);
    let (p_under, r_under) = handle_grasp_target(hinge, 0.0, 0.0, 0.00, 0.0, -0.044);
    let q_under = solve_handle_ik(st, handle_site, p_under, &r_under, q_pre);
    let (p_at0, r_at0) = handle_grasp_target(hinge, 0.0, 0.0, 0.00, 0.0, 0.00);
    let q_at0 = solve_handle_ik(st, handle_site, p_at0, &r_at0, q_under);

    // Approach under the bottom tip of the vertical handle bar first (`dz = -44 mm`),
    // then lift straight up into the pocket so the back-hook never bumps the handle front.
    st.move_joints(q_mid, HANDLE_POCKET_OPEN_M, false, 1.15, 0.40, 0.06)?;
    st.move_joints(q_far, HANDLE_POCKET_OPEN_M, false, 1.05, 0.35, 0.06)?;
    st.move_joints(q_pre, HANDLE_POCKET_OPEN_M, false, 0.90, 0.30, 0.06)?;
    st.move_joints(q_under, HANDLE_POCKET_OPEN_M, false, 0.75, 0.35, 0.06)?;
    st.move_joints(q_at0, HANDLE_POCKET_OPEN_M, false, 0.65, 0.40, 0.14)?;

    // Smooth silicone clamp onto handle bar (`-0.015 -> +0.016`) with T4 dead-gripper check.
    st.actuate_gripper(HANDLE_POCKET_CLAMP_M, false, 0.55, 0.36, "handle_close")?;

    let mut q_prev = q_at0;
    if with_twist {
        // Rotate spring-loaded handle (`0 -> -0.38 rad`) so pawl physically clears strike catch.
        let n_twist = 15usize;
        for k in 1..=n_twist {
            let ph = UNLATCH_PHI_RAD * (k as f64 / n_twist as f64);
            let (pk, rk) = handle_grasp_target(hinge, 0.0, ph, 0.0, 0.0, 0.0);
            let qk = solve_handle_ik(st, handle_site, pk, &rk, q_prev);
            st.move_joints(qk, HANDLE_POCKET_CLAMP_M, false, 0.85, 0.08, 0.0)?;
            q_prev = qk;
        }
    }

    // Swing door open along exact `R = 0.486 m` arc around `hinge` (`0 -> 1.76 rad`).
    // Once unlatched (`th >= 0.25`), relax clamp to `HANDLE_POCKET_SWING_M` (+4 mm) for
    // passive radial compliance (~7 mm jaw play while back-hook maintains form-closure pull).
    let swing_target = if with_twist {
        TARGET_OPEN_THETA_RAD
    } else {
        0.45
    };
    let n_swing = if with_twist { 52usize } else { 18usize };
    let mut g_end = HANDLE_POCKET_CLAMP_M;
    for k in 1..=n_swing {
        let th = swing_target * (k as f64 / n_swing as f64);
        let ph = if !with_twist {
            0.0
        } else if th < 0.25 {
            UNLATCH_PHI_RAD
        } else {
            UNLATCH_PHI_RAD * ((0.45 - th) / 0.20).clamp(0.0, 1.0)
        };
        let g_step = if !with_twist || th < 0.25 {
            HANDLE_POCKET_CLAMP_M
        } else {
            let f = ((th - 0.25) / 0.20).clamp(0.0, 1.0);
            HANDLE_POCKET_CLAMP_M + f * (HANDLE_POCKET_SWING_M - HANDLE_POCKET_CLAMP_M)
        };
        g_end = g_step;
        let (pk, rk) = handle_grasp_target(hinge, th, ph, 0.0, 0.0, 0.0);
        let qk = solve_handle_ik(st, handle_site, pk, &rk, q_prev);
        st.move_joints(qk, g_step, false, 0.72, 0.14, 0.0)?;
        q_prev = qk;
    }
    st.move_joints(q_prev, g_end, false, 0.50, 0.20, 0.10)?;

    // Release handle & slide cleanly radially-out and down past the open door tip before returning home.
    st.actuate_gripper(HANDLE_POCKET_OPEN_M, false, 0.50, 0.36, "handle_open")?;
    if with_twist {
        let (p_r0, r_r0) =
            handle_grasp_target(hinge, TARGET_OPEN_THETA_RAD, 0.0, 0.04, 0.07, -0.05);
        let q_r0 = solve_handle_ik(st, handle_site, p_r0, &r_r0, q_prev);
        let (p_r1, r_r1) =
            handle_grasp_target(hinge, TARGET_OPEN_THETA_RAD, 0.0, 0.12, 0.26, -0.06);
        let q_r1 = solve_handle_ik(st, handle_site, p_r1, &r_r1, q_r0);
        let (p_so, r_so) = handle_grasp_target(hinge, 0.85, 0.0, 0.30, 0.22, -0.02);
        let q_so = solve_handle_ik(st, handle_site, p_so, &r_so, q_r1);
        st.move_joints(q_r0, HANDLE_POCKET_OPEN_M, false, 0.80, 0.35, 0.04)?;
        st.move_joints(q_r1, HANDLE_POCKET_OPEN_M, false, 0.90, 0.40, 0.04)?;
        st.move_joints(q_so, HANDLE_POCKET_OPEN_M, false, 1.00, 0.55, 0.04)?;
        st.move_joints(q_mid, st.nom.open_jaw_m, false, 1.10, 0.55, 0.04)?;
    } else {
        let (p_dn, r_dn) = handle_grasp_target(hinge, 0.0, 0.0, 0.010, 0.014, -0.044);
        let q_dn = solve_handle_ik(st, handle_site, p_dn, &r_dn, q_prev);
        let (p_ret, r_ret) = handle_grasp_target(hinge, 0.0, 0.0, 0.20, 0.0, -0.03);
        let q_ret = solve_handle_ik(st, handle_site, p_ret, &r_ret, q_dn);
        st.move_joints(q_dn, HANDLE_POCKET_OPEN_M, false, 0.80, 0.30, 0.04)?;
        st.move_joints(q_ret, HANDLE_POCKET_OPEN_M, false, 0.85, 0.45, 0.04)?;
        st.move_joints(q_mid, st.nom.open_jaw_m, false, 1.05, 0.55, 0.04)?;
    }
    st.move_joints(home_q, st.nom.open_jaw_m, false, 1.15, 0.55, 0.20)?;
    Ok(hinge)
}

fn execute_door_close<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    handle_site: usize,
    home_q: [f64; 6],
    use_perception: bool,
    initial_open_fallback: f64,
    cached_hinge: Option<[f64; 3]>,
) -> Result<(), EpisodeStop> {
    let (hinge, th_open) = if let Some(h) = cached_hinge {
        let (_, _, perceived_open) = perceive_hinge_and_z(st, use_perception)?;
        let th = if use_perception && st.has_camera {
            perceived_open
        } else {
            initial_open_fallback
        };
        (h, th)
    } else {
        let (mut h, dz_ee, perceived_open) = perceive_hinge_and_z(st, use_perception)?;
        h[2] -= dz_ee;
        let th = if use_perception && st.has_camera {
            perceived_open
        } else {
            initial_open_fallback
        };
        (h, th)
    };

    let q_mid = safe_transit_q();
    let (p_so, r_so) = handle_grasp_target(hinge, 0.85, 0.0, 0.30, 0.22, -0.02);
    let q_so = solve_handle_ik(st, handle_site, p_so, &r_so, closed_handle_seed());
    let (p_r1, r_r1) = handle_grasp_target(hinge, th_open, 0.0, 0.12, 0.26, -0.06);
    let q_r1 = solve_handle_ik(st, handle_site, p_r1, &r_r1, q_so);
    let (p_r0, r_r0) = handle_grasp_target(hinge, th_open, 0.0, 0.04, 0.07, -0.05);
    let q_r0 = solve_handle_ik(st, handle_site, p_r0, &r_r0, q_r1);
    let (p_cat, r_cat) = handle_grasp_target(hinge, th_open, 0.0, 0.00, 0.00, 0.00);
    let q_cat = solve_handle_ik(st, handle_site, p_cat, &r_cat, q_r0);

    // Approach open door handle cleanly from south tip so forearm and jaws never clip the open leaf.
    st.move_joints(q_mid, HANDLE_POCKET_OPEN_M, false, 1.15, 0.40, 0.04)?;
    st.move_joints(q_so, HANDLE_POCKET_OPEN_M, false, 1.05, 0.45, 0.04)?;
    st.move_joints(q_r1, HANDLE_POCKET_OPEN_M, false, 1.00, 0.45, 0.04)?;
    st.move_joints(q_r0, HANDLE_POCKET_OPEN_M, false, 0.85, 0.35, 0.04)?;
    st.move_joints(q_cat, HANDLE_POCKET_OPEN_M, false, 0.65, 0.40, 0.14)?;

    // Firm initial capture onto open handle bar (reliable T4 dead-gripper check),
    // then immediately relax to `HANDLE_POCKET_SWING_M + 0.002` during the free swing
    // for passive radial compliance before firming back up in the latch zone.
    st.actuate_gripper(HANDLE_POCKET_CLAMP_M, false, 0.55, 0.36, "handle_close")?;

    // Swing door closed (`th_open -> 0.0`), twisting handle `-0.34 rad` before strike zone
    // (`th < 0.45`) so closing torque + twist keep the handle around `-0.37 rad` (clear of
    // both the strike catch and the `-0.52 rad` hard stop).
    let mut q_prev = q_cat;
    let n_close = 50usize;
    for k in 1..=n_close {
        let th = th_open * (1.0 - k as f64 / n_close as f64);
        let ph = if th > 0.45 {
            0.0
        } else {
            CLOSE_UNLATCH_PHI_RAD * ((0.45 - th) / 0.20).clamp(0.0, 1.0)
        };
        let g_step = if th > 0.55 {
            HANDLE_POCKET_SWING_M + 0.002
        } else {
            let f = ((0.55 - th) / 0.20).clamp(0.0, 1.0);
            (HANDLE_POCKET_SWING_M + 0.002)
                + f * (HANDLE_POCKET_CLAMP_M - (HANDLE_POCKET_SWING_M + 0.002))
        };
        let (pk, rk) = handle_grasp_target(hinge, th, ph, 0.0, 0.0, 0.0);
        let qk = solve_handle_ik(st, handle_site, pk, &rk, q_prev);
        st.move_joints(qk, g_step, false, 0.72, 0.14, 0.0)?;
        q_prev = qk;
    }

    // Gently seat door flush against the closed stop (`th = -0.008 rad`) while handle is still
    // twisted clear of the catch, so the pawl is completely behind `mbco4_latch_catch_col`
    // before untwisting.
    let (p_seat, r_seat) = handle_grasp_target(hinge, -0.008, CLOSE_UNLATCH_PHI_RAD, 0.0, 0.0, 0.0);
    let q_seat = solve_handle_ik(st, handle_site, p_seat, &r_seat, q_prev);
    st.move_joints(q_seat, HANDLE_POCKET_CLAMP_M, false, 0.50, 0.18, 0.12)?;
    q_prev = q_seat;

    // Gently untwist the handle back to `0.0 rad` while holding the door closed (`th = 0.0`)
    // and relaxing pinch force, so the pawl drops cleanly behind `mbco4_latch_catch_col`
    // and physically re-latches BEFORE releasing and retracting.
    let n_untwist = 10usize;
    for k in 1..=n_untwist {
        let frac = k as f64 / n_untwist as f64;
        let ph = CLOSE_UNLATCH_PHI_RAD * (1.0 - frac);
        let g_rel = HANDLE_POCKET_CLAMP_M + frac * (0.002 - HANDLE_POCKET_CLAMP_M);
        let (pk, rk) = handle_grasp_target(hinge, 0.0, ph, 0.0, 0.0, 0.0);
        let qk = solve_handle_ik(st, handle_site, pk, &rk, q_prev);
        st.move_joints(qk, g_rel, false, 0.70, 0.08, 0.0)?;
        q_prev = qk;
    }
    st.actuate_gripper(HANDLE_POCKET_OPEN_M, false, 0.45, 0.36, "handle_open")?;
    // Drop below the bottom tip of the vertical handle bar with slight +X/+out clearance
    // so neither the anvil (+X) nor the back-hook (+Y) grazes the handle bar on retract.
    let (p_dn, r_dn) = handle_grasp_target(hinge, 0.0, 0.0, 0.010, 0.014, -0.044);
    let q_dn = solve_handle_ik(st, handle_site, p_dn, &r_dn, q_prev);
    let (p_r0, r_r0) = handle_grasp_target(hinge, 0.0, 0.0, 0.10, 0.014, -0.044);
    let q_r0 = solve_handle_ik(st, handle_site, p_r0, &r_r0, q_dn);
    let (p_ret, r_ret) = handle_grasp_target(hinge, 0.0, 0.0, 0.24, 0.0, -0.02);
    let q_ret = solve_handle_ik(st, handle_site, p_ret, &r_ret, q_r0);
    st.move_joints(q_dn, HANDLE_POCKET_OPEN_M, false, 0.75, 0.30, 0.04)?;
    st.move_joints(q_r0, HANDLE_POCKET_OPEN_M, false, 0.85, 0.35, 0.04)?;
    st.move_joints(q_ret, HANDLE_POCKET_OPEN_M, false, 0.90, 0.40, 0.04)?;
    st.move_joints(q_mid, st.nom.open_jaw_m, false, 1.05, 0.45, 0.04)?;
    st.move_joints(home_q, st.nom.open_jaw_m, false, 1.15, 0.55, 0.20)?;
    Ok(())
}

/// Run an MBCO-4ME door actuation operation (`Open`, `Close`, `ClosedOvenLoad`,
/// or `NoTwistPull`) on any [`ClosedLoopPlant`].
pub fn run_door_operation<P: ClosedLoopPlant + ?Sized>(
    cfg: &ClosedLoopConfig,
    home_q: [f64; 6],
    cam: CameraModel,
    op: DoorOp,
    use_perception: bool,
    initial_door_rad: f64,
    plant: &mut P,
) -> Result<(&'static str, &'static str)> {
    let mut nom = NominalDynamics::load(cfg)?;
    let handle_site = nom
        .handle_grasp_site
        .context("Model lacks `cell_handle_grasp` site required for door actuation")?;
    let mut st = ControllerState::new(cfg, &mut nom, plant, cam)?;
    let res = match op {
        DoorOp::Open => {
            execute_door_open(&mut st, handle_site, home_q, use_perception, true).map(|_| ())
        }
        DoorOp::NoTwistPull => {
            execute_door_open(&mut st, handle_site, home_q, use_perception, false).map(|_| ())
        }
        DoorOp::Close => execute_door_close(
            &mut st,
            handle_site,
            home_q,
            use_perception,
            if initial_door_rad > 0.3 {
                initial_door_rad
            } else {
                TARGET_OPEN_THETA_RAD
            },
            None,
        ),
        DoorOp::ClosedOvenLoad => {
            execute_door_open(&mut st, handle_site, home_q, use_perception, true).and_then(
                |hinge| {
                    run_spanner_load(&mut st, home_q)?;
                    execute_door_close(
                        &mut st,
                        handle_site,
                        home_q,
                        use_perception,
                        TARGET_OPEN_THETA_RAD,
                        Some(hinge),
                    )
                },
            )
        }
    };
    Ok(st.finish(res))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_target_is_proper_so3_on_hinge_arc() {
        for deg in (0..=108).step_by(12) {
            let th = (deg as f64).to_radians();
            for ph in [0.0, UNLATCH_PHI_RAD, CLOSE_UNLATCH_PHI_RAD] {
                let (pos, rot) = handle_grasp_target(NOM_HINGE_WORLD, th, ph, 0.0, 0.0, 0.0);
                let m = Matrix3::from_row_slice(&rot);
                assert!((m.determinant() - 1.0).abs() < 1e-12);
                assert!(((m.transpose() * m) - Matrix3::identity()).norm() < 1e-12);
                let dx = pos[0] - NOM_HINGE_WORLD[0];
                let dy = pos[1] - NOM_HINGE_WORLD[1];
                let r = (dx * dx + dy * dy).sqrt();
                assert!(
                    (0.46..=0.56).contains(&r),
                    "unexpected arc radius {r} at {deg} deg"
                );
            }
        }
    }
}
