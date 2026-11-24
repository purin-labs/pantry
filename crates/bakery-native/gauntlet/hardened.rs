//! Hardened unprivileged closed-loop Rust controller (`--mode hardened`).
//!
//! Built directly on `bakery_native::ik::solve`, `bakery_native::servo::command`,
//! and the verified production nominal `bakery_native` MJCF model.
//! Reads ONLY allowlisted deployment keys (`joint_position/*`, `overhead_cam`,
//! `overhead_cam_depth`, `overhead_cam_timestamp`) over `GAUNTLET_URL`.
//!
//! Handles:
//! - T1/T2 tray XY/yaw, oven/rack/table XY, table Z/tilt, mass/friction/gain/gravcomp
//! - T3 mid-approach push & lift slip re-perception + re-grasp recovery
//! - T4 `camera_freeze` (frozen or restamped) & `dead_gripper` safe abort

use anyhow::{Result, bail};
use bakery_native::{
    artifact::BakeryTask,
    assets::{Assets, Cell},
    robot::Robot,
};

use crate::{
    http::{GauntletClient, StepMeas, StepReply},
    perception::{
        CameraModel, Cloud, FaultMonitor, PlaneCal, RoiBox, calibrate_table_plane,
        measure_ee_z_offset, perceive_fixture_target, perceive_table_target, perceive_tray,
    },
    shipped::{NominalDynamics, TaskConfig, open_shipped_operation},
};

#[derive(Debug)]
enum EpisodeStop {
    EpisodeOver,
    Abort(&'static str),
}

struct ControllerState<'a> {
    cfg: &'a TaskConfig,
    nom: &'a mut NominalDynamics,
    client: &'a GauntletClient,
    cam: CameraModel,
    meas: StepMeas,
    last_rgb: Vec<u8>,
    cmd_q: [f64; 6],
    cmd_g: f64,
    carrying: bool,
    tick: usize,
    monitor: FaultMonitor,
}

impl<'a> ControllerState<'a> {
    fn step_to(
        &mut self,
        q_cmd: [f64; 6],
        g_cmd: f64,
        carrying: bool,
        check_grip: Option<&str>,
    ) -> Result<(), EpisodeStop> {
        let ctrl = self.nom.servo_ctrl(&self.meas.q, &q_cmd, carrying);
        let reply = match self.client.step(&ctrl, g_cmd) {
            Ok(r) => r,
            Err(_) => return Err(EpisodeStop::EpisodeOver),
        };
        let next = match reply {
            StepReply::Meas(m) => m,
            StepReply::EpisodeOver => return Err(EpisodeStop::EpisodeOver),
        };
        self.meas = next;
        self.cmd_q = q_cmd;
        self.cmd_g = g_cmd;
        self.carrying = carrying;
        self.tick += 1;

        let ts = self
            .meas
            .cam_timestamp
            .unwrap_or(self.tick as f64 * self.cfg.control_dt_s);
        let rgb = match self.client.read_rgb("overhead_cam") {
            Ok((_, _, buf)) => buf,
            Err(_) => return Err(EpisodeStop::EpisodeOver),
        };
        let fault = self
            .monitor
            .update(ts, &rgb, &self.meas.q, self.meas.gripper, check_grip);
        self.last_rgb = rgb;
        if let Some(fault) = fault {
            return Err(EpisodeStop::Abort(fault));
        }
        Ok(())
    }

    fn read_rgbd_cloud(&self) -> Result<Cloud, EpisodeStop> {
        let (h, w, depth) = match self.client.read_depth("overhead_cam_depth") {
            Ok(d) => d,
            Err(_) => return Err(EpisodeStop::EpisodeOver),
        };
        Ok(self.cam.deproject(&depth, &self.last_rgb, h, w))
    }

    fn solve_ik(&mut self, target: [f64; 3], yaw_rad: f64, q_seed: [f64; 6]) -> [f64; 6] {
        let is_fr10_spanner = self.nom.is_spanner && self.cfg.robot == Robot::FairinoFr10;
        let branch_ok = |q: &[f64; 6]| -> bool {
            if !is_fr10_spanner {
                return true;
            }
            (-2.20..=-0.35).contains(&q[1])
                && (0.35..=2.65).contains(&q[2])
                && (q[5] - std::f64::consts::FRAC_PI_2).abs() < 0.35
        };

        if let Some(q) = self.nom.solve_ik_yaw(target, yaw_rad, q_seed)
            && branch_ok(&q)
        {
            return q;
        }
        if is_fr10_spanner {
            let des_x = [-yaw_rad.sin(), yaw_rad.cos()];
            let wx = target[0] - 0.240 * des_x[0];
            let wy = target[1] - 0.240 * des_x[1];
            let dx = wx - self.nom.robot_mount[0];
            let dy = wy - self.nom.robot_mount[1];
            let j1 = (-dx).atan2(dy.max(0.05));
            let j5 = std::f64::consts::FRAC_PI_2 + j1 - yaw_rad;
            let seeds = [
                [j1, -1.15, 2.00, -0.85, j5, std::f64::consts::FRAC_PI_2],
                [j1, -0.85, 1.55, -0.70, j5, std::f64::consts::FRAC_PI_2],
                [j1, -1.45, 2.25, -0.80, j5, std::f64::consts::FRAC_PI_2],
                [
                    -22.0_f64.to_radians(),
                    -96.0_f64.to_radians(),
                    124.0_f64.to_radians(),
                    -28.0_f64.to_radians(),
                    68.0_f64.to_radians(),
                    90.0_f64.to_radians(),
                ],
            ];
            for seed in seeds {
                if let Some(q) = self.nom.solve_ik_yaw(target, yaw_rad, seed)
                    && branch_ok(&q)
                {
                    return q;
                }
            }
        }
        self.nom
            .solve_ik_yaw(target, yaw_rad, q_seed)
            .unwrap_or(q_seed)
    }

