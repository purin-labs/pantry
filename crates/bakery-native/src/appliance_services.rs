//! Native load-cell sampling and interrupted wash-cycle state.
use crate::{appliances::Contents, native::ApplianceEngine};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Reading {
    Settling,
    Stable,
    Overload,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scale {
    pub state: Reading,
    pub filtered_kg: f64,
    pub tare_kg: f64,
    pub zero_kg: f64,
    pub history: VecDeque<f64>,
}
impl Scale {
    pub fn new() -> Self {
        Self {
            state: Reading::Settling,
            filtered_kg: 0.,
            tare_kg: 0.,
            zero_kg: 0.,
            history: VecDeque::new(),
        }
    }
    pub fn gross(&self) -> f64 {
        self.filtered_kg - self.zero_kg
    }
    pub fn grams(&self) -> f64 {
        ((self.gross() - self.tare_kg) * 5000.).round() * 0.2
    }
    pub fn tare(&mut self) -> Result<()> {
        ensure!(
            self.state == Reading::Stable && self.gross() >= -0.0002,
            "Tare requires a stable nonnegative load within capacity"
        );
        self.tare_kg = self.gross();
        Ok(())
    }
    pub fn zero(&mut self) -> Result<()> {
        ensure!(
            self.state == Reading::Stable && self.filtered_kg.abs() <= 0.12,
            "Zero requires a stable load within the assumed 2% range"
        );
        self.zero_kg = self.filtered_kg;
        self.tare_kg = 0.;
        Ok(())
    }
    pub fn step(&mut self, engine: &ApplianceEngine) -> Result<()> {
        let raw = -engine.stiffness("ranger_cell")? * engine.joint("ranger_cell")?.0 / 9.81 - 0.4;
        self.filtered_kg += (raw - self.filtered_kg) * -(-engine.timestep() / 0.12).exp_m1();
        self.history.push_back(self.filtered_kg);
        if self.history.len() > 500 {
            self.history.pop_front();
        }
        let low = self.history.iter().copied().fold(f64::INFINITY, f64::min);
        let high = self
            .history
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        self.state = if self.gross() > 6. {
            Reading::Overload
        } else if self.history.len() == 500 && high - low <= 0.0002 {
            Reading::Stable
        } else {
            Reading::Settling
        };
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WashPhase {
    Off,
    Filling,
    Heating,
    Ready,
    Wash,
    Drain,
    Rinse,
    Complete,
    DoorFault,
    RackFault,
    DrainFault,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Cleanliness {
    Dirty,
    Washing { cycle: u64 },
    Clean { cycle: u64 },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WashPart {
    Bowl,
    Beater,
}
impl WashPart {
    pub fn index(self) -> usize {
        match self {
            Self::Bowl => 0,
            Self::Beater => 1,
        }
    }
    pub fn body(self) -> &'static str {
        match self {
            Self::Bowl => "wash_hl_bowl",
            Self::Beater => "wash_hl_beater",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartState {
    pub loaded: bool,
    pub cleanliness: Cleanliness,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RackPosition {
    Inserted,
    Extended,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dishwasher {
    pub rack_target: RackPosition,
    pub rack_setpoint_m: f64,
    pub phase: WashPhase,
    pub tank_l: f64,
    pub boiler_l: f64,
    pub tank_c: f64,
    pub boiler_c: f64,
    pub elapsed_s: f64,
    pub heater_w: f64,
    pub drain_blocked: bool,
    pub delivered_j: f64,
    pub discharged_l: f64,
    pub rinse_l: f64,
    pub spray_turns: f64,
    pub cycle: u64,
    pub parts: [PartState; 2],
    pub load_exchange_j: f64,
}
impl Dishwasher {
    pub fn new() -> Self {
        Self {
            rack_target: RackPosition::Inserted,
            rack_setpoint_m: 0.,
            phase: WashPhase::Off,
            tank_l: 0.,
            boiler_l: 0.,
            tank_c: 20.,
            boiler_c: 20.,
            elapsed_s: 0.,
            heater_w: 0.,
            drain_blocked: false,
            delivered_j: 0.,
            discharged_l: 0.,
            rinse_l: 0.,
            spray_turns: 0.,
            cycle: 0,
            parts: [
                PartState {
                    loaded: false,
                    cleanliness: Cleanliness::Dirty,
                },
                PartState {
                    loaded: false,
                    cleanliness: Cleanliness::Dirty,
                },
            ],
            load_exchange_j: 0.,
        }
    }
    pub fn move_rack(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        let target = match self.rack_target {
            RackPosition::Inserted => 0.,
            RackPosition::Extended => -0.52,
        };
        // Assumed human-guided fixture speed. Preserve the setpoint in checkpoints.
        let travel = 0.025 * engine.timestep();
        self.rack_setpoint_m += (target - self.rack_setpoint_m).clamp(-travel, travel);
        engine.control("ucl_rack_fixture", self.rack_setpoint_m)
    }
    pub fn active(&self) -> bool {
        matches!(
            self.phase,
            WashPhase::Filling
                | WashPhase::Heating
                | WashPhase::Wash
                | WashPhase::Drain
                | WashPhase::Rinse
        )
    }
    pub fn placement(&self, engine: &ApplianceEngine) -> Result<Option<WashPhase>> {
        for part in [WashPart::Bowl, WashPart::Beater] {
            if self.parts[part.index()].loaded && !self.in_rack(engine, part)? {
                return Ok(Some(WashPhase::RackFault));
            }
        }
        if engine.joint("ucl_door_hinge")?.0.abs() > 2_f64.to_radians() {
            return Ok(Some(WashPhase::DoorFault));
        }
        if engine.joint("ucl_rack_slide")?.0.abs() > 0.01 {
            return Ok(Some(WashPhase::RackFault));
        }
        Ok(None)
    }
    pub fn in_rack(&self, engine: &ApplianceEngine, part: WashPart) -> Result<bool> {
        let (low, high) = engine.collision_bounds(part.body())?;
        let rack = engine.body_pose("ucl_wash_rack")?.0;
        Ok((0..3).all(|axis| {
            low[axis] - rack[axis] > [-0.27, -0.27, -0.04][axis]
                && high[axis] - rack[axis] < [0.27, 0.27, 0.42][axis]
        }))
    }
    pub fn require_access(&self, engine: &ApplianceEngine) -> Result<()> {
        let (rack_position, rack_velocity) = engine.joint("ucl_rack_slide")?;
        ensure!(
            !self.active()
                && engine.joint("ucl_door_hinge")?.0 >= 1.4
                && matches!(self.rack_target, RackPosition::Extended)
                && (self.rack_setpoint_m + 0.52).abs() < 1e-6
                && (rack_position + 0.52).abs() <= 0.01
                && rack_velocity.abs() <= 0.01,
            "Stop the cycle, open the door and wait for the fully extended rack to stop before handling parts"
        );
        Ok(())
    }
    pub fn load(&mut self, engine: &ApplianceEngine, part: WashPart) -> Result<()> {
        self.require_access(engine)?;
        ensure!(
            !self.parts.iter().any(|item| item.loaded) && self.in_rack(engine, part)?,
            "Place one part inside the empty rack before loading"
        );
        self.parts[part.index()].loaded = true;
        Ok(())
    }
    pub fn unload(&mut self, engine: &ApplianceEngine, part: WashPart) -> Result<()> {
        self.require_access(engine)?;
        ensure!(
            self.parts[part.index()].loaded,
            "The selected part is outside rack custody"
        );
        self.parts[part.index()].loaded = false;
        Ok(())
    }
    pub fn transition(&mut self, phase: WashPhase) {
        for item in &mut self.parts {
            if matches!(
                phase,
                WashPhase::Off
                    | WashPhase::DoorFault
                    | WashPhase::RackFault
                    | WashPhase::DrainFault
            ) && matches!(item.cleanliness, Cleanliness::Washing { .. })
            {
                item.cleanliness = Cleanliness::Dirty;
            } else if phase == WashPhase::Complete
                && item.loaded
                && matches!(item.cleanliness,Cleanliness::Washing{cycle} if cycle==self.cycle)
            {
                item.cleanliness = Cleanliness::Clean { cycle: self.cycle };
            }
        }
        self.phase = phase;
        self.elapsed_s = 0.;
    }
    pub fn prepare(&mut self, engine: &ApplianceEngine) -> Result<()> {
        ensure!(
            matches!(
                self.phase,
                WashPhase::Off
                    | WashPhase::Complete
                    | WashPhase::DoorFault
                    | WashPhase::RackFault
                    | WashPhase::DrainFault
            ),
            "Prepare requires an off, complete or fault state"
        );
        ensure!(
            self.placement(engine)?.is_none() && !self.drain_blocked,
            "Close the door, insert the rack and clear the drain"
        );
        self.transition(WashPhase::Filling);
        Ok(())
    }
    pub fn start(&mut self, engine: &ApplianceEngine) -> Result<()> {
        ensure!(
            self.phase == WashPhase::Ready
                && self.placement(engine)?.is_none()
                && self.tank_c >= 54.
                && self.boiler_c >= 80.,
            "Start requires an inserted rack, closed door and operating temperatures"
        );
        self.cycle += 1;
        for part in &mut self.parts {
            if part.loaded {
                part.cleanliness = Cleanliness::Washing { cycle: self.cycle };
            }
        }
        self.rinse_l = 0.;
        self.transition(WashPhase::Wash);
        Ok(())
    }
    pub fn spray(&self, engine: &mut ApplianceEngine) -> Result<()> {
        let enabled = matches!(self.phase, WashPhase::Wash | WashPhase::Rinse);
        for drive in ["ucl_lower_drive", "ucl_upper_drive"] {
            engine.actuator(
                drive,
                if enabled { 6. } else { 0. },
                if enabled { 0.2 } else { 0. },
                0.,
                if enabled { 0.2 } else { 0. },
            )?;
        }
        Ok(())
    }
    pub fn step(&mut self, engine: &mut ApplianceEngine, contents: &mut Contents) -> Result<()> {
        let dt = engine.timestep();
        if self.active() {
            if let Some(reason) = self.placement(engine)? {
                self.transition(reason);
            }
        }
        if self.phase == WashPhase::Filling {
            let tank_in = dt.min(12. - self.tank_l).max(0.);
            let boiler_in = (0.5 * dt).min(3. - self.boiler_l).max(0.);
            if tank_in > 0. {
                self.tank_c = (self.tank_c * self.tank_l + 20. * tank_in) / (self.tank_l + tank_in);
                self.tank_l += tank_in;
            }
            if boiler_in > 0. {
                self.boiler_c =
                    (self.boiler_c * self.boiler_l + 20. * boiler_in) / (self.boiler_l + boiler_in);
                self.boiler_l += boiler_in;
            }
            if self.tank_l >= 12. && self.boiler_l >= 3. {
                self.transition(WashPhase::Heating);
            }
        }
        let heating = matches!(
            self.phase,
            WashPhase::Heating
                | WashPhase::Ready
                | WashPhase::Wash
                | WashPhase::Drain
                | WashPhase::Rinse
                | WashPhase::Complete
        ) && self.placement(engine)?.is_none();
        let tank_w = if heating && self.tank_c < 55. && self.tank_l >= 10. {
            3000.
        } else {
            0.
        };
        let boiler_w = if heating && self.boiler_c < 82. && self.boiler_l >= 2. {
            3900.
        } else {
            0.
        };
        self.heater_w = tank_w + boiler_w;
        self.delivered_j += self.heater_w * dt;
        self.tank_c += (tank_w - 8. * (self.tank_c - 20.)) * dt / (self.tank_l.max(0.1) * 4180.);
        self.boiler_c +=
            (boiler_w - 3. * (self.boiler_c - 20.)) * dt / (self.boiler_l.max(0.1) * 4180.);
        self.elapsed_s += dt;
        match self.phase {
            WashPhase::Heating if self.tank_c >= 54.9 && self.boiler_c >= 81.9 => {
                self.transition(WashPhase::Ready)
            }
            WashPhase::Wash if self.elapsed_s >= 20. => self.transition(WashPhase::Drain),
            WashPhase::Drain => {
                if !self.drain_blocked {
                    let amount = (0.2 * dt).min((self.tank_l - 11.).max(0.));
                    self.tank_l -= amount;
                    self.discharged_l += amount;
                }
                if self.elapsed_s >= 6. && self.tank_l > 11.001 {
                    self.transition(WashPhase::DrainFault);
                    self.heater_w = 0.;
                } else if self.tank_l <= 11.000000001 && self.boiler_c >= 80. {
                    self.transition(WashPhase::Rinse);
                }
            }
            WashPhase::Rinse => {
                let amount = (0.125 * dt).min(1. - self.rinse_l);
                self.tank_c =
                    (self.tank_c * self.tank_l + self.boiler_c * amount) / (self.tank_l + amount);
                self.tank_l += amount;
                self.boiler_l -= amount;
                self.rinse_l += amount;
                if self.rinse_l >= 1. {
                    self.transition(WashPhase::Complete);
                }
            }
            _ => {}
        }
        self.spray_turns += engine.joint("ucl_lower_spin")?.1.abs() * dt / std::f64::consts::TAU;
        if self.tank_l > 0.
            && matches!(self.phase, WashPhase::Wash | WashPhase::Rinse)
            && self.placement(engine)?.is_none()
        {
            self.load_exchange_j +=
                contents.exchange(&mut self.tank_c, self.tank_l * 4180., 40., dt)?;
        }
        self.spray(engine)
    }
}
