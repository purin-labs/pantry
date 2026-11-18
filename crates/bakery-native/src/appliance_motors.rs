//! Motor control, placement gates and ingredient work for removable vessels.
use crate::{
    appliances::{Contents, Name, Program, Vessel, rpm},
    native::ApplianceEngine,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::f64::consts::TAU;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum MotorState {
    Ready,
    Running {
        target_rpm: f64,
        remaining_s: f64,
        elapsed_s: f64,
        stalled_s: f64,
    },
    Paused {
        target_rpm: f64,
        remaining_s: f64,
        reason: String,
    },
    Complete,
    Fault {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MotorController {
    pub state: MotorState,
    pub command_rpm: f64,
    pub turns: f64,
    pub work_j: f64,
    pub load_work_j: f64,
    pub base_damping: f64,
}

pub struct MotorSpec {
    pub drive: &'static str,
    pub shaft: &'static str,
    pub gain: f64,
    pub ramp: f64,
    pub drag: f64,
    pub divisor: f64,
}

pub fn spec(name: Name) -> Result<MotorSpec> {
    match name {
        Name::Aicoh | Name::Hobart => Ok(MotorSpec {
            drive: "mix_drive",
            shaft: "mix_spin",
            gain: 20.,
            ramp: 250.,
            drag: 0.025,
            divisor: 3.,
        }),
        Name::Vitamix => Ok(MotorSpec {
            drive: "tqo_drive",
            shaft: "tqo_spin",
            gain: 0.02,
            ramp: 20000.,
            drag: 0.002,
            divisor: 1.,
        }),
        Name::Waring => Ok(MotorSpec {
            drive: "wsg_drive",
            shaft: "wsg_spin",
            gain: 0.02,
            ramp: 20000.,
            drag: 0.001,
            divisor: 1.,
        }),
        Name::Severin => Ok(MotorSpec {
            drive: "sm3587_mix_drive",
            shaft: "sm3587_stirrer_spin",
            gain: 0.002,
            ramp: 600000.,
            drag: 0.001,
            divisor: 1.,
        }),
        Name::LagomCasa => Ok(MotorSpec {
            drive: "casa_burr_drive",
            shaft: "casa_burr_spin",
            gain: 1.8,
            ramp: 1200.,
            drag: 0.008,
            divisor: 1.,
        }),
        Name::Bricks01s => Ok(MotorSpec {
            drive: "bricks_burr_drive",
            shaft: "bricks_burr_spin",
            gain: 1.8,
            ramp: 2000.,
            drag: 0.004,
            divisor: 1.,
        }),
        Name::FellowOpus2 => Ok(MotorSpec {
            drive: "opus_burr_drive",
            shaft: "opus_burr_spin",
            gain: 1.6,
            ramp: 1800.,
            drag: 0.004,
            divisor: 1.,
        }),
        Name::Df64Gen2 => Ok(MotorSpec {
            drive: "df64_burr_drive",
            shaft: "df64_burr_spin",
            gain: 1.8,
            ramp: 2000.,
            drag: 0.004,
            divisor: 1.,
        }),
        _ => anyhow::bail!("This appliance has no ingredient motor"),
    }
}

pub fn measured_rpm(name: Name, engine: &ApplianceEngine) -> Result<f64> {
    let settings = spec(name)?;
    let mut omega = engine.joint(settings.shaft)?.1;
    if matches!(name, Name::Aicoh | Name::Hobart) {
        omega += engine.joint("mix_orbit")?.1;
    }
    Ok(rpm(omega))
}

pub fn placement(
    name: Name,
    engine: &ApplianceEngine,
    vessel: &Vessel,
) -> Result<Option<&'static str>> {
    match name {
        Name::Aicoh | Name::Hobart => {
            if !engine.coupling("mix_bowl_coupling")? {
                return Ok(Some("bowl-detached"));
            }
            if engine.coupling("mix_beater_coupling")? == engine.coupling("mix_whip_coupling")? {
                return Ok(Some("tool-detached"));
            }
            if engine.joint("mix_guard")?.0.abs() > 2_f64.to_radians() {
                return Ok(Some("guard-open"));
            }
            if engine.joint("mix_lift")?.0 < -0.003 {
                return Ok(Some("bowl-lowered"));
            }
        }
        Name::Vitamix => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_JAR_UNSEATED"));
            }
            if engine.joint("tqo_lid_lift")?.0 > 0.004 {
                return Ok(Some("SIM_LID_OPEN"));
            }
            if engine.joint("tqo_door")?.0.abs() > 2_f64.to_radians() {
                return Ok(Some("SIM_ENCLOSURE_OPEN"));
            }
        }
        Name::Waring => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_BOWL_UNSEATED"));
            }
            if engine.joint("wsg_unlock")?.0.abs() > 2_f64.to_radians()
                || engine.joint("wsg_cover_lift")?.0 > 0.003
            {
                return Ok(Some("SIM_COVER_OPEN"));
            }
        }
        Name::Severin => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_JUG_REMOVED"));
            }
            if engine.joint("sm3587_lid_lift")?.0.abs() > 0.003 {
                return Ok(Some("SIM_LID_REMOVED"));
            }
        }
        Name::LagomCasa => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_CUP_UNSEATED"));
            }
            if engine.joint("casa_hopper_lift")?.0 > 0.003 {
                return Ok(Some("SIM_HOPPER_REMOVED"));
            }
            if engine.joint("casa_carrier_lift")?.0 > 0.003 {
                return Ok(Some("SIM_CARRIER_REMOVED"));
            }
        }
        Name::Bricks01s => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_CUP_UNSEATED"));
            }
            if engine.joint("bricks_lid_lift")?.0 > 0.003 {
                return Ok(Some("SIM_LID_OPEN"));
            }
            if engine.joint("bricks_hopper_lift")?.0 > 0.003 {
                return Ok(Some("SIM_HOPPER_REMOVED"));
            }
            if engine.joint("bricks_carrier_lift")?.0 > 0.003 {
                return Ok(Some("SIM_CARRIER_REMOVED"));
            }
        }
        Name::FellowOpus2 => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_CUP_UNSEATED"));
            }
            if engine.joint("opus_lid_lift")?.0 > 0.003 {
                return Ok(Some("SIM_LID_OPEN"));
            }
            if engine.joint("opus_hopper_lift")?.0 > 0.003 {
                return Ok(Some("SIM_HOPPER_REMOVED"));
            }
            if engine.joint("opus_carrier_lift")?.0 > 0.003 {
                return Ok(Some("SIM_CARRIER_REMOVED"));
            }
        }
        Name::Df64Gen2 => {
            if !vessel.seated(name, engine)? {
                return Ok(Some("SIM_CUP_UNSEATED"));
            }
            if engine.joint("df64_lid_stroke")?.0 > 0.003 {
                return Ok(Some("SIM_LID_OPEN"));
            }
            if engine.joint("df64_bellows_stroke")?.0 > 0.003 {
                return Ok(Some("SIM_BELLOWS_REMOVED"));
            }
            if engine.joint("df64_upper_carrier_lift")?.0 > 0.003 {
                return Ok(Some("SIM_CARRIER_REMOVED"));
            }
        }
        _ => anyhow::bail!("This appliance has no motor placement gate"),
    }
    Ok(None)
}