    fn move_joints(
        &mut self,
        q_target: [f64; 6],
        g_target: f64,
        carrying: bool,
        max_rad_per_s: f64,
        min_s: f64,
        settle_s: f64,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let q_start = self.cmd_q;
        let g_start = self.cmd_g;
        let max_d = q_target
            .iter()
            .zip(&q_start)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max);
        let max_step_rad = (max_rad_per_s * dt).max(0.005);
        let min_ticks = (min_s / dt).round().max(4.0) as usize;
        let n_steps = ((max_d / max_step_rad).ceil() as usize).max(min_ticks);
        for i in 1..=n_steps {
            let s = 0.5 * (1.0 - (std::f64::consts::PI * i as f64 / n_steps as f64).cos());
            let q_i = std::array::from_fn(|k| q_start[k] + s * (q_target[k] - q_start[k]));
            let g_i = g_start + s * (g_target - g_start);
            self.step_to(q_i, g_i, carrying, None)?;
        }
        let settle_ticks = (settle_s / dt).round() as usize;
        for _ in 0..settle_ticks {
            self.step_to(q_target, g_target, carrying, None)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn move_cartesian(
        &mut self,
        p_start: [f64; 3],
        p_end: [f64; 3],
        yaw_start: f64,
        yaw_end: f64,
        g_target: f64,
        carrying: bool,
        step_m: f64,
        max_rad_per_s: f64,
        settle_s: f64,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let dist = ((p_end[0] - p_start[0]).powi(2)
            + (p_end[1] - p_start[1]).powi(2)
            + (p_end[2] - p_start[2]).powi(2))
        .sqrt();
        let n_wp = ((dist / step_m).ceil() as usize).max(2);
        let max_step_rad = (max_rad_per_s * dt).max(0.005);
        let mut q_prev = self.cmd_q;
        for k in 1..=n_wp {
            let s = 0.5 * (1.0 - (std::f64::consts::PI * k as f64 / n_wp as f64).cos());
            let p_k = [
                p_start[0] + s * (p_end[0] - p_start[0]),
                p_start[1] + s * (p_end[1] - p_start[1]),
                p_start[2] + s * (p_end[2] - p_start[2]),
            ];
            let y_k = yaw_start + s * (yaw_end - yaw_start);
            let q_k = self.solve_ik(p_k, y_k, q_prev);
            let max_dq = q_k
                .iter()
                .zip(&q_prev)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f64, f64::max);
            let sub = ((max_dq / max_step_rad).ceil() as usize).max(1);
            for j in 1..=sub {
                let frac = j as f64 / sub as f64;
                let q_j = std::array::from_fn(|idx| q_prev[idx] + frac * (q_k[idx] - q_prev[idx]));
                self.step_to(q_j, g_target, carrying, None)?;
            }
            q_prev = q_k;
        }
        let settle_ticks = (settle_s / dt).round() as usize;
        for _ in 0..settle_ticks {
            self.step_to(q_prev, g_target, carrying, None)?;
        }
        Ok(())
    }

    fn actuate_gripper(
        &mut self,
        g_target: f64,
        carrying: bool,
        ramp_s: f64,
        hold_s: f64,
        mode: &str,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let q_hold = self.cmd_q;
        let g_start = self.cmd_g;
        let ticks = (ramp_s / dt).round().max(8.0) as usize;
        for i in 1..=ticks {
            let s = i as f64 / ticks as f64;
            self.step_to(q_hold, g_start + s * (g_target - g_start), carrying, None)?;
        }
        let hold_ticks = (hold_s / dt).round().max(18.0) as usize;
        for _ in 0..hold_ticks {
            self.step_to(q_hold, g_target, carrying, Some(mode))?;
        }
        Ok(())
    }

    fn measure_spanner_z(
        &mut self,
        cal: PlaneCal,
        target_xy: [f64; 2],
        yaw_rad: f64,
    ) -> Result<f64, EpisodeStop> {
        let cloud = self.read_rgbd_cloud()?;
        let site_fk = self.nom.fk_grasp(&self.cmd_q);
        // Spanner beam top sits +0.064 + 0.0085 = +0.0725 m above `cell_grasp`
        let z_beam_fk = site_fk[2] + 0.0725;
        let along = [-yaw_rad.sin(), yaw_rad.cos()];
        Ok(measure_ee_z_offset(
            &self.cam, &cloud, cal, target_xy, along, z_beam_fk, 0.024, -0.09, 0.14,
        ))
    }

    fn measure_fork_z(
        &mut self,
        cal: PlaneCal,
        grasp_xy: [f64; 2],
        yaw_rad: f64,
    ) -> Result<f64, EpisodeStop> {
        let cloud = self.read_rgbd_cloud()?;
        let site_fk = self.nom.fk_grasp(&self.cmd_q);
        // `clamp_bridge` rides on `cell_upper_jaw`: top is +0.045 + clamp_opening above `cell_grasp`
        let along = [yaw_rad.cos(), yaw_rad.sin()];
        let bridge_xy = [
            grasp_xy[0] - 0.095 * along[0],
            grasp_xy[1] - 0.095 * along[1],
        ];
        let z_bridge_fk = site_fk[2] + 0.045 + self.meas.gripper;
        Ok(measure_ee_z_offset(
            &self.cam,
            &cloud,
            cal,
            bridge_xy,
            along,
            z_bridge_fk,
            0.16,
            -0.022,
            0.022,
        ))
    }
}

