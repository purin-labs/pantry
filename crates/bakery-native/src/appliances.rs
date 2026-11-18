//! Appliance execution shares the native and Wasm runner, requests and checkpoints.
use crate::native::ApplianceEngine;
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{f64::consts::PI, path::Path};

// Generated from assets/bakery-mujoco/appliances.json by scripts/bakery-robots/appliance-registry.mjs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
pub enum Name {
    #[serde(rename = "la-marzocco-linea-classic-s-2g")]
    #[value(name = "la-marzocco-linea-classic-s-2g")]
    Linea,
    #[serde(rename = "victoria-arduino-eagle-one-2g")]
    #[value(name = "victoria-arduino-eagle-one-2g")]
    EagleOne,
    #[serde(rename = "victoria-arduino-e1-prima")]
    #[value(name = "victoria-arduino-e1-prima")]
    E1Prima,
    #[serde(rename = "maruzen-mih-02c")]
    #[value(name = "maruzen-mih-02c")]
    MaruzenHob,
    #[serde(rename = "vollrath-59500p")]
    #[value(name = "vollrath-59500p")]
    Vollrath,
    #[serde(rename = "panasonic-kz-ck1402")]
    #[value(name = "panasonic-kz-ck1402")]
    PanasonicKzCk1402,
    #[serde(rename = "rinnai-rsb-150pj")]
    #[value(name = "rinnai-rsb-150pj")]
    RinnaiRsb150pj,
    #[serde(rename = "hoshizaki-rt-120snj")]
    #[value(name = "hoshizaki-rt-120snj")]
    Refrigerator,
    #[serde(rename = "maruzen-mbco-5e")]
    #[value(name = "maruzen-mbco-5e")]
    Oven,
    #[serde(rename = "aicoh-ms-30")]
    #[value(name = "aicoh-ms-30")]
    Aicoh,
    #[serde(rename = "hobart-hl200")]
    #[value(name = "hobart-hl200")]
    Hobart,
    #[serde(rename = "vitamix-quiet-one")]
    #[value(name = "vitamix-quiet-one")]
    Vitamix,
    #[serde(rename = "waring-wsg60")]
    #[value(name = "waring-wsg60")]
    Waring,
    #[serde(rename = "severin-sm-3587")]
    #[value(name = "severin-sm-3587")]
    Severin,
    #[serde(rename = "ohaus-ranger-3000")]
    #[value(name = "ohaus-ranger-3000")]
    Scale,
    #[serde(rename = "winterhalter-uc-l")]
    #[value(name = "winterhalter-uc-l")]
    Dishwasher,
    #[serde(rename = "option-o-lagom-casa")]
    #[value(name = "option-o-lagom-casa")]
    LagomCasa,
    #[serde(rename = "timemore-bricks-01s")]
    #[value(name = "timemore-bricks-01s")]
    Bricks01s,
    #[serde(rename = "fellow-opus-2")]
    #[value(name = "fellow-opus-2")]
    FellowOpus2,
    #[serde(rename = "miicoffee-df64-gen2")]
    #[value(name = "miicoffee-df64-gen2")]
    Df64Gen2,
    #[serde(rename = "hoshizaki-im-35p")]
    #[value(name = "hoshizaki-im-35p")]
    IceMaker,
    #[serde(rename = "pastry-bench")]
    #[value(name = "pastry-bench")]
    PastryBench,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
pub enum Grinder {
    #[serde(rename = "option-o-lagom-casa", alias = "lagom-casa")]
    #[value(name = "option-o-lagom-casa", alias = "lagom-casa")]
    LagomCasa,
    #[serde(rename = "timemore-bricks-01s", alias = "bricks-01s")]
    #[value(name = "timemore-bricks-01s", alias = "bricks-01s")]
    Bricks01s,
    #[serde(rename = "fellow-opus-2", alias = "opus-2")]
    #[value(name = "fellow-opus-2", alias = "opus-2")]
    FellowOpus2,
    #[serde(rename = "miicoffee-df64-gen2", alias = "df64-gen2")]
    #[value(name = "miicoffee-df64-gen2", alias = "df64-gen2")]
    Df64Gen2,
}

impl Grinder {
    pub const ALL: [Self; 4] = [
        Self::LagomCasa,
        Self::Bricks01s,
        Self::FellowOpus2,
        Self::Df64Gen2,
    ];
    pub fn appliance(self) -> Name {
        match self {
            Self::LagomCasa => Name::LagomCasa,
            Self::Bricks01s => Name::Bricks01s,
            Self::FellowOpus2 => Name::FellowOpus2,
            Self::Df64Gen2 => Name::Df64Gen2,
        }
    }
    pub fn espresso_dial_rad(self) -> f64 {
        match self {
            Self::LagomCasa => -1.5,
            Self::Bricks01s => -2.4,
            Self::FellowOpus2 => -3.2,
            Self::Df64Gen2 => -0.95,
        }
    }
    pub fn pour_over_dial_rad(self) -> f64 {
        match self {
            Self::LagomCasa => 2.1,
            Self::Bricks01s => 3.6,
            Self::FellowOpus2 => 4.2,
            Self::Df64Gen2 => 0.35,
        }
    }
}

impl Name {
    // Generated from assets/bakery-mujoco/appliances.json by scripts/bakery-robots/appliance-registry.mjs.
    pub const ALL: [Self; 22] = [
        Self::Linea,
        Self::EagleOne,
        Self::E1Prima,
        Self::MaruzenHob,
        Self::Vollrath,
        Self::PanasonicKzCk1402,
        Self::RinnaiRsb150pj,
        Self::Refrigerator,
        Self::Oven,
        Self::Aicoh,
        Self::Hobart,
        Self::Vitamix,
        Self::Waring,
        Self::Severin,
        Self::Scale,
        Self::Dishwasher,
        Self::LagomCasa,
        Self::Bricks01s,
        Self::FellowOpus2,
        Self::Df64Gen2,
        Self::IceMaker,
        Self::PastryBench,
    ];
    // Generated from assets/bakery-mujoco/appliances.json by scripts/bakery-robots/appliance-registry.mjs.
    pub fn folder(self) -> &'static str {
        match self {
            Self::Linea => "la-marzocco-linea-classic-s-2g",
            Self::EagleOne => "victoria-arduino-eagle-one-2g",
            Self::E1Prima => "victoria-arduino-e1-prima",
            Self::MaruzenHob => "maruzen-mih-02c",
            Self::Vollrath => "vollrath-59500p",
            Self::PanasonicKzCk1402 => "panasonic-kz-ck1402",
            Self::RinnaiRsb150pj => "rinnai-rsb-150pj",
            Self::Refrigerator => "hoshizaki-rt-120snj",
            Self::Oven => "maruzen-mbco-5e",
            Self::Aicoh => "aicoh-ms-30",
            Self::Hobart => "hobart-hl200",
            Self::Vitamix => "vitamix-quiet-one",
            Self::Waring => "waring-wsg60",
            Self::Severin => "severin-sm-3587",
            Self::Scale => "ohaus-ranger-3000",
            Self::Dishwasher => "winterhalter-uc-l",
            Self::LagomCasa => "option-o-lagom-casa",
            Self::Bricks01s => "timemore-bricks-01s",
            Self::FellowOpus2 => "fellow-opus-2",
            Self::Df64Gen2 => "miicoffee-df64-gen2",
            Self::IceMaker => "hoshizaki-im-35p",
            Self::PastryBench => "pastry-bench",
        }
    }
    pub fn port(self) -> Port {
        match self {
            Self::MaruzenHob | Self::Vollrath | Self::PanasonicKzCk1402 | Self::RinnaiRsb150pj => {
                Port {
                    body: "ih_pan",
                    radius: 0.094,
                    bottom: 0.006,
                    maximum_l: 1.,
                }
            }
            Self::Refrigerator => Port {
                body: "rt_container",
                radius: 0.07,
                bottom: -0.04,
                maximum_l: 1.2,
            },
            Self::Oven => Port {
                body: "mbco_tray",
                radius: 0.15,
                bottom: 0.012,
                maximum_l: 2.,
            },
            Self::Aicoh => Port {
                body: "ms_bowl",
                radius: 0.059,
                bottom: 0.004,
                maximum_l: 3.,
            },
            Self::Hobart => Port {
                body: "hl_bowl",
                radius: 0.042,
                bottom: 0.002,
                maximum_l: 1.2,
            },
            Self::Vitamix => Port {
                body: "tqo_container",
                radius: 0.05,
                bottom: 0.045,
                maximum_l: 1.4,
            },
            Self::Waring => Port {
                body: "wsg_bowl",
                radius: 0.045,
                bottom: 0.035,
                maximum_l: 0.65,
            },
            Self::Severin => Port {
                body: "sm3587_jug",
                radius: 0.06,
                bottom: 0.005,
                maximum_l: 0.7,
            },
            Self::Scale => Port {
                body: "ranger_weighing_pan",
                radius: 0.08,
                bottom: 0.005,
                maximum_l: 6.,
            },
            Self::EagleOne => Port {
                body: "eo_left_portafilter",
                radius: 0.025,
                bottom: -0.008,
                maximum_l: 0.05,
            },
            Self::E1Prima => Port {
                body: "e1p_portafilter",
                radius: 0.0288,
                bottom: 0.005,
                maximum_l: 0.05,
            },
            Self::Linea => Port {
                body: "lcs_left_portafilter",
                radius: 0.025,
                bottom: -0.008,
                maximum_l: 0.05,
            },
            Self::Dishwasher => Port {
                body: "ucl_wash_rack",
                radius: 0.2,
                bottom: 0.02,
                maximum_l: 10.,
            },
            Self::LagomCasa => Port {
                body: "casa_dosing_cup",
                radius: 0.028,
                bottom: 0.022,
                maximum_l: 0.35,
            },
            Self::Bricks01s => Port {
                body: "bricks_dosing_cup",
                radius: 0.019,
                bottom: 0.02,
                maximum_l: 0.35,
            },
            Self::FellowOpus2 => Port {
                body: "opus_catch_cup",
                radius: 0.031,
                bottom: 0.021,
                maximum_l: 0.35,
            },
            Self::Df64Gen2 => Port {
                body: "df64_dosing_cup",
                radius: 0.026,
                bottom: 0.014,
                maximum_l: 0.35,
            },
            Self::IceMaker => Port {
                body: "im_scoop",
                radius: 0.032,
                bottom: -0.048,
                maximum_l: 1.5,
            },
            Self::PastryBench => Port {
                body: "pb_dough_carrier",
                radius: 0.082,
                bottom: 0.006,
                maximum_l: 2.0,
            },
        }
    }
}