impl MotorController {
    pub fn new(name: Name, engine: &mut ApplianceEngine) -> Result<Self> {
        let settings = spec(name)?;
        engine.actuator(settings.drive, 0., 0., 0., 0.)?;
        Ok(Self {
            state: MotorState::Ready,
            command_rpm: 0.,
            turns: 0.,
            work_j: 0.,
            load_work_j: 0.,
            base_damping: engine.damping(settings.shaft)?,
        })
    }
    pub fn busy(&self, name: Name, engine: &ApplianceEngine) -> Result<bool> {
        Ok(matches!(self.state, MotorState::Running { .. })
            || measured_rpm(name, engine)?.abs() > 1.)
    }
    pub fn start(
        &mut self,
        name: Name,
        program: &Program,
        engine: &ApplianceEngine,
        vessel: &Vessel,
        contents: &Contents,
    ) -> Result<()> {
        program.validate(name)?;
        ensure!(
            matches!(self.state, MotorState::Ready | MotorState::Complete),
            "Reset or resume the stopped motor before starting"
        );
        ensure!(
            measured_rpm(name, engine)?.abs() <= 1. && placement(name, engine, vessel)?.is_none(),
            "Restore and settle the complete motor assembly before starting"
        );
        let (target, duration) = match program {
            Program::Planetary {
                setting,
                duration_s,
            } => {
                let speeds = if name == Name::Aicoh {
                    [120., 220., 320., 430.]
                } else {
                    [59., 107., 198., 365.]
                };
                (speeds[usize::from(*setting) - 1], *duration_s)
            }
            Program::Blend {
                percent,
                duration_s,
            } => (f64::from(*percent) * 240., *duration_s),
            Program::Grind { duration_s } => {
                let rpm = match name {
                    Name::LagomCasa => 200.,
                    Name::Bricks01s => 450.,
                    Name::FellowOpus2 => 400.,
                    Name::Df64Gen2 => 1400.,
                    _ => 20000.,
                };
                (rpm, *duration_s)
            }
            Program::ColdMix { duration_s } => (600., *duration_s),
            Program::HeatedMix { .. } => (600., 600.),
            _ => anyhow::bail!("Program does not operate an ingredient motor"),
        };
        if name == Name::Severin {
            ensure!(
                contents
                    .batch()
                    .is_some_and(|batch| (0.12..=0.7).contains(&batch.volume())),
                "Load 120–700 ml before stirring"
            );
        }
        self.state = MotorState::Running {
            target_rpm: target,
            remaining_s: duration,
            elapsed_s: 0.,
            stalled_s: 0.,
        };
        self.turns = 0.;
        self.work_j = 0.;
        Ok(())
    }
    pub fn stop(&mut self, name: Name, engine: &mut ApplianceEngine) -> Result<()> {
        if let MotorState::Running {
            target_rpm,
            remaining_s,
            ..
        } = self.state
        {
            self.state = if matches!(name, Name::Aicoh | Name::Hobart) {
                MotorState::Paused {
                    target_rpm,
                    remaining_s,
                    reason: "operator-stop".into(),
                }
            } else {
                MotorState::Ready
            };
        }
        self.disable(name, engine)
    }
    pub fn disable(&mut self, name: Name, engine: &mut ApplianceEngine) -> Result<()> {
        self.command_rpm = 0.;
        set_power_button(name, engine, false)?;
        let settings = spec(name)?;
        let brake = if matches!(
            name,
            Name::LagomCasa | Name::Bricks01s | Name::FellowOpus2 | Name::Df64Gen2
        ) {
            settings.gain
        } else {
            0.
        };
        engine.actuator(settings.drive, 0., brake, 0., brake)
    }
    pub fn reset(&mut self, name: Name, engine: &ApplianceEngine, vessel: &Vessel) -> Result<()> {
        ensure!(
            !self.busy(name, engine)? && placement(name, engine, vessel)?.is_none(),
            "Restore and settle the assembly before reset"
        );
        self.state = MotorState::Ready;
        Ok(())
    }
    pub fn resume(&mut self, name: Name, engine: &ApplianceEngine, vessel: &Vessel) -> Result<()> {
        ensure!(
            placement(name, engine, vessel)?.is_none(),
            "Restore the mixer before resuming"
        );
        if let MotorState::Paused {
            target_rpm,
            remaining_s,
            ..
        } = self.state
        {
            self.state = MotorState::Running {
                target_rpm,
                remaining_s,
                elapsed_s: 0.,
                stalled_s: 0.,
            };
            Ok(())
        } else {
            anyhow::bail!("Resume requires a paused mixer")
        }
    }
    pub fn before_step(
        &mut self,
        name: Name,
        engine: &mut ApplianceEngine,
        vessel: &Vessel,
        contents: &Contents,
    ) -> Result<()> {
        self.check_placement(name, engine, vessel)?;
        let settings = spec(name)?;
        let coupled = !matches!(name, Name::Aicoh | Name::Hobart)
            || placement(name, engine, vessel)?.is_none();
        let drag = if coupled {
            contents.drag(settings.drag)
        } else {
            0.
        };
        engine.set_damping(settings.shaft, self.base_damping + drag)?;
        if let MotorState::Running { target_rpm, .. } = self.state {
            set_power_button(name, engine, true)?;
            let maximum = settings.ramp * engine.timestep();
            self.command_rpm += (target_rpm - self.command_rpm).clamp(-maximum, maximum);
            engine.actuator(
                settings.drive,
                self.command_rpm / settings.divisor * TAU / 60.,
                settings.gain,
                0.,
                settings.gain,
            )?;
        } else {
            self.disable(name, engine)?;
        }
        Ok(())
    }
    fn check_placement(
        &mut self,
        name: Name,
        engine: &ApplianceEngine,
        vessel: &Vessel,
    ) -> Result<()> {
        if let (
            MotorState::Running {
                target_rpm,
                remaining_s,
                ..
            },
            Some(reason),
        ) = (&self.state, placement(name, engine, vessel)?)
        {
            self.state = if matches!(name, Name::Aicoh | Name::Hobart) {
                MotorState::Paused {
                    target_rpm: *target_rpm,
                    remaining_s: *remaining_s,
                    reason: reason.into(),
                }
            } else {
                MotorState::Fault {
                    reason: reason.into(),
                }
            };
        }
        Ok(())
    }
    pub fn after_step(
        &mut self,
        name: Name,
        engine: &mut ApplianceEngine,
        vessel: &Vessel,
        contents: &mut Contents,
    ) -> Result<()> {
        let settings = spec(name)?;
        let dt = engine.timestep();
        let speed = measured_rpm(name, engine)?;
        self.turns += speed.abs() * dt / 60.;
        let omega = engine.joint(settings.shaft)?.1;
        let drag = engine.damping(settings.shaft)? - self.base_damping;
        let load_work = drag * omega * omega * dt;
        contents.heat(load_work)?;
        self.load_work_j += load_work;
        let drive_omega = if matches!(name, Name::Aicoh | Name::Hobart) {
            engine.joint("mix_orbit")?.1
        } else {
            omega
        };
        self.work_j += (engine.actuator_force(settings.drive)? * drive_omega).max(0.) * dt;
        self.check_placement(name, engine, vessel)?;
        if let MotorState::Running {
            target_rpm,
            remaining_s,
            elapsed_s,
            stalled_s,
        } = &mut self.state
        {
            *remaining_s = (*remaining_s - dt).max(0.);
            *elapsed_s += dt;
            let grace = if name == Name::Severin {
                1.
            } else if name == Name::Waring {
                3.
            } else {
                2.
            };
            let ratio = if name == Name::Severin { 0.1 } else { 0.2 };
            *stalled_s = if *elapsed_s > grace && speed.abs() < *target_rpm * ratio {
                *stalled_s + dt
            } else {
                0.
            };
            let debounce = if name == Name::Vitamix { 0.3 } else { 0.5 };
            if *stalled_s >= debounce {
                self.state = MotorState::Fault {
                    reason: "SIM_STALL".into(),
                };
            } else if *remaining_s == 0. {
                self.state = MotorState::Complete;
            }
        }
        if !matches!(self.state, MotorState::Running { .. }) {
            self.disable(name, engine)?;
            engine.forward();
        }
        Ok(())
    }
}

fn set_power_button(name: Name, engine: &mut ApplianceEngine, pressed: bool) -> Result<()> {
    match name {
        Name::LagomCasa => engine.control("casa_power_actuator", if pressed { 0.001 } else { 0. }),
        Name::Bricks01s => {
            engine.control("bricks_power_actuator", if pressed { 0.0012 } else { 0. })
        }
        Name::FellowOpus2 => {
            engine.control("opus_power_actuator", if pressed { 0.001 } else { 0. })
        }
        Name::Df64Gen2 => engine.control("df64_power_actuator", if pressed { 0.002 } else { 0. }),
        _ => Ok(()),
    }
}