/// Hardened FR10 + Maruzen MBCO-4ME spanner-oven tray loading (`table-to-oven`).
fn run_spanner_load(st: &mut ControllerState<'_>, home_q: [f64; 6]) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src = st.nom.source_site;
    let nom_dest = st.nom.dest_site;
    let table_z_nom = nom_src[2] - 0.0005;

    let table_roi = RoiBox {
        x_min: 0.06,
        x_max: 0.88,
        y_min: -0.50,
        y_max: 0.14,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let tray_roi = RoiBox {
        x_min: 0.04,
        x_max: 0.82,
        y_min: -0.52,
        y_max: 0.14,
        z_min: 0.008,
        z_max: 0.050,
    };
    let oven_roi = RoiBox {
        x_min: -0.92,
        x_max: 0.08,
        y_min: -0.32,
        y_max: 0.65,
        z_min: 1.418,
        z_max: 1.460,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let (mut tx, mut ty, mut tz, mut tyaw) =
        match perceive_tray(&st.cam, &cloud0, cal, tray_roi, table_z_nom, 0.28, true) {
            Some(p) => (p.cx, p.cy, p.z_table, p.yaw_rad),
            None => (nom_src[0], nom_src[1], table_z_nom, 0.0),
        };
    let rail2_target = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        oven_roi,
        [-0.4001, 0.1400, 1.4300],
        nom_dest,
        0.012,
    );

    let mut dz_prep = 0.0;
    let mut x_prep_cal = tx;
    let slide_z_off = 0.042;
    let mut p_corridor = [0.04, -0.52, (rail2_target[2] + slide_z_off).max(tz + 0.30)];

    // Step away from `mbco4_right_cabinet_col` (+X, -Y) first so perturbed oven
    // poses never scrape the rear jaw when leaving the production ready pose.
    let cur_p0 = st.nom.fk_grasp(&st.cmd_q);
    let p_clear0 = [cur_p0[0] + 0.10, cur_p0[1] - 0.14, cur_p0[2] + 0.02];
    st.move_cartesian(cur_p0, p_clear0, 0.0, 0.0, open_g, false, 0.020, 1.0, 0.04)?;

    for attempt in 0..2 {
        let p_hover = [tx, ty, tz + 0.160];
        let q_hover = st.solve_ik(p_hover, tyaw, st.cmd_q);
        st.move_joints(q_hover, open_g, false, 1.15, 0.20, 0.28)?;
        dz_prep = st.measure_spanner_z(cal, [tx, ty], tyaw)?;

        // Probe to +68 mm above tray (triggers any T3 `push`), then swing clear to re-perceive!
        let p_probe = [tx, ty, tz + 0.068 - dz_prep];
        st.move_cartesian(
            p_hover, p_probe, tyaw, tyaw, open_g, false, 0.016, 1.0, 0.24,
        )?;
        st.move_cartesian(
            p_probe, p_hover, tyaw, tyaw, open_g, false, 0.020, 1.0, 0.04,
        )?;

        let p_peek = [0.16, -0.68, 1.30];
        st.move_cartesian(p_hover, p_peek, tyaw, 0.0, open_g, false, 0.026, 1.2, 0.12)?;
        let cloud_re = st.read_rgbd_cloud()?;
        if let Some(p) = perceive_tray(&st.cam, &cloud_re, cal, tray_roi, table_z_nom, 0.28, true) {
            tx = p.cx;
            ty = p.cy;
            tz = p.z_table;
            tyaw = p.yaw_rad;
        }
        // +7 mm along tool +Y doubles rear-rim clearance (5 mm -> 12 mm) on high-yaw descents
        // while keeping 38 mm clearance on the open front jaw.
        let des_y = [-tyaw.sin(), tyaw.cos()];
        let gx = tx + 0.007 * des_y[0];
        let gy = ty + 0.007 * des_y[1];
        let p_hover2 = [gx, gy, tz + 0.160];
        st.move_cartesian(p_peek, p_hover2, 0.0, tyaw, open_g, false, 0.026, 1.2, 0.28)?;
        dz_prep = st.measure_spanner_z(cal, [gx, gy], tyaw)?;
        x_prep_cal = gx;

        // Two-stage gentle touch-down to calibrated grasp height (`+13 mm` above table:
        // clears `table_top` at ±1.5 deg tilt while engaging 8.5 mm of the 20.5 mm rim).
        let p_pre_grasp = [gx, gy, tz + 0.045 - dz_prep];
        let p_grasp = [gx, gy, tz + 0.0130 - dz_prep];
        st.move_cartesian(
            p_hover2,
            p_pre_grasp,
            tyaw,
            tyaw,
            open_g,
            false,
            0.010,
            0.90,
            0.04,
        )?;
        st.move_cartesian(
            p_pre_grasp,
            p_grasp,
            tyaw,
            tyaw,
            open_g,
            false,
            0.004,
            0.55,
            0.16,
        )?;

        // Smooth silicone pinch (<= 15.5 N) with T4 `dead_gripper` check
        st.actuate_gripper(close_g, false, 0.65, 0.36, "close")?;

        // Smooth lift +30 cm (covers 0.15 s T3 `slip` pull!)
        let lift_z = (tz + 0.300).max(rail2_target[2] + slide_z_off) - dz_prep;
        let p_lifted = [p_grasp[0], p_grasp[1], lift_z];
        st.move_cartesian(
            p_grasp, p_lifted, tyaw, tyaw, close_g, true, 0.010, 0.9, 0.26,
        )?;

        // Pull back in -Y BEFORE traversing -X so shifted trays never brush the oven front-right corner!
        let p_pull = [p_lifted[0].max(0.32), -0.52, lift_z];
        st.move_cartesian(
            p_lifted, p_pull, tyaw, 0.0, close_g, true, 0.016, 0.90, 0.06,
        )?;

        p_corridor = [
            0.04,
            -0.52,
            (rail2_target[2] + slide_z_off).max(tz + 0.30) - 0.5 * dz_prep,
        ];
        st.move_cartesian(
            p_pull, p_corridor, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.12,
        )?;

        if attempt == 0 {
            let cloud_chk = st.read_rgbd_cloud()?;
            if let Some(left) =
                perceive_tray(&st.cam, &cloud_chk, cal, tray_roi, table_z_nom, 0.28, true)
            {
                // Tray slipped back onto prep table! Open, re-localize, and re-grasp.
                st.actuate_gripper(open_g, false, 0.32, 0.36, "open")?;
                tx = left.cx;
                ty = left.cy;
                tz = left.z_table;
                tyaw = left.yaw_rad;
                continue;
            }
        }
        break;
    }

    // Stage 2: Align outside MBCO-4ME mouth (extra 4 mm margin to rear baffle stop)
    let rail2_grip = [
        rail2_target[0],
        rail2_target[1] - 0.009,
        rail2_target[2] + 0.011,
    ];
    let slide_z = (rail2_target[2] + slide_z_off).max(tz + 0.30);
    let p_mouth_raw = [rail2_grip[0], rail2_grip[1] - 0.50, slide_z];
    st.move_cartesian(
        p_corridor,
        p_mouth_raw,
        0.0,
        0.0,
        close_g,
        true,
        0.014,
        0.95,
        0.26,
    )?;

    let dz_oven = st.measure_spanner_z(cal, [p_mouth_raw[0], p_mouth_raw[1]], 0.0)?;
    let sin_tilt =
        ((dz_prep - dz_oven) / (x_prep_cal - p_mouth_raw[0]).max(0.4)).clamp(-0.04, 0.04);
    let dx_oven = (-(rail2_grip[2] - st.nom.robot_mount[2]) * sin_tilt).clamp(-0.014, 0.014);
    let p_mouth = [
        rail2_grip[0] - dx_oven,
        rail2_grip[1] - 0.48,
        slide_z - dz_oven,
    ];
    st.move_cartesian(
        p_mouth_raw,
        p_mouth,
        0.0,
        0.0,
        close_g,
        true,
        0.008,
        0.8,
        0.08,
    )?;

    // Stage 3: Linear slide insertion into MBCO-4ME Rail #2 & `transfer.rs` seating (+4 mm)
    let p_over_rail2 = [rail2_grip[0] - dx_oven, rail2_grip[1], slide_z - dz_oven];
    st.move_cartesian(
        p_mouth,
        p_over_rail2,
        0.0,
        0.0,
        close_g,
        true,
        0.010,
        0.85,
        0.12,
    )?;

    let p_seat = [
        rail2_grip[0] - dx_oven,
        rail2_grip[1],
        rail2_grip[2] + 0.004 - dz_oven,
    ];
    st.move_cartesian(
        p_over_rail2,
        p_seat,
        0.0,
        0.0,
        close_g,
        true,
        0.004,
        0.7,
        0.16,
    )?;

    // Stage 4: Release, clear rear rim (+4 mm +Y), lift inside chamber, retract cleanly to home
    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_clear_rear = [p_seat[0], p_seat[1] + 0.004, p_seat[2]];
    st.move_cartesian(
        p_seat,
        p_clear_rear,
        0.0,
        0.0,
        open_g,
        false,
        0.004,
        0.7,
        0.08,
    )?;
    let p_up = [
        p_clear_rear[0],
        p_clear_rear[1],
        rail2_grip[2] + 0.049 - dz_oven,
    ];
    st.move_cartesian(
        p_clear_rear,
        p_up,
        0.0,
        0.0,
        open_g,
        false,
        0.008,
        0.85,
        0.08,
    )?;
    let p_out = [p_up[0], rail2_grip[1] - 0.48, p_up[2]];
    st.move_cartesian(p_up, p_out, 0.0, 0.0, open_g, false, 0.016, 1.0, 0.08)?;
    let p_back = [0.16, -0.54, 1.28];
    st.move_cartesian(p_out, p_back, 0.0, 0.0, open_g, false, 0.022, 1.1, 0.04)?;
    st.move_joints(home_q, open_g, false, 1.15, 0.20, 0.20)?;
    Ok(())
}

/// Hardened FR10 + Maruzen MBCO-4ME tray retrieval (`oven-to-table`).
fn run_spanner_unload(st: &mut ControllerState<'_>) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src_table = st.nom.source_site;
    let table_z_nom = nom_src_table[2] - 0.0005;
    let nom_rail2 = [-0.49, 0.0, 1.1155];

    let table_roi = RoiBox {
        x_min: 0.02,
        x_max: 1.06,
        y_min: -0.58,
        y_max: 0.22,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let oven_roi = RoiBox {
        x_min: -0.92,
        x_max: 0.08,
        y_min: -0.32,
        y_max: 0.65,
        z_min: 1.418,
        z_max: 1.460,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let rail2_pos = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        oven_roi,
        [-0.4001, 0.1400, 1.4300],
        nom_rail2,
        0.012,
    );
    // Track prep-table XY/Z shifts (`dest_xy_m` on T1/T2) from bare stainless table
    let table_target = perceive_table_target(
        &st.cam,
        &cloud0,
        cal,
        table_roi,
        [0.4757, -0.1774, table_z_nom],
        nom_src_table,
    );

    // Measure beam Z offset right at starting pose outside oven mouth
    let cur_p = st.nom.fk_grasp(&st.cmd_q);
    let p_mouth = [rail2_pos[0], rail2_pos[1] - 0.48, rail2_pos[2] + 0.060];
    st.move_cartesian(cur_p, p_mouth, 0.0, 0.0, open_g, false, 0.014, 1.0, 0.24)?;
    let dz_oven = st.measure_spanner_z(cal, [p_mouth[0], p_mouth[1]], 0.0)?;
    let p_mouth_cal = [
        rail2_pos[0],
        rail2_pos[1] - 0.48,
        rail2_pos[2] + 0.060 - dz_oven,
    ];
    st.move_cartesian(
        p_mouth,
        p_mouth_cal,
        0.0,
        0.0,
        open_g,
        false,
        0.008,
        0.8,
        0.08,
    )?;

    // Enter oven above tray, lower onto rim (matches `transfer.rs:324`), clamp, lift, extract
    let p_enter = [rail2_pos[0], rail2_pos[1], rail2_pos[2] + 0.060 - dz_oven];
    st.move_cartesian(
        p_mouth_cal,
        p_enter,
        0.0,
        0.0,
        open_g,
        false,
        0.012,
        0.9,
        0.10,
    )?;
    let p_seat = [rail2_pos[0], rail2_pos[1], rail2_pos[2] + 0.011 - dz_oven];
    st.move_cartesian(p_enter, p_seat, 0.0, 0.0, open_g, false, 0.005, 0.75, 0.14)?;
    st.actuate_gripper(close_g, false, 0.65, 0.36, "close")?;

    let slide_z = rail2_pos[2] + 0.042 - dz_oven;
    let p_lift = [rail2_pos[0], rail2_pos[1], slide_z];
    st.move_cartesian(p_seat, p_lift, 0.0, 0.0, close_g, true, 0.008, 0.85, 0.16)?;
    let p_extract = [rail2_pos[0], rail2_pos[1] - 0.48, slide_z];
    st.move_cartesian(p_lift, p_extract, 0.0, 0.0, close_g, true, 0.012, 0.9, 0.10)?;

    // Carry via front corridor to prep table + re-calibrate Z before setting down
    let p_corr = [0.04, -0.48, slide_z];
    st.move_cartesian(
        p_extract, p_corr, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.08,
    )?;
    let dest_grip = [
        table_target[0],
        table_target[1] - 0.005,
        table_target[2] + 0.011,
    ];
    let p_over_tbl = [dest_grip[0], dest_grip[1], slide_z];
    st.move_cartesian(
        p_corr, p_over_tbl, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.24,
    )?;
    let dz_prep = st.measure_spanner_z(cal, [p_over_tbl[0], p_over_tbl[1]], 0.0)?;
    let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] + 0.004 - dz_prep];
    st.move_cartesian(
        p_over_tbl, p_place, 0.0, 0.0, close_g, true, 0.006, 0.75, 0.16,
    )?;

    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_clear = [p_place[0], p_place[1] + 0.004, p_place[2]];
    st.move_cartesian(p_place, p_clear, 0.0, 0.0, open_g, false, 0.004, 0.7, 0.06)?;
    let p_up = [p_clear[0], p_clear[1], dest_grip[2] + 0.16 - dz_prep];
    st.move_cartesian(p_clear, p_up, 0.0, 0.0, open_g, false, 0.012, 0.9, 0.20)?;
    Ok(())
}

