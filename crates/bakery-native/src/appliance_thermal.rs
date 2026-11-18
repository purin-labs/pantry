//! Lumped thermal models. Coefficients remain assumptions pending calibration.
use crate::{
    appliances::{Contents, Name, Program},
    native::ApplianceEngine,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OvenState {
    Off,
    Preheating { target_c: f64, stable_s: f64 },
    Ready { target_c: f64 },
    Baking { target_c: f64, remaining_s: f64 },
    Paused { target_c: f64, remaining_s: f64 },
    Complete,
    Cooling,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Oven {
    pub state: OvenState,
    pub chamber_c: f64,
    pub tray_c: f64,
    pub heater_w: f64,
    pub heater_call: bool,
    pub input_j: f64,
    pub loss_j: f64,
    pub load_exchange_j: f64,
}
impl Oven {
    pub fn new() -> Self {
        Self {
            state: OvenState::Off,
            chamber_c: 22.,
            tray_c: 22.,
            heater_w: 0.,
            heater_call: false,
            input_j: 0.,
            loss_j: 0.,
            load_exchange_j: 0.,
        }
    }
    pub fn start(&mut self, program: &Program, engine: &ApplianceEngine) -> Result<()> {
        program.validate(Name::Oven)?;
        match *program {
            Program::Preheat { target_c } => {
                ensure!(
                    matches!(
                        self.state,
                        OvenState::Off | OvenState::Complete | OvenState::Cooling
                    ),
                    "Stop the oven before selecting preheat"
                );
                self.state = OvenState::Preheating {
                    target_c,
                    stable_s: 0.,
                };
                self.heater_call = false;
            }
            Program::Bake {
                target_c,
                duration_s,
            } => {
                ensure!(
                    matches!(self.state,OvenState::Ready{target_c:ready} if ready==target_c)
                        && oven_closed(engine)?,
                    "Preheat with the door closed before starting the timer"
                );
                self.state = OvenState::Baking {
                    target_c,
                    remaining_s: duration_s,
                };
            }
            _ => anyhow::bail!("Select an oven program"),
        }
        Ok(())
    }
    pub fn stop(&mut self, cooldown: bool) {
        self.state = if cooldown {
            OvenState::Cooling
        } else {
            OvenState::Off
        };
        self.heater_call = false;
        self.heater_w = 0.;
    }
    pub fn resume(&mut self, engine: &ApplianceEngine) -> Result<()> {
        let OvenState::Paused {
            target_c,
            remaining_s,
        } = self.state
        else {
            anyhow::bail!("Only a paused oven timer can resume")
        };
        ensure!(
            oven_closed(engine)? && self.chamber_c >= target_c - 5.,
            "Close the door and recover temperature before resuming"
        );
        self.state = OvenState::Baking {
            target_c,
            remaining_s,
        };
        Ok(())
    }
    pub fn step(&mut self, engine: &ApplianceEngine, contents: &mut Contents) -> Result<()> {
        let dt = engine.timestep();
        let closed = oven_closed(engine)?;
        match self.state {
            OvenState::Baking {
                target_c,
                remaining_s,
            } => {
                self.state = if !closed {
                    OvenState::Paused {
                        target_c,
                        remaining_s,
                    }
                } else if remaining_s <= dt + 1e-9 {
                    OvenState::Complete
                } else {
                    OvenState::Baking {
                        target_c,
                        remaining_s: remaining_s - dt,
                    }
                };
            }
            OvenState::Ready { target_c } if !closed || (self.chamber_c - target_c).abs() > 3. => {
                self.state = OvenState::Preheating {
                    target_c,
                    stable_s: 0.,
                }
            }
            _ => {}
        }
        match self.state {
            OvenState::Preheating { target_c, .. }
            | OvenState::Ready { target_c }
            | OvenState::Baking { target_c, .. }
            | OvenState::Paused { target_c, .. }
                if closed =>
            {
                if self.chamber_c <= target_c - 2. {
                    self.heater_call = true;
                } else if self.chamber_c >= target_c + 2. {
                    self.heater_call = false;
                }
            }
            _ => self.heater_call = false,
        }
        self.heater_w = if self.heater_call { 9000. } else { 0. };
        let aperture =
            (engine.joint("mbco_door_hinge")?.0 / std::f64::consts::FRAC_PI_2).clamp(0., 1.);
        let chamber_loss = (8. + 80. * aperture) * (self.chamber_c - 22.);
        let inside = inside(
            engine,
            "mbco_tray",
            [0., 0., 0.009],
            [0.2, 0.3, 0.01],
            [-0.32, -0.348, 0.135],
            [0.12, 0.322, 0.611],
        )?;
        let transfer = if inside {
            25. * (self.chamber_c - self.tray_c)
        } else {
            0.
        };
        let tray_loss = if inside { 0. } else { 5. * (self.tray_c - 22.) };
        self.chamber_c += (self.heater_w - chamber_loss - transfer) * dt / 18000.;
        self.tray_c += (transfer - tray_loss) * dt / 1000.;
        self.input_j += self.heater_w * dt;
        self.loss_j += (chamber_loss + tray_loss) * dt;
        if let OvenState::Preheating { target_c, stable_s } = self.state {
            let stable = if closed && (self.chamber_c - target_c).abs() <= 3. {
                stable_s + dt
            } else {
                0.
            };
            self.state = if stable >= 10. {
                OvenState::Ready { target_c }
            } else {
                OvenState::Preheating {
                    target_c,
                    stable_s: stable,
                }
            };
        } else if matches!(self.state, OvenState::Cooling)
            && self
                .chamber_c
                .max(self.tray_c)
                .max(contents.batch().map_or(22., |b| b.temperature()))
                < 40.
        {
            self.state = OvenState::Off;
        }
        self.load_exchange_j += contents.exchange(&mut self.tray_c, 1000., 15., dt)?;
        Ok(())
    }
}
pub fn oven_closed(engine: &ApplianceEngine) -> Result<bool> {
    Ok(engine.joint("mbco_door_hinge")?.0.abs() <= 2_f64.to_radians())
}

pub fn inside(
    engine: &ApplianceEngine,
    body: &str,
    center: [f64; 3],
    half: [f64; 3],
    low: [f64; 3],
    high: [f64; 3],
) -> Result<bool> {
    let (position, q) = engine.body_pose(body)?;
    let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        q[0], q[1], q[2], q[3],
    ))
    .to_rotation_matrix();
    let center = nalgebra::Vector3::from(position) + rotation * nalgebra::Vector3::from(center);
    let extent = rotation.matrix().map(f64::abs) * nalgebra::Vector3::from(half);
    Ok((0..3).all(|axis| {
        center[axis] - extent[axis] > low[axis] && center[axis] + extent[axis] < high[axis]
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cooling {
    Off,
    Holding,
    Cooling,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Door {
    Closed,
    Opening,
    Open,
    Closing { blocked_s: f64 },
    Blocked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refrigerator {
    pub cooling: Cooling,
    pub doors: [Door; 2],
    pub cabinet_c: f64,
    pub container_c: f64,
    pub ambient_j: f64,
    pub removed_j: f64,
    pub electric_j: f64,
    pub cooling_w: f64,
    pub load_exchange_j: f64,
}
impl Refrigerator {
    pub fn new() -> Self {
        Self {
            cooling: Cooling::Off,
            doors: [Door::Closed, Door::Closed],
            cabinet_c: 22.,
            container_c: 22.,
            ambient_j: 0.,
            removed_j: 0.,
            electric_j: 0.,
            cooling_w: 0.,
            load_exchange_j: 0.,
        }
    }
    pub fn door(&mut self, engine: &mut ApplianceEngine, right: bool, open: bool) -> Result<()> {
        let index = usize::from(right);
        ensure!(
            open || !matches!(self.doors[index], Door::Blocked),
            "Open the obstructed door before closing again"
        );
        self.doors[index] = if open {
            Door::Opening
        } else {
            Door::Closing { blocked_s: 0. }
        };
        engine.actuator(
            if right {
                "rt_right_fixture"
            } else {
                "rt_left_fixture"
            },
            if open { 100_f64.to_radians() } else { 0. },
            18.,
            18.,
            5.,
        )
    }
    pub fn step(&mut self, engine: &mut ApplianceEngine, contents: &mut Contents) -> Result<()> {
        let dt = engine.timestep();
        let mut aperture = 0.;
        for (index, side) in ["left", "right"].into_iter().enumerate() {
            let angle = engine.joint(&format!("rt_{side}_hinge"))?.0;
            aperture += (angle / std::f64::consts::FRAC_PI_2).clamp(0., 1.);
            match self.doors[index] {
                Door::Closing { blocked_s } => {
                    let contact = engine.contact_force(
                        &format!("rt_{side}_door_contact"),
                        "rt_container_contact",
                    )?;
                    let blocked = if angle > 3_f64.to_radians() && contact > 1. {
                        blocked_s + dt
                    } else {
                        0.
                    };
                    self.doors[index] = if blocked >= 0.3 {
                        engine.actuator(&format!("rt_{side}_fixture"), 0., 0., 0., 0.)?;
                        Door::Blocked
                    } else if angle.abs() < 0.5_f64.to_radians() {
                        Door::Closed
                    } else {
                        Door::Closing { blocked_s: blocked }
                    };
                }
                Door::Opening if (angle - 100_f64.to_radians()).abs() < 1_f64.to_radians() => {
                    self.doors[index] = Door::Open
                }
                _ => {}
            }
        }
        if !matches!(self.cooling, Cooling::Off) {
            if self.cabinet_c >= 4. {
                self.cooling = Cooling::Cooling;
            } else if self.cabinet_c <= 2. {
                self.cooling = Cooling::Holding;
            }
        }
        let electric = if matches!(self.cooling, Cooling::Cooling) {
            115.
        } else {
            0.
        };
        self.cooling_w = 2.2 * electric;
        let ambient = (2. + 30. * aperture) * (22. - self.cabinet_c);
        let stored = inside(
            engine,
            "rt_container",
            [0.; 3],
            [0.073, 0.113, 0.048],
            [-0.289, -0.198, 0.155],
            [0.551, 0.243, 0.734],
        )?;
        let transfer = if stored {
            6. * (self.container_c - self.cabinet_c)
        } else {
            0.
        };
        let container_air = if stored {
            0.
        } else {
            2. * (22. - self.container_c)
        };
        self.cabinet_c += (ambient + transfer - self.cooling_w) * dt / 6000.;
        self.container_c += (container_air - transfer) * dt / 3500.;
        self.ambient_j += (ambient + container_air) * dt;
        self.removed_j += self.cooling_w * dt;
        self.electric_j += electric * dt;
        self.load_exchange_j += contents.exchange(&mut self.container_c, 3500., 20., dt)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HobState {
    Off,
    Running {
        program: Program,
        elapsed_s: f64,
        absent_s: f64,
    },
    Complete,
    Fault {
        reason: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hob {
    pub state: HobState,
    pub pan_c: f64,
    pub plate_c: f64,
    pub heater_w: f64,
    pub input_j: f64,
    pub loss_j: f64,
    pub compatible: bool,
    pub seated: bool,
}
impl Hob {
    pub fn new() -> Self {
        Self {
            state: HobState::Off,
            pan_c: 20.,
            plate_c: 20.,
            heater_w: 0.,
            input_j: 0.,
            loss_j: 0.,
            compatible: true,
            seated: false,
        }
    }
    pub fn start(&mut self, name: Name, program: &Program) -> Result<()> {
        program.validate(name)?;
        ensure!(
            matches!(self.state, HobState::Off | HobState::Complete),
            "Stop or reset the hob before starting"
        );
        self.state = HobState::Running {
            program: program.clone(),
            elapsed_s: 0.,
            absent_s: 0.,
        };
        Ok(())
    }
    pub fn reset(&mut self, contents: &Contents) -> Result<()> {
        ensure!(
            !matches!(self.state, HobState::Running { .. })
                && self.pan_c <= 100.
                && contents.batch().is_none_or(|b| b.temperature() <= 90.),
            "Stop and cool the pan and contents before reset"
        );
        self.state = HobState::Off;
        Ok(())
    }
    pub fn step(
        &mut self,
        name: Name,
        engine: &ApplianceEngine,
        contents: &mut Contents,
    ) -> Result<()> {
        let dt = engine.timestep();
        let support = engine.contact_force("ih_plate", "ih_pan_base")?;
        let bottom = engine.site("ih_pan_bottom")?;
        let zone = engine.site("ih_zone")?;
        let (_, q) = engine.body_pose("ih_pan")?;
        self.seated = support >= 1.
            && (bottom[0] - zone[0]).hypot(bottom[1] - zone[1]) <= 0.035
            && (bottom[2] - zone[2]).abs() < 0.002
            && 1. - 2. * (q[1] * q[1] + q[2] * q[2]) >= 5_f64.to_radians().cos();
        self.heater_w = 0.;
        if let HobState::Running {
            program,
            elapsed_s,
            absent_s,
        } = &mut self.state
        {
            *elapsed_s += dt;
            let duration = match program {
                Program::HobPower { duration_s, .. }
                | Program::HobTemperature { duration_s, .. } => *duration_s,
                _ => anyhow::bail!("Invalid hob continuation program"),
            };
            if *elapsed_s >= duration {
                self.state = HobState::Complete;
            } else if !self.seated || !self.compatible {
                *absent_s += dt;
                if name == Name::MaruzenHob {
                    self.state = HobState::Fault {
                        reason: "SIM_PAN_REMOVED_OR_INCOMPATIBLE".into(),
                    };
                } else if name == Name::PanasonicKzCk1402 && *absent_s >= 60. {
                    self.state = HobState::Off;
                } else if *absent_s >= 600. {
                    self.state = HobState::Off;
                }
            } else {
                *absent_s = 0.;
                let rated = match name {
                    Name::MaruzenHob => 2000.,
                    Name::PanasonicKzCk1402 => 1400.,
                    Name::RinnaiRsb150pj => 3380.,
                    _ => 1800.,
                };
                self.heater_w = rated
                    * match program {
                        Program::HobPower { percent, .. } => *percent / 100.,
                        Program::HobTemperature { target_c, .. } => {
                            ((*target_c - self.pan_c) / 8.).clamp(0., 1.)
                        }
                        _ => unreachable!(),
                    };
            }
        }
        self.guard(contents);
        let content_c = contents.batch().map_or(20., |b| b.temperature());
        let to_contents = if contents.batch().is_some() {
            60. * (self.pan_c - content_c)
        } else {
            0.
        };
        let to_plate = if support >= 1. {
            8. * (self.pan_c - self.plate_c)
        } else {
            0.
        };
        let pan_loss = 2. * (self.pan_c - 20.);
        let contents_loss = if contents.batch().is_some() {
            0.6 * (content_c - 20.)
        } else {
            0.
        };
        let plate_loss = 3. * (self.plate_c - 20.);
        let input = self.heater_w * 0.85;
        self.pan_c += (input - to_contents - to_plate - pan_loss) * dt / 500.;
        self.plate_c += (to_plate - plate_loss) * dt / 900.;
        contents.heat((to_contents - contents_loss) * dt)?;
        self.input_j += input * dt;
        self.loss_j += (pan_loss + contents_loss + plate_loss) * dt;
        self.guard(contents);
        Ok(())
    }
    fn guard(&mut self, contents: &Contents) {
        if matches!(self.state, HobState::Running { .. }) {
            if self.pan_c >= 150. {
                self.state = HobState::Fault {
                    reason: "SIM_PAN_OVERHEAT".into(),
                };
                self.heater_w = 0.;
            } else if contents.batch().is_some_and(|b| b.temperature() >= 95.) {
                self.state = HobState::Fault {
                    reason: "SIM_CONTENTS_LIMIT".into(),
                };
                self.heater_w = 0.;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IceCyclePhase {
    Standby,
    Freezing,
    Harvest,
    BinFull,
    DoorInterlock,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IceMaker {
    pub phase: IceCyclePhase,
    pub door_open: bool,
    pub evaporator_c: f64,
    pub bin_c: f64,
    pub scoop_c: f64,
    pub bin_ice_kg: f64,
    pub ambient_j: f64,
    pub removed_j: f64,
    pub electric_j: f64,
    pub cooling_w: f64,
    pub load_exchange_j: f64,
}

impl IceMaker {
    pub fn new() -> Self {
        Self {
            phase: IceCyclePhase::Standby,
            door_open: false,
            evaporator_c: 12.,
            bin_c: -1.5,
            scoop_c: 4.,
            bin_ice_kg: 10.,
            ambient_j: 0.,
            removed_j: 0.,
            electric_j: 0.,
            cooling_w: 0.,
            load_exchange_j: 0.,
        }
    }
    pub fn start(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        let angle = engine.joint("im_door_hinge")?.0;
        self.door_open = angle > 2_f64.to_radians();
        self.phase = if self.door_open {
            IceCyclePhase::DoorInterlock
        } else if self.bin_ice_kg >= 10.5 {
            IceCyclePhase::BinFull
        } else {
            IceCyclePhase::Freezing
        };
        engine.control("im_power_switch_actuator", 0.28)?;
        engine.control("im_water_plate_actuator", 0.)?;
        Ok(())
    }
    pub fn stop(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        self.phase = IceCyclePhase::Standby;
        self.cooling_w = 0.;
        engine.control("im_power_switch_actuator", 0.)?;
        Ok(())
    }
    pub fn door(&mut self, engine: &mut ApplianceEngine, open: bool) -> Result<()> {
        self.door_open = open;
        engine.control(
            "im_door_actuator",
            if open { 52_f64.to_radians() } else { 0. },
        )?;
        Ok(())
    }
    pub fn step(&mut self, engine: &mut ApplianceEngine, contents: &mut Contents) -> Result<()> {
        let dt = engine.timestep();
        let angle = engine.joint("im_door_hinge")?.0;
        self.door_open = angle > 2_f64.to_radians();
        let aperture = (angle / 52_f64.to_radians()).clamp(0., 1.);
        if self.door_open && !matches!(self.phase, IceCyclePhase::Standby) {
            self.phase = IceCyclePhase::DoorInterlock;
        } else if !self.door_open && matches!(self.phase, IceCyclePhase::DoorInterlock) {
            self.phase = if self.bin_ice_kg >= 10.5 {
                IceCyclePhase::BinFull
            } else {
                IceCyclePhase::Freezing
            };
        }
        let active = !matches!(self.phase, IceCyclePhase::Standby);
        engine.control("im_power_switch_actuator", if active { 0.28 } else { 0. })?;
        if matches!(self.phase, IceCyclePhase::Freezing) {
            engine.control("im_water_plate_actuator", 0.)?;
        }
        let electric = match self.phase {
            IceCyclePhase::Freezing => 195.,
            IceCyclePhase::Harvest => 215.,
            IceCyclePhase::BinFull | IceCyclePhase::DoorInterlock => 4.,
            IceCyclePhase::Standby => 0.,
        };
        self.cooling_w = if matches!(self.phase, IceCyclePhase::Freezing) {
            410.
        } else {
            0.
        };
        let evap_gain = (3.5 + 18. * aperture) * (20. - self.evaporator_c);
        self.evaporator_c += (evap_gain - self.cooling_w) * dt / 1800.;
        let bin_gain = (1.6 + 22. * aperture) * (20. - self.bin_c);
        let ice_sink = if self.bin_ice_kg > 0. {
            14. * (self.bin_c - (-1.5))
        } else {
            0.
        };
        self.bin_c += (bin_gain - ice_sink) * dt / 4200.;
        let stored = inside(
            engine,
            "im_scoop",
            [0., 0., -0.02],
            [0.042, 0.042, 0.055],
            [-0.22, -0.20, 0.14],
            [0.22, 0.20, 0.56],
        )?;
        let transfer = if stored {
            9. * (self.scoop_c - self.bin_c)
        } else {
            0.
        };
        let scoop_air = if stored {
            0.
        } else {
            2.2 * (20. - self.scoop_c)
        };
        self.scoop_c += (scoop_air - transfer) * dt / 2500.;
        self.ambient_j += (evap_gain + bin_gain + scoop_air) * dt;
        self.removed_j += (self.cooling_w + ice_sink.max(0.)) * dt;
        self.electric_j += electric * dt;
        self.load_exchange_j += contents.exchange(&mut self.scoop_c, 2500., 18., dt)?;
        Ok(())
    }
}
