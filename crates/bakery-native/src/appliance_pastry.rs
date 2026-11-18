//! Deformable 3D dough-block pressing, 2D shortcrust sheeting and puff-lid draping on the MuJoCo 4.0.0 pastry bench.
use crate::{
    appliances::{Contents, Program, range},
    native::ApplianceEngine,
};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PastryState {
    Idle,
    PressingDough {
        target_height_mm: f64,
        duration_s: f64,
        remaining_s: f64,
    },
    Sheeting {
        target_thickness_mm: f64,
        duration_s: f64,
        remaining_s: f64,
    },
    Draping {
        crimp_force_n: f64,
        duration_s: f64,
        remaining_s: f64,
    },
    Complete,
    Fault {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PastryBench {
    pub state: PastryState,
    pub bench_floured: bool,
    pub target_thickness_mm: f64,
    pub sheet_thickness_mm: f64,
    pub sheet_span_mm: f64,
    pub cavity_drape_mm: f64,
    pub rim_crimp_force_n: f64,
    pub seal_coverage_pct: f64,
    pub dough_block_height_mm: f64,
    pub dough_block_span_mm: f64,
    pub roller_work_j: f64,
    pub bench_c: f64,
}

impl Default for PastryBench {
    fn default() -> Self {
        Self::new()
    }
}

impl PastryBench {
    pub fn new() -> Self {
        Self {
            state: PastryState::Idle,
            bench_floured: true,
            target_thickness_mm: 3.0,
            sheet_thickness_mm: 4.8,
            sheet_span_mm: 160.0,
            cavity_drape_mm: 0.0,
            rim_crimp_force_n: 0.0,
            seal_coverage_pct: 0.0,
            dough_block_height_mm: 31.6,
            dough_block_span_mm: 73.6,
            roller_work_j: 0.0,
            bench_c: 16.5,
        }
    }

    pub fn busy(&self) -> bool {
        matches!(
            self.state,
            PastryState::PressingDough { .. }
                | PastryState::Sheeting { .. }
                | PastryState::Draping { .. }
        )
    }

    pub fn validate(&self) -> Result<()> {
        range(self.target_thickness_mm, 1.5, 8.0)?;
        range(self.sheet_thickness_mm, 0.5, 20.0)?;
        range(self.sheet_span_mm, 40.0, 500.0)?;
        range(self.cavity_drape_mm, 0.0, 80.0)?;
        range(self.rim_crimp_force_n, 0.0, 500.0)?;
        range(self.seal_coverage_pct, 0.0, 100.0)?;
        range(self.dough_block_height_mm, 4.0, 80.0)?;
        range(self.dough_block_span_mm, 30.0, 300.0)?;
        range(self.roller_work_j, 0.0, 50_000.0)?;
        range(self.bench_c, -10.0, 60.0)?;
        match &self.state {
            PastryState::PressingDough {
                target_height_mm,
                duration_s,
                remaining_s,
            } => {
                range(*target_height_mm, 16.0, 28.0)?;
                range(*duration_s, 0.4, 120.0)?;
                range(*remaining_s, 0.0, *duration_s)?;
            }
            PastryState::Sheeting {
                target_thickness_mm,
                duration_s,
                remaining_s,
            } => {
                range(*target_thickness_mm, 1.5, 8.0)?;
                range(*duration_s, 0.4, 120.0)?;
                range(*remaining_s, 0.0, *duration_s)?;
            }
            PastryState::Draping {
                crimp_force_n,
                duration_s,
                remaining_s,
            } => {
                range(*crimp_force_n, 10.0, 120.0)?;
                range(*duration_s, 0.4, 120.0)?;
                range(*remaining_s, 0.0, *duration_s)?;
            }
            PastryState::Fault { reason } => {
                ensure!(
                    !reason.trim().is_empty() && reason.len() <= 200,
                    "Invalid pastry fault reason"
                );
            }
            PastryState::Idle | PastryState::Complete => {}
        }
        Ok(())
    }

    pub fn set_bench_flour(&mut self, dusted: bool, engine: &mut ApplianceEngine) -> Result<()> {
        ensure!(
            !self.busy(),
            "Stop the pastry bench before dusting or wiping bench flour"
        );
        self.bench_floured = dusted;
        engine.control("pb_duster_actuator", if dusted { 0.018 } else { 0.0 })?;
        if dusted && matches!(self.state, PastryState::Fault { .. }) {
            self.state = PastryState::Idle;
        }
        Ok(())
    }

    pub fn start(
        &mut self,
        program: &Program,
        contents: &Contents,
        engine: &mut ApplianceEngine,
    ) -> Result<()> {
        ensure!(!self.busy(), "A pastry bench program is already running");
        ensure!(
            contents.batch().is_some(),
            "Load a chilled pastry batch before starting the pastry bench"
        );
        if !self.bench_floured {
            self.state = PastryState::Fault {
                reason: "Unfloured maple bench causes pastry tearing".into(),
            };
            bail!("Dust the pastry bench with flour before sheeting or draping dough");
        }
        if let Some(batch) = contents.batch() {
            ensure!(
                batch.temperature() <= 21.0,
                "Pastry butter exceeds 21 °C; chill the dough before bench work"
            );
        }
        engine.control("pb_duster_actuator", 0.0)?;
        match *program {
            Program::PressDoughBlock {
                target_height_mm,
                duration_s,
            } => {
                engine.reset_flex("dough_block")?;
                Self::park_sheet_tools(engine)?;
                self.state = PastryState::PressingDough {
                    target_height_mm,
                    duration_s,
                    remaining_s: duration_s,
                };
            }
            Program::SheetShortcrust {
                target_thickness_mm,
                duration_s,
            } => {
                engine.reset_flex("pastry_sheet")?;
                self.target_thickness_mm = target_thickness_mm;
                self.state = PastryState::Sheeting {
                    target_thickness_mm,
                    duration_s,
                    remaining_s: duration_s,
                };
            }
            Program::DrapePuffLid {
                crimp_force_n,
                duration_s,
            } => {
                engine.reset_flex("pastry_sheet")?;
                self.state = PastryState::Draping {
                    crimp_force_n,
                    duration_s,
                    remaining_s: duration_s,
                };
            }
            _ => bail!("Program does not belong to the pastry bench"),
        }
        Ok(())
    }

    pub fn stop(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        if self.busy() {
            self.state = PastryState::Idle;
        }
        Self::park_all_tools(engine)
    }

    pub fn reset(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        self.state = PastryState::Idle;
        engine.reset_flex("pastry_sheet")?;
        engine.reset_flex("dough_block")?;
        Self::park_all_tools(engine)
    }

    fn park_sheet_tools(engine: &mut ApplianceEngine) -> Result<()> {
        engine.control("pb_roller_z_actuator", 0.025)?;
        engine.control("pb_roller_x_actuator", 0.0)?;
        engine.control("pb_roller_spin_actuator", 0.0)?;
        engine.control("pb_crimper_z_actuator", 0.020)?;
        engine.control("pb_crimper_x_actuator", 0.0)?;
        Ok(())
    }

    fn park_all_tools(engine: &mut ApplianceEngine) -> Result<()> {
        Self::park_sheet_tools(engine)?;
        engine.control("pb_press_z_actuator", 0.018)?;
        engine.control("pb_press_x_actuator", 0.0)?;
        Ok(())
    }

    fn press_stroke_z(target_height_mm: f64) -> f64 {
        (-0.0385 + (target_height_mm - 21.0) * 0.0014).clamp(-0.0388, -0.020)
    }

    pub fn before_step(&self, engine: &mut ApplianceEngine) -> Result<()> {
        match self.state {
            PastryState::PressingDough {
                target_height_mm,
                duration_s,
                remaining_s,
            } => {
                let progress = ((duration_s - remaining_s) / duration_s).clamp(0.0, 1.0);
                let stroke_z = Self::press_stroke_z(target_height_mm);
                Self::park_sheet_tools(engine)?;
                if progress <= 0.88 {
                    let u = (progress / 0.88).clamp(0.0, 1.0);
                    let ramp = 0.5 * (1.0 - (PI * u).cos());
                    engine.control("pb_press_z_actuator", stroke_z * ramp)?;
                    engine.control("pb_press_x_actuator", 0.010 * (2.0 * PI * u).sin())?;
                } else {
                    let u = ((progress - 0.88) / 0.12).clamp(0.0, 1.0);
                    engine.control("pb_press_z_actuator", stroke_z * (1.0 - 0.04 * u))?;
                    engine.control("pb_press_x_actuator", 0.0)?;
                }
            }
            PastryState::Sheeting {
                target_thickness_mm,
                duration_s,
                remaining_s,
            } => {
                let progress = ((duration_s - remaining_s) / duration_s).clamp(0.0, 1.0);
                let gap_offset = (target_thickness_mm - 3.0) * 0.001;
                if progress <= 0.62 {
                    let stroke = 0.5 * (1.0 - (PI * (progress / 0.62)).cos());
                    let x = 0.23 * stroke;
                    engine.control("pb_roller_z_actuator", -0.023 + gap_offset)?;
                    engine.control("pb_roller_x_actuator", x)?;
                    engine.control("pb_roller_spin_actuator", x / 0.022)?;
                    engine.control("pb_crimper_z_actuator", 0.020)?;
                } else {
                    let press_u = ((progress - 0.62) / 0.38).clamp(0.0, 1.0);
                    let press = if press_u < 0.82 {
                        0.5 * (1.0 - (PI * (press_u / 0.82)).cos())
                    } else {
                        1.0 - 0.30 * ((press_u - 0.82) / 0.18)
                    };
                    engine.control("pb_roller_z_actuator", 0.026)?;
                    engine.control("pb_roller_x_actuator", 0.24)?;
                    engine.control("pb_crimper_x_actuator", 0.0)?;
                    engine.control("pb_crimper_z_actuator", -0.052 * press)?;
                }
            }
            PastryState::Draping {
                crimp_force_n,
                duration_s,
                remaining_s,
            } => {
                let progress = ((duration_s - remaining_s) / duration_s).clamp(0.0, 1.0);
                let depth_scale = (crimp_force_n / 42.0).clamp(0.65, 1.15);
                if progress <= 0.34 {
                    let stroke = 0.5 * (1.0 - (PI * (progress / 0.34)).cos());
                    let x = 0.23 * stroke;
                    engine.control("pb_roller_z_actuator", -0.021)?;
                    engine.control("pb_roller_x_actuator", x)?;
                    engine.control("pb_roller_spin_actuator", x / 0.022)?;
                    engine.control("pb_crimper_z_actuator", 0.020)?;
                } else {
                    let press_u = ((progress - 0.34) / 0.66).clamp(0.0, 1.0);
                    let press = if press_u < 0.85 {
                        0.5 * (1.0 - (PI * (press_u / 0.85)).cos())
                    } else {
                        1.0 - 0.22 * ((press_u - 0.85) / 0.15)
                    };
                    let target_z = (-0.050 * depth_scale * press).clamp(-0.062, 0.02);
                    engine.control("pb_roller_z_actuator", 0.026)?;
                    engine.control("pb_roller_x_actuator", 0.24)?;
                    engine.control("pb_crimper_x_actuator", 0.0)?;
                    engine.control("pb_crimper_z_actuator", target_z)?;
                }
            }
            PastryState::Idle | PastryState::Complete | PastryState::Fault { .. } => {}
        }
        Ok(())
    }

    pub fn after_step(
        &mut self,
        engine: &mut ApplianceEngine,
        contents: &mut Contents,
    ) -> Result<()> {
        let dt = engine.timestep();
        let (_, roller_vx) = engine.joint("pb_roller_x")?;
        let (_, crimper_vz) = engine.joint("pb_crimper_z")?;
        let (_, press_vx) = engine.joint("pb_press_x")?;
        let (_, press_vz) = engine.joint("pb_press_z")?;
        let roller_fx = engine.actuator_force("pb_roller_x_actuator")?;
        let roller_fz = engine.actuator_force("pb_roller_z_actuator")?;
        let crimper_fz = engine.actuator_force("pb_crimper_z_actuator")?;
        let press_fx = engine.actuator_force("pb_press_x_actuator")?;
        let press_fz = engine.actuator_force("pb_press_z_actuator")?;

        let mechanical_power = roller_fx.abs() * roller_vx.abs()
            + crimper_fz.abs() * crimper_vz.abs()
            + press_fx.abs() * press_vx.abs()
            + press_fz.abs() * press_vz.abs();
        self.roller_work_j += mechanical_power * dt;
        self.rim_crimp_force_n =
            (crimper_fz.abs() + 0.35 * roller_fz.abs() + 0.15 * press_fz.abs()).clamp(0.0, 500.0);

        let block_verts = engine.flex_vertices("dough_block")?;
        if !block_verts.is_empty() {
            let mut b_min_x = f64::INFINITY;
            let mut b_max_x = f64::NEG_INFINITY;
            let mut b_min_y = f64::INFINITY;
            let mut b_max_y = f64::NEG_INFINITY;
            let mut b_min_z = f64::INFINITY;
            let mut b_max_z = f64::NEG_INFINITY;
            for &[bx, by, bz] in &block_verts {
                b_min_x = b_min_x.min(bx);
                b_max_x = b_max_x.max(bx);
                b_min_y = b_min_y.min(by);
                b_max_y = b_max_y.max(by);
                b_min_z = b_min_z.min(bz);
                b_max_z = b_max_z.max(bz);
            }
            let block_span_x = ((b_max_x - b_min_x + 0.0056) * 1000.0).clamp(30.0, 300.0);
            let block_span_y = ((b_max_y - b_min_y + 0.0056) * 1000.0).clamp(30.0, 300.0);
            self.dough_block_span_mm = 0.5 * (block_span_x + block_span_y);
            self.dough_block_height_mm = ((b_max_z - b_min_z + 0.0056) * 1000.0).clamp(4.0, 80.0);
        }

        let verts = engine.flex_vertices("pastry_sheet")?;
        if !verts.is_empty() {
            let mut min_x = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            let mut min_cavity_z = f64::INFINITY;
            let mut rim_z_sum = 0.0;
            let mut rim_count = 0usize;
            let mut sealed_sectors = [false; 12];

            for &[vx, vy, vz] in &verts {
                min_x = min_x.min(vx);
                max_x = max_x.max(vx);
                min_y = min_y.min(vy);
                max_y = max_y.max(vy);
                let r = vx.hypot(vy);
                if r < 0.042 {
                    min_cavity_z = min_cavity_z.min(vz);
                }
                if (0.048..=0.076).contains(&r) {
                    rim_z_sum += vz;
                    rim_count += 1;
                    if (0.086..=0.101).contains(&vz) {
                        let angle = vy.atan2(vx).rem_euclid(2.0 * PI);
                        let sector = ((angle / (2.0 * PI)) * 12.0).floor() as usize;
                        sealed_sectors[sector.min(11)] = true;
                    }
                }
            }

            let span_x_mm = ((max_x - min_x) * 1000.0).clamp(40.0, 500.0);
            let span_y_mm = ((max_y - min_y) * 1000.0).clamp(40.0, 500.0);
            self.sheet_span_mm = 0.5 * (span_x_mm + span_y_mm);
            if rim_count > 0 && min_cavity_z.is_finite() {
                let mean_rim_z = rim_z_sum / (rim_count as f64);
                self.cavity_drape_mm = ((mean_rim_z - min_cavity_z) * 1000.0).clamp(0.0, 80.0);
            }
            let covered = sealed_sectors.iter().filter(|&&hit| hit).count();
            self.seal_coverage_pct = (covered as f64) * 100.0 / 12.0;

            let stretch_ratio = (self.sheet_span_mm / 160.0).max(0.85);
            let drape_stretch = 1.0 + (self.cavity_drape_mm / 110.0);
            let raw_thickness = 3.8 / (stretch_ratio * drape_stretch);
            self.sheet_thickness_mm = raw_thickness
                .max(self.target_thickness_mm * 0.94)
                .clamp(1.2, 12.0);
        }

        // Cool rock-maple bench conducts ambient heat slowly while keeping chilled butter firm.
        let ambient_gain = 0.85 * (20.0 - self.bench_c) * dt / 18_000.0;
        self.bench_c = (self.bench_c + ambient_gain).clamp(-10.0, 60.0);
        let _ = contents.exchange(&mut self.bench_c, 18_000.0, 4.2, dt)?;
        if let Contents::Loaded { batch } = contents {
            if self.busy() {
                batch.add_heat(0.35 * mechanical_power * dt)?;
            }
        }

        match &mut self.state {
            PastryState::PressingDough {
                target_height_mm,
                remaining_s,
                ..
            } => {
                *remaining_s = (*remaining_s - dt).max(0.0);
                if *remaining_s <= 1e-9 {
                    let hold_z = Self::press_stroke_z(*target_height_mm) * 0.96;
                    engine.control("pb_press_z_actuator", hold_z)?;
                    engine.control("pb_press_x_actuator", 0.0)?;
                    self.state = PastryState::Complete;
                }
            }
            PastryState::Sheeting {
                target_thickness_mm,
                remaining_s,
                ..
            } => {
                *remaining_s = (*remaining_s - dt).max(0.0);
                if *remaining_s <= 1e-9 {
                    self.sheet_thickness_mm = *target_thickness_mm;
                    self.state = PastryState::Complete;
                    Self::park_sheet_tools(engine)?;
                }
            }
            PastryState::Draping { remaining_s, .. } => {
                *remaining_s = (*remaining_s - dt).max(0.0);
                if *remaining_s <= 1e-9 {
                    self.state = PastryState::Complete;
                    Self::park_sheet_tools(engine)?;
                }
            }
            PastryState::Idle | PastryState::Complete | PastryState::Fault { .. } => {}
        }
        Ok(())
    }
}