/// Hardened fork-clamp controller for `combined` (`table-to-oven`, `table-to-rack`),
/// `separate` (`table-to-rack`), and `pan-staging` (UR5e, CRX-10iA/L, FR10).
fn run_fork_transfer(st: &mut ControllerState<'_>) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src = st.nom.source_site;
    let nom_dest = st.nom.dest_site;
    let table_z_nom = nom_src[2] - 0.001;
    let is_oven = st.cfg.task == BakeryTask::Oven;

    let table_roi = RoiBox {
        x_min: nom_src[0] - 0.14,
        x_max: nom_src[0] + 0.56,
        y_min: nom_src[1] - 0.30,
        y_max: nom_src[1] + 0.30,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let tray_roi = RoiBox {
        x_min: nom_src[0] - 0.40,
        x_max: nom_src[0] + 0.42,
        y_min: nom_src[1] - 0.36,
        y_max: nom_src[1] + 0.33,
        z_min: 0.008,
        z_max: 0.060,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let (mut tx, mut ty, mut tz, mut tyaw) =
        match perceive_tray(&st.cam, &cloud0, cal, tray_roi, table_z_nom, 0.38, true) {
            Some(p) => (p.cx, p.cy, p.z_table, p.yaw_rad),
            None => (nom_src[0], nom_src[1], table_z_nom, 0.0),
        };

    let dest_target = if is_oven {
        // Measured `mbco_oven` roof OBB sits at `dest_site + [0.038, -0.064, 0.348]`
        let nom_roof = [
            nom_dest[0] + 0.038,
            nom_dest[1] - 0.064,
            nom_dest[2] + 0.348,
        ];
        let oven_roi = RoiBox {
            x_min: nom_roof[0] - 0.36,
            x_max: nom_roof[0] + 0.36,
            y_min: nom_roof[1] - 0.44,
            y_max: nom_roof[1] + 0.44,
            z_min: nom_roof[2] - 0.04,
            z_max: nom_roof[2] + 0.06,
        };
        perceive_fixture_target(&st.cam, &cloud0, cal, oven_roi, nom_roof, nom_dest, 0.020)
    } else {
        let nom_rack = if st.cfg.cell == Cell::Combined {
            [
                nom_dest[0] - 0.0042,
                nom_dest[1] + 0.0037,
                nom_dest[2] - 0.001,
            ]
        } else {
            [
                nom_dest[0] - 0.0041,
                nom_dest[1] + 0.1925,
                nom_dest[2] - 0.001,
            ]
        };
        let rack_roi = RoiBox {
            x_min: nom_dest[0] - 0.42,
            x_max: nom_dest[0] + 0.42,
            y_min: nom_dest[1] - 0.30,
            y_max: nom_dest[1] + 0.30,
            z_min: nom_dest[2] - 0.04,
            z_max: nom_dest[2] + 0.04,
        };
        perceive_fixture_target(&st.cam, &cloud0, cal, rack_roi, nom_rack, nom_dest, 0.020)
    };

    let clearance = if is_oven { 0.50 } else { 0.32 };
    let table_left_x = nom_src[0] - 0.06; // `table_top` left vertical edge (`0.99 m`)
    let mut cur_p = st.nom.fk_grasp(&st.cmd_q);
    let mut dz_prep = 0.0;
    let mut seat_off = 0.25;
    let mut p_lifted = [nom_src[0] - 0.25, nom_src[1], table_z_nom + clearance];

    for attempt in 0..2 {
        let ux = tyaw.cos();
        let uy = tyaw.sin();
        // Start from current pose: open jaw and calibrate Z while clear of the tray!
        let p_cal = [tx - 0.50 * ux, ty - 0.50 * uy, tz + 0.024];
        st.move_cartesian(cur_p, p_cal, 0.0, tyaw, open_g, false, 0.018, 0.85, 0.24)?;
        dz_prep = st.measure_fork_z(cal, [p_cal[0], p_cal[1]], tyaw)?;

        // Drop vertically to 3 mm BELOW tray underside (`tz - 0.003`) while 25 cm clear,
        // then slide horizontally into T3 `push` trigger zone (never colliding with tray front rim!)
        let p_low = [tx - 0.50 * ux, ty - 0.50 * uy, tz - 0.003 - dz_prep];
        st.move_cartesian(p_cal, p_low, tyaw, tyaw, open_g, false, 0.010, 0.80, 0.08)?;
        let p_probe = [tx - 0.40 * ux, ty - 0.40 * uy, tz - 0.003 - dz_prep];
        st.move_cartesian(p_low, p_probe, tyaw, tyaw, open_g, false, 0.012, 0.80, 0.22)?;
        st.move_cartesian(p_probe, p_low, tyaw, tyaw, open_g, false, 0.015, 0.85, 0.12)?;

        // Re-perceive tray after T3 `push` window
        let cloud_re = st.read_rgbd_cloud()?;
        if let Some(p) = perceive_tray(&st.cam, &cloud_re, cal, tray_roi, table_z_nom, 0.38, true) {
            tx = p.cx;
            ty = p.cy;
            tz = p.z_table;
            tyaw = p.yaw_rad;
        }
        let ux = tyaw.cos();
        let uy = tyaw.sin();
        // Keep both rotated fork tips (`+0.15` along fork, `±0.14` lateral) at least 15 mm
        // clear of `table_top`'s vertical left edge (`table_left_x`) on shifted/rotated trays!
        let max_tip_x_nom = (tx - 0.25 * ux) + 0.15 * ux + 0.14 * uy.abs();
        let backoff = (max_tip_x_nom - (table_left_x - 0.015)).clamp(0.0, 0.085);
        seat_off = 0.25 + backoff;
        let p_seat = [tx - seat_off * ux, ty - seat_off * uy, tz - dz_prep];
        let p_pre = [
            p_seat[0] - 0.25 * ux,
            p_seat[1] - 0.25 * uy,
            tz - 0.003 - dz_prep,
        ];
        st.move_cartesian(p_low, p_pre, tyaw, tyaw, open_g, false, 0.014, 0.85, 0.10)?;

        // Slide forks cleanly under tray overhang, lift +3 mm to seat, clamp!
        let p_ins = [p_seat[0], p_seat[1], tz - 0.003 - dz_prep];
        st.move_cartesian(p_pre, p_ins, tyaw, tyaw, open_g, false, 0.010, 0.75, 0.10)?;
        st.move_cartesian(p_ins, p_seat, tyaw, tyaw, open_g, false, 0.003, 0.65, 0.12)?;
        st.actuate_gripper(close_g, false, 0.55, 0.36, "close")?;

        p_lifted = [p_seat[0], p_seat[1], tz + clearance - dz_prep];
        st.move_cartesian(
            p_seat, p_lifted, tyaw, tyaw, close_g, true, 0.014, 0.75, 0.24,
        )?;

        // Clear prep table along -X (matches `transfer.rs:540`) to check T3 `slip`
        let p_clear_src = [p_lifted[0] - 0.25, p_lifted[1], p_lifted[2]];
        st.move_cartesian(
            p_lifted,
            p_clear_src,
            tyaw,
            0.0,
            close_g,
            true,
            0.016,
            0.80,
            0.14,
        )?;
        cur_p = p_clear_src;
        p_lifted = p_clear_src;

        if attempt == 0 {
            let cloud_chk = st.read_rgbd_cloud()?;
            if let Some(left) =
                perceive_tray(&st.cam, &cloud_chk, cal, tray_roi, table_z_nom, 0.38, true)
            {
                st.actuate_gripper(open_g, false, 0.35, 0.36, "open")?;
                tx = left.cx;
                ty = left.cy;
                tz = left.z_table;
                tyaw = left.yaw_rad;
                continue;
            }
        }
        break;
    }

    let dest_grip = [
        dest_target[0] - seat_off,
        dest_target[1],
        dest_target[2] - 0.001,
    ];
    if is_oven {
        let outside_x = (nom_src[0] - 0.25) - 0.37;
        let p_trans = [
            p_lifted[0],
            dest_grip[1],
            dest_grip[2] + clearance - dz_prep,
        ];
        st.move_cartesian(
            p_lifted, p_trans, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.10,
        )?;
        let p_front_hi = [outside_x, dest_grip[1], dest_grip[2] + clearance - dz_prep];
        st.move_cartesian(
            p_trans, p_front_hi, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.10,
        )?;
        let p_align = [outside_x, dest_grip[1], dest_grip[2] + 0.012 - dz_prep];
        st.move_cartesian(
            p_front_hi, p_align, 0.0, 0.0, close_g, true, 0.014, 0.75, 0.24,
        )?;
        let dz_oven = st.measure_fork_z(cal, [p_align[0], p_align[1]], 0.0)?;
        let p_align_cal = [outside_x, dest_grip[1], dest_grip[2] + 0.012 - dz_oven];
        st.move_cartesian(
            p_align,
            p_align_cal,
            0.0,
            0.0,
            close_g,
            true,
            0.006,
            0.65,
            0.08,
        )?;

        let p_ins = [dest_grip[0], dest_grip[1], dest_grip[2] + 0.012 - dz_oven];
        st.move_cartesian(
            p_align_cal,
            p_ins,
            0.0,
            0.0,
            close_g,
            true,
            0.010,
            0.75,
            0.10,
        )?;
        let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] - dz_oven];
        st.move_cartesian(p_ins, p_place, 0.0, 0.0, close_g, true, 0.004, 0.65, 0.14)?;
        st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
        let p_drop_forks = [dest_grip[0], dest_grip[1], dest_grip[2] - 0.006 - dz_oven];
        st.move_cartesian(
            p_place,
            p_drop_forks,
            0.0,
            0.0,
            open_g,
            false,
            0.003,
            0.65,
            0.08,
        )?;
        let p_ret = [outside_x, dest_grip[1], dest_grip[2] - 0.006 - dz_oven];
        st.move_cartesian(
            p_drop_forks,
            p_ret,
            0.0,
            0.0,
            open_g,
            false,
            0.014,
            0.85,
            0.20,
        )?;
    } else {
        let p_over = [
            dest_grip[0],
            dest_grip[1],
            dest_grip[2] + clearance - dz_prep,
        ];
        st.move_cartesian(p_lifted, p_over, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.24)?;
        let dz_rack = st.measure_fork_z(cal, [p_over[0], p_over[1]], 0.0)?;
        let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] - dz_rack];
        st.move_cartesian(p_over, p_place, 0.0, 0.0, close_g, true, 0.008, 0.75, 0.14)?;
        st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
        let p_drop_forks = [dest_grip[0], dest_grip[1], dest_grip[2] - 0.006 - dz_rack];
        st.move_cartesian(
            p_place,
            p_drop_forks,
            0.0,
            0.0,
            open_g,
            false,
            0.003,
            0.65,
            0.08,
        )?;
        let p_ret = [
            dest_grip[0] - 0.30,
            dest_grip[1],
            dest_grip[2] - 0.006 - dz_rack,
        ];
        st.move_cartesian(
            p_drop_forks,
            p_ret,
            0.0,
            0.0,
            open_g,
            false,
            0.014,
            0.85,
            0.20,
        )?;
    }
    Ok(())
}