pub struct Port {
    pub body: &'static str,
    pub radius: f64,
    pub bottom: f64,
    pub maximum_l: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    identity: String,
    mass_kg: f64,
    temperature_c: f64,
    specific_heat: f64,
    density_kg_l: f64,
    resistance: f64,
}

impl Batch {
    pub(crate) fn espresso_dose(identity: String) -> Self {
        Self {
            identity,
            mass_kg: 0.018,
            temperature_c: 20.,
            specific_heat: 1500.,
            density_kg_l: 0.5,
            resistance: 0.,
        }
    }
    pub(crate) fn coffee_dose(identity: String, grams: f64, resistance: f64) -> Self {
        Self {
            identity,
            mass_kg: grams / 1000.,
            temperature_c: 20.,
            specific_heat: 1500.,
            density_kg_l: 0.5,
            resistance,
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.identity.trim().is_empty() && self.identity.len() <= 128,
            "A batch needs a bounded identity"
        );
        ensure!(
            [
                self.mass_kg,
                self.temperature_c,
                self.specific_heat,
                self.density_kg_l,
                self.resistance
            ]
            .iter()
            .all(|x| x.is_finite()),
            "Batch values must be finite"
        );
        ensure!(
            self.mass_kg > 0.
                && self.specific_heat > 0.
                && self.density_kg_l > 0.
                && (-20. ..=300.).contains(&self.temperature_c)
                && (0. ..=100.).contains(&self.resistance),
            "Invalid batch properties"
        );
        Ok(())
    }
    pub fn capacity(&self) -> f64 {
        self.mass_kg * self.specific_heat
    }
    pub fn energy(&self) -> f64 {
        self.capacity() * self.temperature_c
    }
    pub fn volume(&self) -> f64 {
        self.mass_kg / self.density_kg_l
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    pub fn mass(&self) -> f64 {
        self.mass_kg
    }
    pub fn temperature(&self) -> f64 {
        self.temperature_c
    }
    pub fn add_heat(&mut self, joules: f64) -> Result<()> {
        ensure!(joules.is_finite(), "Nonfinite batch heat exchange");
        self.temperature_c += joules / self.capacity();
        ensure!(
            self.temperature_c.is_finite(),
            "Nonfinite batch temperature"
        );
        Ok(())
    }
    pub fn split(self, identity: String, mass: f64) -> Result<(Self, Self)> {
        ensure!(
            mass.is_finite() && mass > 0. && mass < self.mass_kg,
            "Portion mass must be smaller than the original batch"
        );
        let portion = Self {
            identity,
            mass_kg: mass,
            ..self.clone()
        };
        portion.validate()?;
        ensure!(
            portion.identity != self.identity,
            "Portion identity must be distinct"
        );
        let retained = Self {
            mass_kg: self.mass_kg - mass,
            ..self
        };
        Ok((retained, portion))
    }
    pub fn combine(identity: String, first: Self, second: Self) -> Result<Self> {
        first.validate()?;
        second.validate()?;
        ensure!(
            first.identity != second.identity,
            "A batch cannot combine with itself"
        );
        let mass = first.mass_kg + second.mass_kg;
        let capacity = first.capacity() + second.capacity();
        let result = Self {
            identity,
            mass_kg: mass,
            temperature_c: (first.energy() + second.energy()) / capacity,
            specific_heat: capacity / mass,
            density_kg_l: mass / (first.volume() + second.volume()),
            resistance: (first.resistance * first.mass_kg + second.resistance * second.mass_kg)
                / mass,
        };
        result.validate()?;
        Ok(result)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Contents {
    Empty,
    Loaded { batch: Batch },
}
impl Contents {
    pub fn batch(&self) -> Option<&Batch> {
        match self {
            Self::Empty => None,
            Self::Loaded { batch } => Some(batch),
        }
    }
    pub fn heat(&mut self, energy: f64) -> Result<()> {
        match self {
            Self::Empty => Ok(()),
            Self::Loaded { batch } => batch.add_heat(energy),
        }
    }
    pub fn validate(&self, name: Name) -> Result<()> {
        if let Self::Loaded { batch } = self {
            batch.validate()?;
            ensure!(
                batch.volume() <= name.port().maximum_l,
                "Contents exceed the vessel fixture volume"
            );
        }
        Ok(())
    }
    pub fn apply(&self, name: Name, engine: &mut ApplianceEngine) -> Result<()> {
        self.validate(name)?;
        let port = name.port();
        match self {
            Self::Empty => engine.set_payload(0., port.radius, port.bottom, 0.),
            Self::Loaded { batch } => {
                engine.set_payload(batch.mass_kg, port.radius, port.bottom, batch.volume())
            }
        }
    }
    pub fn drag(&self, coefficient: f64) -> f64 {
        match self {
            Self::Empty => 0.,
            Self::Loaded { batch } => {
                coefficient
                    * batch.mass_kg
                    * batch.resistance
                    * ((20. - batch.temperature_c) / 60.).clamp(-2., 2.).exp()
            }
        }
    }
    pub fn exchange(
        &mut self,
        reservoir: &mut f64,
        capacity: f64,
        conductance: f64,
        dt: f64,
    ) -> Result<f64> {
        match self {
            Self::Empty => Ok(0.),
            Self::Loaded { batch } => {
                let inverse = 1. / batch.capacity() + 1. / capacity;
                let heat = (*reservoir - batch.temperature_c)
                    * -(-conductance * inverse * dt).exp_m1()
                    / inverse;
                batch.add_heat(heat)?;
                *reservoir -= heat / capacity;
                Ok(heat)
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Hand {
    Released,
    Holding {
        position: [f64; 3],
        quaternion: [f64; 4],
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vessel {
    pub coupled: bool,
    pub hand: Hand,
}

impl Vessel {
    pub fn initial() -> Self {
        Self {
            coupled: true,
            hand: Hand::Released,
        }
    }
    pub fn errors(&self, name: Name, engine: &ApplianceEngine) -> Result<(f64, f64, f64)> {
        let (position, quaternion) = engine.body_pose(name.port().body)?;
        let socket = engine.site("vessel_socket")?;
        let speed = engine.body_velocity(name.port().body)?;
        Ok((
            norm3(sub3(position, socket)),
            2. * quaternion[0].abs().clamp(0., 1.).acos(),
            speed.iter().map(|v| v * v).sum::<f64>().sqrt(),
        ))
    }
    pub fn seated(&self, name: Name, engine: &ApplianceEngine) -> Result<bool> {
        let (position, angle, _) = self.errors(name, engine)?;
        Ok(self.coupled && position < 0.003 && angle < 0.03)
    }
    pub fn apply(&mut self, name: Name, engine: &mut ApplianceEngine) -> Result<()> {
        let body = name.port().body;
        let (position, quaternion) = engine.body_pose(body)?;
        let velocity = engine.body_velocity(body)?;
        let mut force = [0.; 6];
        let target_quaternion = match self.hand {
            Hand::Holding {
                position: target,
                quaternion: orientation,
            } => {
                for axis in 0..3 {
                    force[axis] = (1800. * (target[axis] - position[axis])
                        - 80. * velocity[axis + 3])
                        .clamp(-80., 80.);
                }
                force[2] += engine.body_mass(body)? * 9.81;
                orientation
            }
            Hand::Released if self.coupled => {
                let (distance, angle, _) = self.errors(name, engine)?;
                if distance > 0.006 || angle > 0.1 {
                    self.coupled = false;
                    return engine.apply_force(body, force);
                }
                let target = engine.site("vessel_socket")?;
                for axis in 0..2 {
                    force[axis] = (2500. * (target[axis] - position[axis])
                        - 80. * velocity[axis + 3])
                        .clamp(-80., 80.);
                }
                [1., 0., 0., 0.]
            }
            Hand::Released => return engine.apply_force(body, force),
        };
        let error = rotation_error(target_quaternion, quaternion);
        for axis in 0..3 {
            force[axis + 3] = (100. * error[axis] - 0.2 * velocity[axis]).clamp(-5., 5.);
        }
        engine.apply_force(body, force)
    }
}

pub fn norm3(value: [f64; 3]) -> f64 {
    value.iter().map(|v| v * v).sum::<f64>().sqrt()
}
pub fn sub3(first: [f64; 3], second: [f64; 3]) -> [f64; 3] {
    [
        first[0] - second[0],
        first[1] - second[1],
        first[2] - second[2],
    ]
}
pub fn rotation_error(target: [f64; 4], current: [f64; 4]) -> [f64; 3] {
    let target = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        target[0], target[1], target[2], target[3],
    ));
    let current = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        current[0], current[1], current[2], current[3],
    ));
    (target * current.inverse()).scaled_axis().into()
}

pub fn apply_pose_wrench(
    engine: &mut ApplianceEngine,
    body: &str,
    target: [f64; 3],
    orientation: [f64; 4],
) -> Result<()> {
    let (position, quaternion) = engine.body_pose(body)?;
    let velocity = engine.body_velocity(body)?;
    let rotation = rotation_error(orientation, quaternion);
    let dt = engine.timestep();
    let min_inertia = engine.body_min_inertia(body)?;
    let angular_stiffness = (0.2 * min_inertia / (dt * dt)).min(20.);
    let angular_damping = (0.65 * min_inertia / dt).min(1.);
    let mut force = [0.; 6];
    for axis in 0..3 {
        force[axis] = 1800. * (target[axis] - position[axis]) - 100. * velocity[axis + 3];
        force[axis + 3] = (angular_stiffness * rotation[axis] - angular_damping * velocity[axis])
            .clamp(-10., 10.);
    }
    force[2] += engine.body_mass(body)? * 9.81;
    for value in &mut force[..3] {
        *value = value.clamp(-150., 150.);
    }
    engine.apply_force(body, force)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Program {
    EspressoShotPreset {
        group: crate::appliance_espresso::Group,
        slot: crate::appliance_espresso::DoseSlot,
    },
    EspressoHotWaterPreset,
    EspressoWarmup {
        coffee_c: f64,
        steam_c: f64,
    },
    EspressoHotWater {
        duration_s: f64,
    },
    EspressoShot {
        group: crate::appliance_espresso::Group,
        duration_s: f64,
    },
    Planetary {
        setting: u8,
        duration_s: f64,
    },
    Blend {
        percent: u8,
        duration_s: f64,
    },
    Grind {
        duration_s: f64,
    },
    ColdMix {
        duration_s: f64,
    },
    HeatedMix {
        target_c: f64,
    },
    HobPower {
        percent: f64,
        duration_s: f64,
    },
    HobTemperature {
        target_c: f64,
        duration_s: f64,
    },
    Preheat {
        target_c: f64,
    },
    Bake {
        target_c: f64,
        duration_s: f64,
    },
    Refrigerate,
    MakeIce,
    Weigh,
    Wash,
    PressDoughBlock {
        target_height_mm: f64,
        duration_s: f64,
    },
    SheetShortcrust {
        target_thickness_mm: f64,
        duration_s: f64,
    },
    DrapePuffLid {
        crimp_force_n: f64,
        duration_s: f64,
    },
}

impl Program {
    pub fn validate(&self, name: Name) -> Result<()> {
        match (name, self) {
            (
                Name::Linea | Name::EagleOne | Name::E1Prima,
                Self::EspressoShotPreset { group, .. },
            ) => {
                ensure!(
                    name != Name::E1Prima
                        || matches!(group, crate::appliance_espresso::Group::Left),
                    "This espresso machine has one brew group"
                );
            }
            (Name::Linea | Name::EagleOne | Name::E1Prima, Self::EspressoHotWaterPreset) => {}
            (
                Name::Linea | Name::EagleOne | Name::E1Prima,
                Self::EspressoWarmup { coffee_c, steam_c },
            ) => {
                range(*coffee_c, 85., 96.)?;
                range(*steam_c, 110., 130.)?;
            }
            (
                Name::Linea | Name::EagleOne | Name::E1Prima,
                Self::EspressoShot { group, duration_s },
            ) => {
                ensure!(
                    name != Name::E1Prima
                        || matches!(group, crate::appliance_espresso::Group::Left),
                    "This espresso machine has one brew group"
                );
                range(*duration_s, 1., 60.)?;
            }
            (
                Name::Linea | Name::EagleOne | Name::E1Prima,
                Self::EspressoHotWater { duration_s },
            ) => range(*duration_s, 1., 60.)?,
            (
                Name::Aicoh | Name::Hobart,
                Self::Planetary {
                    setting,
                    duration_s,
                },
            ) => {
                ensure!((1..=4).contains(setting), "Choose mixer setting 1–4");
                range(*duration_s, 1., 900.)?;
            }
            (
                Name::Vitamix,
                Self::Blend {
                    percent,
                    duration_s,
                },
            ) => {
                ensure!((7..=100).contains(percent), "Choose blend percentage 7–100");
                range(*duration_s, 1., 120.)?;
            }
            (Name::Waring, Self::Grind { duration_s }) => range(*duration_s, 1., 150.)?,
            (Name::LagomCasa, Self::Grind { duration_s }) => range(*duration_s, 1., 90.)?,
            (Name::Bricks01s, Self::Grind { duration_s }) => range(*duration_s, 1., 60.)?,
            (Name::FellowOpus2, Self::Grind { duration_s }) => range(*duration_s, 1., 120.)?,
            (Name::Df64Gen2, Self::Grind { duration_s }) => range(*duration_s, 1., 90.)?,
            (Name::Severin, Self::ColdMix { duration_s }) => range(*duration_s, 1., 180.)?,
            (Name::Severin, Self::HeatedMix { target_c }) => range(*target_c, 45., 65.)?,
            (
                Name::MaruzenHob | Name::Vollrath | Name::PanasonicKzCk1402 | Name::RinnaiRsb150pj,
                Self::HobPower {
                    percent,
                    duration_s,
                },
            ) => {
                range(*percent, 1., 100.)?;
                range(*duration_s, 1., 10800.)?;
            }
            (
                Name::Vollrath | Name::PanasonicKzCk1402 | Name::RinnaiRsb150pj,
                Self::HobTemperature {
                    target_c,
                    duration_s,
                },
            ) => {
                range(*target_c, 45., 90.)?;
                range(*duration_s, 1., 10800.)?;
            }
            (Name::Oven, Self::Preheat { target_c }) => range(*target_c, 50., 300.)?,
            (
                Name::Oven,
                Self::Bake {
                    target_c,
                    duration_s,
                },
            ) => {
                range(*target_c, 50., 300.)?;
                range(*duration_s, 10., 5990.)?;
            }
            (Name::Refrigerator, Self::Refrigerate)
            | (Name::IceMaker, Self::MakeIce | Self::Refrigerate)
            | (Name::Scale, Self::Weigh)
            | (Name::Dishwasher, Self::Wash) => {}
            (
                Name::PastryBench,
                Self::PressDoughBlock {
                    target_height_mm,
                    duration_s,
                },
            ) => {
                range(*target_height_mm, 16.0, 28.0)?;
                range(*duration_s, 0.4, 120.0)?;
            }
            (
                Name::PastryBench,
                Self::SheetShortcrust {
                    target_thickness_mm,
                    duration_s,
                },
            ) => {
                range(*target_thickness_mm, 1.5, 8.0)?;
                range(*duration_s, 0.4, 120.0)?;
            }
            (
                Name::PastryBench,
                Self::DrapePuffLid {
                    crimp_force_n,
                    duration_s,
                },
            ) => {
                range(*crimp_force_n, 10.0, 120.0)?;
                range(*duration_s, 0.4, 120.0)?;
            }
            _ => bail!("Program does not belong to this appliance"),
        }
        Ok(())
    }
}

pub fn range(value: f64, minimum: f64, maximum: f64) -> Result<()> {
    ensure!(
        value.is_finite() && (minimum..=maximum).contains(&value),
        "Value must be within {minimum}–{maximum}"
    );
    Ok(())
}

pub fn load_engine(root: &Path, name: Name) -> Result<ApplianceEngine> {
    ApplianceEngine::load(
        &root
            .join("assets/bakery-mujoco")
            .join(name.folder())
            .join("native.xml"),
    )
}

pub fn rpm(omega: f64) -> f64 {
    omega * 60. / (2. * PI)
}
