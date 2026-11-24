//! Unprivileged RGB-D perception and T4 terminal fault detection in Rust.
//!
//! Reads ONLY allowlisted deployment keys (`overhead_cam`, `overhead_cam_depth`,
//! `overhead_cam_timestamp`, `joint_position/*`). Zero privileged simulator access.

use nalgebra::{Matrix3, Vector3};
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
pub struct CameraModel {
    pub pos: [f64; 3],
    pub fovy_deg: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct PlaneCal {
    pub ax: f64,
    pub ay: f64,
    pub coef: [f64; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct RoiBox {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub z_min: f64,
    pub z_max: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct TrayPose {
    pub cx: f64,
    pub cy: f64,
    pub z_table: f64,
    pub yaw_rad: f64,
}

pub struct Cloud {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
    pub rgb: Vec<[u8; 3]>,
}

impl CameraModel {
    pub fn deproject(&self, depth: &[f32], rgb: &[u8], h: usize, w: usize) -> Cloud {
        let fovy_rad = self.fovy_deg.to_radians();
        let fy = 0.5 * (h as f64) / (0.5 * fovy_rad).tan();
        let fx = fy;
        let cx = ((w as f64) - 1.0) * 0.5;
        let cy = ((h as f64) - 1.0) * 0.5;
        let mut x = Vec::with_capacity(h * w / 2);
        let mut y = Vec::with_capacity(h * w / 2);
        let mut z = Vec::with_capacity(h * w / 2);
        let mut cols = Vec::with_capacity(h * w / 2);
        let has_rgb = rgb.len() >= h * w * 3;
        for v in 0..h {
            let row = v * w;
            let dy_n = (cy - v as f64) / fy;
            for u in 0..w {
                let idx = row + u;
                let d = f64::from(depth[idx]);
                if d.is_finite() && d > 0.35 && d < 2.65 {
                    let dx_n = (u as f64 - cx) / fx;
                    x.push(self.pos[0] + dx_n * d);
                    y.push(self.pos[1] + dy_n * d);
                    z.push(self.pos[2] - d);
                    let c = if has_rgb {
                        [rgb[idx * 3], rgb[idx * 3 + 1], rgb[idx * 3 + 2]]
                    } else {
                        [128, 128, 128]
                    };
                    cols.push(c);
                }
            }
        }
        Cloud { x, y, z, rgb: cols }
    }

    pub fn cam_xy_shift(&self, cal: PlaneCal, target_z: f64) -> (f64, f64) {
        let dist = self.pos[2] - target_z;
        let dx = (cal.ax * dist).clamp(-0.025, 0.025);
        let dy = (cal.ay * dist).clamp(-0.025, 0.025);
        (dx, dy)
    }
}

fn percentile(vals: &mut [f64], p: f64) -> f64 {
    vals.sort_by(|a, b| a.total_cmp(b));
    let n = vals.len();
    if n == 0 {
        return 0.0;
    }
    let idx = ((p / 100.0) * ((n - 1) as f64)).clamp(0.0, (n - 1) as f64);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    vals[lo] * (1.0 - frac) + vals[hi] * frac
}

fn is_neutral_table_pixel(c: [u8; 3]) -> bool {
    let (r, g, b) = (i32::from(c[0]), i32::from(c[1]), i32::from(c[2]));
    (r - b).abs() <= 20 && (g - b).abs() <= 20 && r >= 90
}

fn is_warm_tray_pixel(c: [u8; 3]) -> bool {
    let (r, g, b) = (i32::from(c[0]), i32::from(c[1]), i32::from(c[2]));
    // Yellow/gold tray & orange payload stay strongly above blue across the full
    // T2 hue rotation (-14..+14 deg), whereas the stainless table is neutral (r~g~b)
    // and the bystander dish is blue (b > r).
    (r + g) / 2 - b > 20 && r > 60 && g > 60
}

/// Fit the static prep-table plane (`z = c0*x + c1*y + c2`) from bare neutral
/// stainless-table pixels so its slope directly measures overhead camera tilt
/// `(ax, ay)` with zero bias even when the tray covers much of the table.
pub fn calibrate_table_plane(cloud: &Cloud, roi: RoiBox, nom_table_z: f64) -> PlaneCal {
    let mut zs = Vec::new();
    for i in 0..cloud.x.len() {
        let (x, y, z) = (cloud.x[i], cloud.y[i], cloud.z[i]);
        if x > roi.x_min
            && x < roi.x_max
            && y > roi.y_min
            && y < roi.y_max
            && z > roi.z_min
            && z < roi.z_max
            && is_neutral_table_pixel(cloud.rgb[i])
        {
            zs.push(z);
        }
    }
    let use_neutral = zs.len() >= 80;
    if !use_neutral {
        zs.clear();
        for i in 0..cloud.x.len() {
            let (x, y, z) = (cloud.x[i], cloud.y[i], cloud.z[i]);
            if x > roi.x_min
                && x < roi.x_max
                && y > roi.y_min
                && y < roi.y_max
                && z > roi.z_min
                && z < roi.z_max
            {
                zs.push(z);
            }
        }
    }
    if zs.len() < 60 {
        return PlaneCal {
            ax: 0.0,
            ay: 0.0,
            coef: [0.0, 0.0, nom_table_z],
        };
    }
    let z_med = percentile(&mut zs, if use_neutral { 50.0 } else { 35.0 });
    let mut ata = Matrix3::<f64>::zeros();
    let mut atb = Vector3::<f64>::zeros();
    let mut count = 0usize;
    for i in 0..cloud.x.len() {
        let (x, y, z) = (cloud.x[i], cloud.y[i], cloud.z[i]);
        if x > roi.x_min
            && x < roi.x_max
            && y > roi.y_min
            && y < roi.y_max
            && (z - z_med).abs() <= 0.010
            && (!use_neutral || is_neutral_table_pixel(cloud.rgb[i]))
        {
            let row = Vector3::new(x, y, 1.0);
            ata += row * row.transpose();
            atb += row * z;
            count += 1;
        }
    }
    if count < 40 {
        return PlaneCal {
            ax: 0.0,
            ay: 0.0,
            coef: [0.0, 0.0, nom_table_z],
        };
    }
    let coef = ata
        .lu()
        .solve(&atb)
        .unwrap_or_else(|| Vector3::new(0.0, 0.0, nom_table_z));
    let ax = if coef[0].abs() > 0.002 { coef[0] } else { 0.0 };
    let ay = if coef[1].abs() > 0.002 { coef[1] } else { 0.0 };
    PlaneCal {
        ax,
        ay,
        coef: [coef[0], coef[1], coef[2]],
    }
}

/// Locate the prep-table center `(cx, cy, z)` when the prep table is the destination
/// (e.g., `oven-to-table` unload under T1/T2 `dest_xy_m` shifts).
pub fn perceive_table_target(
    cam: &CameraModel,
    cloud: &Cloud,
    cal: PlaneCal,
    roi: RoiBox,
    nom_table_center: [f64; 3],
    nom_dest_world: [f64; 3],
) -> [f64; 3] {
    let (dx_cam, dy_cam) = cam.cam_xy_shift(cal, nom_table_center[2]);
    let mut fx = Vec::new();
    let mut fy = Vec::new();
    let mut fz = Vec::new();
    for i in 0..cloud.x.len() {
        let (x, y, z) = (cloud.x[i] - dx_cam, cloud.y[i] - dy_cam, cloud.z[i]);
        if x > roi.x_min
            && x < roi.x_max
            && y > roi.y_min
            && y < roi.y_max
            && (z - nom_table_center[2]).abs() < 0.04
            && is_neutral_table_pixel(cloud.rgb[i])
        {
            fx.push(x);
            fy.push(y);
            fz.push(z);
        }
    }
    if fx.len() < 120 {
        return nom_dest_world;
    }
    let tcx = 0.5 * (percentile(&mut fx, 2.0) + percentile(&mut fx, 98.0));
    let tcy = 0.5 * (percentile(&mut fy, 2.0) + percentile(&mut fy, 98.0));
    let tcz = percentile(&mut fz, 50.0);
    let dx = (tcx - nom_table_center[0]).clamp(-0.05, 0.05);
    let dy = (tcy - nom_table_center[1]).clamp(-0.05, 0.05);
    let dz = (tcz - nom_table_center[2]).clamp(-0.03, 0.03);
    [
        nom_dest_world[0] + dx,
        nom_dest_world[1] + dy,
        nom_dest_world[2] + dz,
    ]
}

/// Detect the baking tray `(cx, cy, z_table, yaw_rad)` from overhead RGB-D.
///
/// Combines warm tray chroma (`R - B > 20`) with height above the calibrated
/// table plane (`h in [-0.008, h_max]`) plus raised non-blue fallback, capturing
/// the full outer tray silhouette even under T2 2 mm depth noise and CoM shifts.
pub fn perceive_tray(
    cam: &CameraModel,
    cloud: &Cloud,
    cal: PlaneCal,
    roi: RoiBox,
    nom_table_z: f64,
    max_half_extent_m: f64,
    major_along_world_x: bool,
) -> Option<TrayPose> {
    let (dx_cam, dy_cam) = cam.cam_xy_shift(cal, nom_table_z);
    let mut pts_x = Vec::new();
    let mut pts_y = Vec::new();
    for i in 0..cloud.x.len() {
        let xw = cloud.x[i];
        let yw = cloud.y[i];
        let zw = cloud.z[i];
        let xc = xw - dx_cam;
        let yc = yw - dy_cam;
        if xc <= roi.x_min || xc >= roi.x_max || yc <= roi.y_min || yc >= roi.y_max {
            continue;
        }
        let z_plane = cal.coef[0] * xw + cal.coef[1] * yw + cal.coef[2];
        let h = zw - z_plane;
        let c = cloud.rgb[i];
        let warm = is_warm_tray_pixel(c) && h > -0.008 && h < roi.z_max;
        let raised = h > roi.z_min
            && h < roi.z_max
            && i32::from(c[0]) >= i32::from(c[1]) - 10
            && i32::from(c[0]) + 10 >= i32::from(c[2]);
        if warm || raised {
            pts_x.push(xc);
            pts_y.push(yc);
        }
    }
    if pts_x.len() < 80 {
        return None;
    }
    let mut sx = pts_x.clone();
    let mut sy = pts_y.clone();
    let mx = percentile(&mut sx, 50.0);
    let my = percentile(&mut sy, 50.0);
    let mut in_x = Vec::with_capacity(pts_x.len());
    let mut in_y = Vec::with_capacity(pts_y.len());
    for (&x, &y) in pts_x.iter().zip(&pts_y) {
        if (x - mx).abs() < max_half_extent_m && (y - my).abs() < max_half_extent_m {
            in_x.push(x);
            in_y.push(y);
        }
    }
    if in_x.len() < 60 {
        return None;
    }
    let n = in_x.len() as f64;
    let mean_x = in_x.iter().sum::<f64>() / n;
    let mean_y = in_y.iter().sum::<f64>() / n;
    let mut cxx = 0.0;
    let mut cxy = 0.0;
    let mut cyy = 0.0;
    for (&x, &y) in in_x.iter().zip(&in_y) {
        let dx = x - mean_x;
        let dy = y - mean_y;
        cxx += dx * dx;
        cxy += dx * dy;
        cyy += dy * dy;
    }
    let theta = 0.5 * (2.0 * cxy).atan2(cxx - cyy);
    let mut maj_x = theta.cos();
    let mut maj_y = theta.sin();
    if major_along_world_x {
        if maj_x < 0.0 {
            maj_x = -maj_x;
            maj_y = -maj_y;
        }
    } else if maj_y < 0.0 {
        maj_x = -maj_x;
        maj_y = -maj_y;
    }
    let min_x = -maj_y;
    let min_y = maj_x;

    let mut proj_maj = Vec::with_capacity(in_x.len());
    let mut proj_min = Vec::with_capacity(in_x.len());
    for (&x, &y) in in_x.iter().zip(&in_y) {
        let dx = x - mean_x;
        let dy = y - mean_y;
        proj_maj.push(dx * maj_x + dy * maj_y);
        proj_min.push(dx * min_x + dy * min_y);
    }
    let mid_maj = 0.5 * (percentile(&mut proj_maj, 2.0) + percentile(&mut proj_maj, 98.0));
    let mid_min = 0.5 * (percentile(&mut proj_min, 2.0) + percentile(&mut proj_min, 98.0));
    let cx = mean_x + mid_maj * maj_x + mid_min * min_x;
    let cy = mean_y + mid_maj * maj_y + mid_min * min_y;

    let mut yaw = if major_along_world_x {
        maj_y.atan2(maj_x)
    } else {
        (-maj_x).atan2(maj_y)
    };
    while yaw > std::f64::consts::FRAC_PI_2 {
        yaw -= std::f64::consts::PI;
    }
    while yaw < -std::f64::consts::FRAC_PI_2 {
        yaw += std::f64::consts::PI;
    }
    let z_tbl = (cal.coef[0] * (cx + dx_cam) + cal.coef[1] * (cy + dy_cam) + cal.coef[2])
        .clamp(nom_table_z - 0.03, nom_table_z + 0.03);
    Some(TrayPose {
        cx,
        cy,
        z_table: z_tbl,
        yaw_rad: yaw,
    })
}

/// Locate a static destination fixture (oven roof or cooling rack rails) from
/// overhead depth and return the shifted world target coordinate.
pub fn perceive_fixture_target(
    cam: &CameraModel,
    cloud: &Cloud,
    cal: PlaneCal,
    roi: RoiBox,
    nom_feature_center: [f64; 3],
    nom_target_world: [f64; 3],
    z_band: f64,
) -> [f64; 3] {
    let (dx_cam, dy_cam) = cam.cam_xy_shift(cal, nom_feature_center[2]);
    let mut zs = Vec::new();
    for i in 0..cloud.x.len() {
        let (x, y, z) = (cloud.x[i] - dx_cam, cloud.y[i] - dy_cam, cloud.z[i]);
        if x > roi.x_min
            && x < roi.x_max
            && y > roi.y_min
            && y < roi.y_max
            && z > roi.z_min
            && z < roi.z_max
        {
            zs.push(z);
        }
    }
    if zs.len() < 50 {
        return nom_target_world;
    }
    let z_med = percentile(&mut zs, 50.0);
    let mut fx = Vec::new();
    let mut fy = Vec::new();
    let mut fz = Vec::new();
    for i in 0..cloud.x.len() {
        let (x, y, z) = (cloud.x[i] - dx_cam, cloud.y[i] - dy_cam, cloud.z[i]);
        if x > roi.x_min
            && x < roi.x_max
            && y > roi.y_min
            && y < roi.y_max
            && (z - z_med).abs() < z_band
        {
            fx.push(x);
            fy.push(y);
            fz.push(z);
        }
    }
    if fx.len() < 40 {
        return nom_target_world;
    }
    let ocx = 0.5 * (percentile(&mut fx, 2.0) + percentile(&mut fx, 98.0));
    let ocy = 0.5 * (percentile(&mut fy, 2.0) + percentile(&mut fy, 98.0));
    let ocz = percentile(&mut fz, 50.0);
    let dx = (ocx - nom_feature_center[0]).clamp(-0.05, 0.05);
    let dy = (ocy - nom_feature_center[1]).clamp(-0.05, 0.05);
    let dz = (ocz - nom_feature_center[2]).clamp(-0.03, 0.03);
    [
        nom_target_world[0] + dx,
        nom_target_world[1] + dy,
        nom_target_world[2] + dz,
    ]
}

/// Eye-to-hand gripper beam Z-offset measurement from overhead depth.
///
/// Compensates combined robot-base Z offset (`table_dz_m`), base tilt
/// (`table_tilt_deg`), servo droop (`gain_scale`), and `gravcomp_delta` using
/// purely unprivileged overhead depth + nominal CAD FK.
#[allow(clippy::too_many_arguments)]
pub fn measure_ee_z_offset(
    cam: &CameraModel,
    cloud: &Cloud,
    cal: PlaneCal,
    target_xy: [f64; 2],
    along_unit: [f64; 2],
    z_beam_fk: f64,
    half_width: f64,
    along_min: f64,
    along_max: f64,
) -> f64 {
    let (dx_cam, dy_cam) = cam.cam_xy_shift(cal, z_beam_fk);
    let perp_unit = [-along_unit[1], along_unit[0]];
    let mut zs = Vec::new();
    for i in 0..cloud.x.len() {
        let rx = (cloud.x[i] - dx_cam) - target_xy[0];
        let ry = (cloud.y[i] - dy_cam) - target_xy[1];
        let zw = cloud.z[i];
        let u_along = rx * along_unit[0] + ry * along_unit[1];
        let u_perp = rx * perp_unit[0] + ry * perp_unit[1];
        if u_perp.abs() < half_width
            && u_along > along_min
            && u_along < along_max
            && (zw - z_beam_fk).abs() < 0.050
        {
            zs.push(zw);
        }
    }
    if zs.len() < 25 {
        return 0.0;
    }
    let z_obs = percentile(&mut zs, 50.0);
    (z_obs - z_beam_fk).clamp(-0.045, 0.045)
}

/// Runtime T4 terminal fault monitor (`camera_freeze` and `dead_gripper`).
pub struct FaultMonitor {
    prev_ts: f64,
    stale_ts_ticks: usize,
    ref_rgb: Vec<u8>,
    ref_q: [f64; 6],
    same_rgb_ticks: usize,
    g_hist: VecDeque<f64>,
    close_stuck_thresh: f64,
    open_stuck_thresh: f64,
}

impl FaultMonitor {
    pub fn new(
        init_ts: f64,
        init_rgb: Vec<u8>,
        init_q: [f64; 6],
        init_g: f64,
        is_spanner: bool,
    ) -> Self {
        let mut g_hist = VecDeque::with_capacity(48);
        g_hist.push_back(init_g);
        let (close_stuck_thresh, open_stuck_thresh) = if is_spanner {
            (0.034, 0.012)
        } else {
            (0.018, 0.002)
        };
        Self {
            prev_ts: init_ts,
            stale_ts_ticks: 0,
            ref_rgb: init_rgb,
            ref_q: init_q,
            same_rgb_ticks: 0,
            g_hist,
            close_stuck_thresh,
            open_stuck_thresh,
        }
    }

    pub fn update(
        &mut self,
        ts: f64,
        rgb: &[u8],
        q_now: &[f64; 6],
        g_now: f64,
        check_grip: Option<&str>,
    ) -> Option<&'static str> {
        self.g_hist.push_back(g_now);
        if self.g_hist.len() > 48 {
            self.g_hist.pop_front();
        }
        if ts <= self.prev_ts + 1e-9 {
            self.stale_ts_ticks += 1;
        } else {
            self.stale_ts_ticks = 0;
        }
        self.prev_ts = ts;

        if rgb == self.ref_rgb.as_slice() {
            self.same_rgb_ticks += 1;
        } else {
            self.ref_rgb.clear();
            self.ref_rgb.extend_from_slice(rgb);
            self.ref_q = *q_now;
            self.same_rgb_ticks = 0;
        }
        let arm_moved = q_now
            .iter()
            .zip(&self.ref_q)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max);
        if self.stale_ts_ticks >= 6 {
            return Some("camera_freeze");
        }
        if self.same_rgb_ticks >= 12 && arm_moved > 0.055 {
            return Some("camera_freeze");
        }
        if let Some(mode) = check_grip
            && self.g_hist.len() >= 20
        {
            let g_prev = self.g_hist[self.g_hist.len() - 16];
            if mode == "close" && g_now > self.close_stuck_thresh && (g_now - g_prev).abs() < 0.0018
            {
                return Some("dead_gripper");
            }
            if mode == "open" && g_now < self.open_stuck_thresh && (g_now - g_prev).abs() < 0.0018 {
                return Some("dead_gripper");
            }
        }
        None
    }
}