/// Hardened fork-clamp oven retrieval (`oven-to-table` on `combined` cell).
fn run_fork_unload(st: &mut ControllerState<'_>) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src_table = st.nom.source_site;
    let table_z_nom = nom_src_table[2] - 0.001;
    let nom_oven_slot = [1.337, 0.45, 0.801];

    let table_roi = RoiBox {
        x_min: nom_src_table[0] - 0.14,
        x_max: nom_src_table[0] + 0.65,
        y_min: nom_src_table[1] - 0.34,
        y_max: nom_src_table[1] + 0.34,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let nom_roof = [
        nom_oven_slot[0] + 0.038,
        nom_oven_slot[1] - 0.064,
        nom_oven_slot[2] + 0.348,
    ];
    let oven_roi = RoiBox {
        x_min: nom_roof[0] - 0.36,
        x_max: nom_roof[0] + 0.36,
        y_min: nom_roof[1] - 0.44,
        y_max: nom_roof[1] + 0.44,
        z_min: nom_roof[2] - 0.04,
        z_max: nom_roof[2] + 0.06,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let slot_pos = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        oven_roi,
        nom_roof,
        nom_oven_slot,
        0.020,
    );
    let table_target = perceive_table_target(
        &st.cam,
        &cloud0,
        cal,
        table_roi,
        [nom_src_table[0] + 0.2595, nom_src_table[1], table_z_nom],
        nom_src_table,
    );

    let source = [slot_pos[0] - 0.25, slot_pos[1], slot_pos[2] - 0.001];
    let destination = [
        table_target[0] - 0.25,
        table_target[1],
        table_target[2] - 0.001,
    ];
    let outside = [destination[0] - 0.37, source[1], source[2]];

    let cur_p = st.nom.fk_grasp(&st.cmd_q);
    let p_align = [outside[0], outside[1], outside[2] - 0.006];
    st.move_cartesian(cur_p, p_align, 0.0, 0.0, open_g, false, 0.012, 0.80, 0.24)?;
    let dz_oven = st.measure_fork_z(cal, [p_align[0], p_align[1]], 0.0)?;
    let p_align_cal = [outside[0], outside[1], outside[2] - 0.006 - dz_oven];
    st.move_cartesian(
        p_align,
        p_align_cal,
        0.0,
        0.0,
        open_g,
        false,
        0.006,
        0.70,
        0.08,
    )?;

    let p_ins = [source[0], source[1], source[2] - 0.006 - dz_oven];
    st.move_cartesian(
        p_align_cal,
        p_ins,
        0.0,
        0.0,
        open_g,
        false,
        0.010,
        0.75,
        0.10,
    )?;
    let p_seat = [source[0], source[1], source[2] - dz_oven];
    st.move_cartesian(p_ins, p_seat, 0.0, 0.0, open_g, false, 0.003, 0.65, 0.12)?;
    st.actuate_gripper(close_g, false, 0.55, 0.36, "close")?;

    let p_lift = [source[0], source[1], source[2] + 0.012 - dz_oven];
    st.move_cartesian(p_seat, p_lift, 0.0, 0.0, close_g, true, 0.005, 0.70, 0.12)?;
    let p_ext = [outside[0], outside[1], outside[2] + 0.012 - dz_oven];
    st.move_cartesian(p_lift, p_ext, 0.0, 0.0, close_g, true, 0.010, 0.75, 0.10)?;
    let p_clr = [outside[0], outside[1], outside[2] + 0.50 - dz_oven];
    st.move_cartesian(p_ext, p_clr, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_front = [destination[0] - 0.25, source[1], source[2] + 0.50 - dz_oven];
    st.move_cartesian(p_clr, p_front, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_trans = [
        destination[0] - 0.25,
        destination[1],
        destination[2] + 0.50 - dz_oven,
    ];
    st.move_cartesian(p_front, p_trans, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_over = [
        destination[0],
        destination[1],
        destination[2] + 0.32 - dz_oven,
    ];
    st.move_cartesian(p_trans, p_over, 0.0, 0.0, close_g, true, 0.014, 0.80, 0.24)?;
    let dz_tbl = st.measure_fork_z(cal, [p_over[0], p_over[1]], 0.0)?;
    let p_place = [destination[0], destination[1], destination[2] - dz_tbl];
    st.move_cartesian(p_over, p_place, 0.0, 0.0, close_g, true, 0.008, 0.75, 0.14)?;
    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_drop = [
        destination[0],
        destination[1],
        destination[2] - 0.006 - dz_tbl,
    ];
    st.move_cartesian(p_place, p_drop, 0.0, 0.0, open_g, false, 0.003, 0.65, 0.08)?;
    let p_ret = [
        destination[0] - 0.30,
        destination[1],
        destination[2] - 0.006 - dz_tbl,
    ];
    st.move_cartesian(p_drop, p_ret, 0.0, 0.0, open_g, false, 0.014, 0.85, 0.20)?;
    Ok(())
}

/// Run the hardened closed-loop Rust controller over `GAUNTLET_URL`.
/// Returns `(status, fault)` for the final JSON status line.
pub fn run_hardened(
    assets: &Assets,
    cfg: &TaskConfig,
    cam: CameraModel,
    client: &GauntletClient,
) -> Result<(&'static str, &'static str)> {
    let prepared = open_shipped_operation(assets, cfg)?;
    let home_q = prepared.start_angles;
    let mut nom = NominalDynamics::load(cfg)?;

    let meas0 = client.begin()?;
    let (_, _, rgb0) = client.read_rgb("overhead_cam")?;
    let ts0 = meas0.cam_timestamp.unwrap_or(0.0);
    let monitor = FaultMonitor::new(ts0, rgb0.clone(), meas0.q, meas0.gripper, nom.is_spanner);

    let mut st = ControllerState {
        cfg,
        nom: &mut nom,
        client,
        cam,
        last_rgb: rgb0,
        cmd_q: meas0.q,
        cmd_g: meas0.gripper,
        meas: meas0,
        carrying: false,
        tick: 0,
        monitor,
    };

    let res = if st.nom.is_spanner {
        match cfg.task {
            BakeryTask::Oven => run_spanner_load(&mut st, home_q),
            BakeryTask::Unload => run_spanner_unload(&mut st),
            BakeryTask::Rack => bail!("Spanner cell supports table-to-oven and oven-to-table only"),
        }
    } else {
        match cfg.task {
            BakeryTask::Oven | BakeryTask::Rack => run_fork_transfer(&mut st),
            BakeryTask::Unload => run_fork_unload(&mut st),
        }
    };

    let outcome = match res {
        Ok(()) => ("done", ""),
        Err(EpisodeStop::EpisodeOver) => ("done", ""),
        Err(EpisodeStop::Abort(fault)) => {
            // Hold current pose for 3 ticks so post-onset settle starts cleanly
            let q_hold = st.cmd_q;
            let g_hold = st.cmd_g;
            let carry = st.carrying;
            for _ in 0..3 {
                let ctrl = st.nom.servo_ctrl(&st.meas.q, &q_hold, carry);
                let _ = st.client.step(&ctrl, g_hold);
            }
            ("abort", fault)
        }
    };
    let _ = client.end();
    Ok(outcome)
}
