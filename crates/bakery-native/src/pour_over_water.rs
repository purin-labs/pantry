//! The pour-over station's water: a small deterministic process model beside
//! the physical controller. It is not a fluid solver and models no extraction
//! chemistry. Every assumption below is declared in the station README.
use anyhow::{Result, ensure};
use nalgebra::{Matrix3, UnitQuaternion, Vector3};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

use crate::native::BodyLoad;

pub type Point = Vector3<f64>;

const DENSITY_KG_M3: f64 = 1000.;
/// The kettle's interior is a cylinder above its base, in the kettle frame.
const KETTLE_RADIUS_M: f64 = 0.057;
const KETTLE_FLOOR_M: f64 = 0.006;
const KETTLE_DEPTH_M: f64 = 0.125;
/// The gooseneck draws from near the floor; an exposed inlet admits air.
const SPOUT_INLET_M: [f64; 3] = [0.055, 0., 0.02];
/// A 6 mm bore with an assumed discharge coefficient for the whole spout.
const OUTLET_AREA_M2: f64 = PI * 0.003 * 0.003;
const DISCHARGE_COEFFICIENT: f64 = 0.62;
const VELOCITY_COEFFICIENT: f64 = 0.95;
/// An inverted kettle empties through its lid opening at this rate.
const LID_ESCAPE_KG_S: f64 = 0.2;
/// Areas measured from the dripper axis, on the bed surface plane.
pub const BED_RADIUS_M: f64 = 0.040;
pub const DRIPPER_INNER_RADIUS_M: f64 = 0.055;
/// Saturated grounds retain this much water per unit of dry coffee.
const RETENTION_RATIO: f64 = 2.0;
const WETTING_SECONDS: f64 = 4.0;
/// Free water above the bed drains as a linear reservoir.
const NOMINAL_DRAIN_SECONDS: f64 = 16.0;
/// Evaporation from the wet bed, proportional to its excess temperature.
const EVAPORATION_KG_S_K: f64 = 1.0e-7;
const AMBIENT_C: f64 = 25.;
const KETTLE_COOLING_S: f64 = 1800.;
const BED_COOLING_S: f64 = 400.;
const SERVER_COOLING_S: f64 = 900.;
/// The stream loses this much temperature between spout and bed.
const STREAM_COOLING_C: f64 = 2.;
/// Dry coffee's heat capacity as an equivalent mass of water.
const COFFEE_WATER_EQUIVALENT: f64 = 1.8 / 4.18;
/// Beverage in the server forms a cylinder above its floor, in its frame.
const SERVER_RADIUS_M: f64 = 0.056;
const SERVER_FLOOR_M: f64 = 0.005;
/// Water in the dripper sits in the bed, around this point in its frame.
const BED_CENTRE_M: [f64; 3] = [0., 0., 0.026];
const PANELS: usize = 64;
/// Every water step conserves the initial mass to this tolerance.
const CONSERVATION_KG: f64 = 1e-12;

/// Where a stream parcel lands, by the actual impact point.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Landing {
    Bed,
    Wall,
    Spill,
}

/// Water that left the spout and has not landed yet.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Parcel {
    pub mass_kg: f64,
    pub temperature_c: f64,
    pub land_step: usize,
    pub landing: Landing,
    pub point: [f64; 3],
    pub impact_mps: f64,
}

/// The free jet in the last step, for display: it is recorded, not inferred.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Stream {
    pub outlet: [f64; 3],
    pub velocity: [f64; 3],
    pub landing: [f64; 3],
    pub flight_s: f64,
}

/// Complete water and heat state at a completed integration step.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Water {
    pub initial_kg: f64,
    pub coffee_kg: f64,
    pub kettle_kg: f64,
    pub kettle_c: f64,
    /// The kettle's free-surface level along world up, in the kettle frame.
    pub level_m: f64,
    pub airborne: Vec<Parcel>,
    pub absorbed_kg: f64,
    pub free_kg: f64,
    pub bed_c: f64,
    pub server_kg: f64,
    pub server_c: f64,
    pub spill_kg: f64,
    pub evaporated_kg: f64,
    /// Water that left the spout, landed or not.
    pub poured_kg: f64,
    /// Water that landed inside the dripper but outside the bed area.
    pub off_bed_kg: f64,
    pub wet_radius_m: f64,
    pub flow_kg_s: f64,
    pub impact_n: f64,
    pub stream: Option<Stream>,
}

/// The kettle, outlet and bed as the solver placed them at this step.
pub struct Placement {
    pub kettle_position: Point,
    pub kettle_rotation: UnitQuaternion<f64>,
    pub outlet: Point,
    /// The jet direction: the outlet frame's X axis.
    pub outlet_axis: Point,
    pub outlet_velocity: Point,
    pub bed: Point,
}

/// The integer milligram distribution of all station material at completion.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub beverage_mg: u64,
    pub spent_bed_mg: u64,
    pub kettle_mg: u64,
    pub spill_mg: u64,
    pub evaporated_mg: u64,
}

struct Panels {
    abscissa: [f64; PANELS],
    weight: [f64; PANELS],
}

fn panels() -> Panels {
    let mut abscissa = [0.; PANELS];
    let mut weight = [0.; PANELS];
    for index in 0..PANELS {
        let angle = (index as f64 + 0.5) * PI / PANELS as f64;
        abscissa[index] = KETTLE_RADIUS_M * angle.cos();
        // Strip width 2·√(R²−ξ²) times dξ, with ξ = R·cos(angle).
        weight[index] =
            2. * KETTLE_RADIUS_M * KETTLE_RADIUS_M * angle.sin().powi(2) * PI / PANELS as f64;
    }
    Panels { abscissa, weight }
}

/// The water region below a free surface at `level` along `up`, in the
/// kettle frame: its volume, surface area and centroid.
struct Region {
    volume_m3: f64,
    slope: f64,
    centroid: Point,
}

fn region(panels: &Panels, up: &Point, level: f64) -> Region {
    let horizontal = (up.x * up.x + up.y * up.y).sqrt();
    let direction = if horizontal > 1e-12 {
        Point::new(up.x / horizontal, up.y / horizontal, 0.)
    } else {
        Point::zeros()
    };
    let mut volume = 0.;
    let mut slope = 0.;
    let mut first = 0.;
    let mut height = 0.;
    for index in 0..PANELS {
        let xi = panels.abscissa[index];
        let column = (level - horizontal * xi) / up.z - KETTLE_FLOOR_M;
        if column <= 0. {
            continue;
        }
        let wet = column.min(KETTLE_DEPTH_M);
        let weight = panels.weight[index];
        volume += weight * wet;
        if column < KETTLE_DEPTH_M {
            slope += weight / up.z;
        }
        first += weight * wet * xi;
        height += weight * wet * (KETTLE_FLOOR_M + wet / 2.);
    }
    let centroid = if volume > 0. {
        direction * (first / volume) + Point::new(0., 0., height / volume)
    } else {
        Point::new(0., 0., KETTLE_FLOOR_M)
    };
    Region {
        volume_m3: volume,
        slope,
        centroid,
    }
}

/// Solves the level that holds `volume` below it, starting from `guess`.
fn level_for(panels: &Panels, up: &Point, volume: f64, guess: f64) -> Result<f64> {
    let horizontal = (up.x * up.x + up.y * up.y).sqrt();
    let mut low = up.z * KETTLE_FLOOR_M - horizontal * KETTLE_RADIUS_M;
    let mut high = up.z * (KETTLE_FLOOR_M + KETTLE_DEPTH_M) + horizontal * KETTLE_RADIUS_M;
    let capacity = region(panels, up, high).volume_m3;
    ensure!(
        volume >= 0. && volume <= capacity,
        "Kettle water exceeds its interior"
    );
    let mut level = guess.clamp(low, high);
    for _ in 0..80 {
        let current = region(panels, up, level);
        let error = current.volume_m3 - volume;
        if error.abs() <= 1e-13 {
            return Ok(level);
        }
        if error > 0. {
            high = level;
        } else {
            low = level;
        }
        let newton = level - error / current.slope.max(1e-12);
        level = if current.slope > 1e-9 && newton > low && newton < high {
            newton
        } else {
            (low + high) / 2.
        };
        if high - low < 1e-13 {
            return Ok(level);
        }
    }
    Ok(level)
}

fn cool(temperature: f64, dt: f64, seconds: f64) -> f64 {
    temperature + (AMBIENT_C - temperature) * -(-dt / seconds).exp_m1()
}

impl Water {
    pub fn prepared(kettle_kg: f64, kettle_c: f64, coffee_kg: f64) -> Result<Self> {
        ensure!(
            kettle_kg.is_finite()
                && kettle_kg > 0.
                && kettle_c.is_finite()
                && coffee_kg.is_finite()
                && coffee_kg > 0.,
            "Invalid prepared water state"
        );
        let panels = panels();
        let up = Point::new(0., 0., 1.);
        let level = level_for(&panels, &up, kettle_kg / DENSITY_KG_M3, KETTLE_FLOOR_M)?;
        Ok(Self {
            initial_kg: kettle_kg,
            coffee_kg,
            kettle_kg,
            kettle_c,
            level_m: level,
            airborne: Vec::new(),
            absorbed_kg: 0.,
            free_kg: 0.,
            bed_c: AMBIENT_C,
            server_kg: 0.,
            server_c: AMBIENT_C,
            spill_kg: 0.,
            evaporated_kg: 0.,
            poured_kg: 0.,
            off_bed_kg: 0.,
            wet_radius_m: 0.,
            flow_kg_s: 0.,
            impact_n: 0.,
            stream: None,
        })
    }

    pub fn airborne_kg(&self) -> f64 {
        self.airborne.iter().map(|parcel| parcel.mass_kg).sum()
    }

    /// Water in the dripper bed: retained by the grounds or free above them.
    pub fn bed_kg(&self) -> f64 {
        self.absorbed_kg + self.free_kg
    }

    /// Water accounted in every place. It equals the prepared kettle water.
    pub fn total_kg(&self) -> f64 {
        self.kettle_kg
            + self.airborne_kg()
            + self.absorbed_kg
            + self.free_kg
            + self.server_kg
            + self.spill_kg
            + self.evaporated_kg
    }

    /// Checks conservation and every value's range, independently of targets.
    pub fn validate(&self) -> Result<()> {
        let values = [
            self.initial_kg,
            self.coffee_kg,
            self.kettle_kg,
            self.kettle_c,
            self.level_m,
            self.absorbed_kg,
            self.free_kg,
            self.bed_c,
            self.server_kg,
            self.server_c,
            self.spill_kg,
            self.evaporated_kg,
            self.poured_kg,
            self.off_bed_kg,
            self.wet_radius_m,
            self.flow_kg_s,
            self.impact_n,
        ];
        ensure!(
            values.iter().all(|value| value.is_finite())
                && [
                    self.kettle_kg,
                    self.absorbed_kg,
                    self.free_kg,
                    self.server_kg,
                    self.spill_kg,
                    self.evaporated_kg,
                    self.poured_kg,
                    self.off_bed_kg,
                    self.flow_kg_s,
                    self.impact_n,
                ]
                .iter()
                .all(|value| *value >= 0.)
                && self.absorbed_kg <= RETENTION_RATIO * self.coffee_kg + CONSERVATION_KG
                && self.airborne.len() <= 1024
                && self.airborne.iter().all(|parcel| {
                    parcel.mass_kg.is_finite()
                        && parcel.mass_kg >= 0.
                        && parcel.temperature_c.is_finite()
                        && parcel.impact_mps.is_finite()
                        && parcel.point.iter().all(|value| value.is_finite())
                }),
            "Invalid water state"
        );
        ensure!(
            (self.total_kg() - self.initial_kg).abs() <= CONSERVATION_KG * (1. + self.initial_kg)
                && (self.initial_kg - self.kettle_kg - self.poured_kg).abs()
                    <= CONSERVATION_KG * (1. + self.initial_kg),
            "Water is not conserved"
        );
        Ok(())
    }

    /// The kettle's free surface and spout head in the current placement.
    fn spout(&self, panels: &Panels, placement: &Placement) -> Result<(f64, f64, bool)> {
        let inverse = placement.kettle_rotation.inverse();
        let up = inverse * Point::new(0., 0., 1.);
        let outlet = inverse * (placement.outlet - placement.kettle_position);
        if up.z <= 0.1 {
            return Ok((self.level_m, 0., false));
        }
        let level = level_for(panels, &up, self.kettle_kg / DENSITY_KG_M3, self.level_m)?;
        let inlet = Point::from(SPOUT_INLET_M);
        let submerged = up.dot(&inlet) < level;
        Ok((level, level - up.dot(&outlet), submerged))
    }

    /// Advances water and heat by one solver step that ended at `step`.
    pub fn step(
        &mut self,
        step: usize,
        dt: f64,
        gravity: f64,
        placement: &Placement,
        drainage: f64,
    ) -> Result<()> {
        ensure!(
            dt > 0. && gravity > 0. && drainage > 0. && drainage <= 1.,
            "Invalid water step"
        );
        let panels = panels();
        // Spout flow from the actual kettle pose and its remaining water.
        let inverse = placement.kettle_rotation.inverse();
        let up = inverse * Point::new(0., 0., 1.);
        let mut released = 0.;
        let mut velocity = Point::zeros();
        self.stream = None;
        if self.kettle_kg > 0. {
            if up.z <= 0.1 {
                released = (LID_ESCAPE_KG_S * dt).min(self.kettle_kg);
                velocity = placement.outlet_velocity;
            } else {
                let (level, head, submerged) = self.spout(&panels, placement)?;
                self.level_m = level;
                if head > 0. && submerged {
                    let rate = DENSITY_KG_M3
                        * DISCHARGE_COEFFICIENT
                        * OUTLET_AREA_M2
                        * (2. * gravity * head).sqrt();
                    released = (rate * dt).min(self.kettle_kg);
                    velocity = placement.outlet_axis.normalize()
                        * (VELOCITY_COEFFICIENT * (2. * gravity * head).sqrt())
                        + placement.outlet_velocity;
                }
            }
        }
        self.flow_kg_s = released / dt;
        if released > 0. {
            self.kettle_kg -= released;
            if self.kettle_kg < 1e-15 {
                released += self.kettle_kg;
                self.kettle_kg = 0.;
            }
            self.poured_kg += released;
            let drop = placement.outlet.z - placement.bed.z;
            let (flight, impact, landing) = if drop > 0. {
                let flight =
                    (velocity.z + (velocity.z * velocity.z + 2. * gravity * drop).sqrt()) / gravity;
                let point = placement.outlet + velocity * flight
                    - Point::new(0., 0., gravity * flight * flight / 2.);
                (flight, (velocity.z - gravity * flight).abs(), point)
            } else {
                (0., velocity.z.abs(), placement.outlet)
            };
            let radius = ((landing.x - placement.bed.x).powi(2)
                + (landing.y - placement.bed.y).powi(2))
            .sqrt();
            let target = if drop <= 0. || radius > DRIPPER_INNER_RADIUS_M {
                Landing::Spill
            } else if radius > BED_RADIUS_M {
                Landing::Wall
            } else {
                Landing::Bed
            };
            self.airborne.push(Parcel {
                mass_kg: released,
                temperature_c: self.kettle_c - STREAM_COOLING_C,
                land_step: step + ((flight / dt).ceil() as usize).max(1),
                landing: target,
                point: landing.into(),
                impact_mps: impact,
            });
            self.stream = Some(Stream {
                outlet: placement.outlet.into(),
                velocity: velocity.into(),
                landing: landing.into(),
                flight_s: flight,
            });
        }
        // Parcels land at their step: into the dripper or as a spill.
        self.impact_n = 0.;
        let mut index = 0;
        while index < self.airborne.len() {
            if self.airborne[index].land_step > step {
                index += 1;
                continue;
            }
            let parcel = self.airborne.remove(index);
            match parcel.landing {
                Landing::Spill => self.spill_kg += parcel.mass_kg,
                Landing::Bed | Landing::Wall => {
                    let capacity =
                        self.absorbed_kg + self.free_kg + self.coffee_kg * COFFEE_WATER_EQUIVALENT;
                    self.bed_c = (self.bed_c * capacity + parcel.temperature_c * parcel.mass_kg)
                        / (capacity + parcel.mass_kg);
                    self.free_kg += parcel.mass_kg;
                    self.impact_n += parcel.mass_kg * parcel.impact_mps / dt;
                    if parcel.landing == Landing::Wall {
                        self.off_bed_kg += parcel.mass_kg;
                    } else {
                        let radius = ((parcel.point[0] - placement.bed.x).powi(2)
                            + (parcel.point[1] - placement.bed.y).powi(2))
                        .sqrt();
                        self.wet_radius_m = self.wet_radius_m.max(radius.min(BED_RADIUS_M));
                    }
                }
            }
        }
        // Grounds wet towards saturation; the rest drains into the server.
        let capacity = RETENTION_RATIO * self.coffee_kg;
        let wetting = ((capacity - self.absorbed_kg).max(0.) * -(-dt / WETTING_SECONDS).exp_m1())
            .min(self.free_kg);
        self.absorbed_kg += wetting;
        self.free_kg -= wetting;
        let drained = self.free_kg * -(-dt * drainage / NOMINAL_DRAIN_SECONDS).exp_m1();
        if drained > 0. {
            self.server_c = (self.server_c * self.server_kg + self.bed_c * drained)
                / (self.server_kg + drained);
            self.server_kg += drained;
            self.free_kg -= drained;
        }
        let wet = self.absorbed_kg + self.free_kg;
        let evaporated = (EVAPORATION_KG_S_K * (self.bed_c - AMBIENT_C).max(0.) * dt).min(wet);
        if wet > 0. {
            let from_free = evaporated.min(self.free_kg);
            self.free_kg -= from_free;
            self.absorbed_kg -= evaporated - from_free;
            self.evaporated_kg += evaporated;
        }
        self.kettle_c = cool(self.kettle_c, dt, KETTLE_COOLING_S);
        if wet > 0. {
            self.bed_c = cool(self.bed_c, dt, BED_COOLING_S);
        }
        if self.server_kg > 0. {
            self.server_c = cool(self.server_c, dt, SERVER_COOLING_S);
        }
        self.validate()
    }

    /// The kettle water's load in the kettle frame, in the actual pose.
    pub fn kettle_load(&self, rotation: &UnitQuaternion<f64>) -> Result<BodyLoad> {
        if self.kettle_kg <= 0. {
            return Ok(empty(Point::new(0., 0., KETTLE_FLOOR_M)));
        }
        let panels = panels();
        let up = rotation.inverse() * Point::new(0., 0., 1.);
        let (centroid, length) = if up.z > 0.1 {
            let level = level_for(&panels, &up, self.kettle_kg / DENSITY_KG_M3, self.level_m)?;
            (
                region(&panels, &up, level).centroid,
                self.kettle_kg / DENSITY_KG_M3 / (PI * KETTLE_RADIUS_M * KETTLE_RADIUS_M),
            )
        } else {
            (
                Point::new(0., 0., KETTLE_FLOOR_M + KETTLE_DEPTH_M / 2.),
                KETTLE_DEPTH_M,
            )
        };
        Ok(BodyLoad {
            mass_kg: self.kettle_kg,
            centre_m: centroid.into(),
            inertia_kgm2: water_cylinder(self.kettle_kg, KETTLE_RADIUS_M, length),
        })
    }

    /// The bed water's load in the dripper frame: retained and free water.
    pub fn bed_load(&self) -> BodyLoad {
        let water = self.bed_kg();
        BodyLoad {
            mass_kg: water,
            centre_m: BED_CENTRE_M,
            inertia_kgm2: water_cylinder(water, BED_RADIUS_M, 0.028),
        }
    }

    /// The beverage's load in the server frame.
    pub fn beverage_load(&self) -> BodyLoad {
        let length = self.server_kg / DENSITY_KG_M3 / (PI * SERVER_RADIUS_M * SERVER_RADIUS_M);
        BodyLoad {
            mass_kg: self.server_kg,
            centre_m: [0., 0., SERVER_FLOOR_M + length / 2.],
            inertia_kgm2: water_cylinder(self.server_kg, SERVER_RADIUS_M, length),
        }
    }

    /// The material distribution in integer milligrams. Rounding keeps the
    /// sum equal to the prepared water and coffee; nothing is in flight.
    pub fn distribution(&self) -> Result<Distribution> {
        ensure!(self.airborne.is_empty(), "Material is still in flight");
        let parts = [
            self.server_kg,
            self.absorbed_kg + self.free_kg + self.coffee_kg,
            self.kettle_kg,
            self.spill_kg,
            self.evaporated_kg,
        ];
        let total = ((self.initial_kg + self.coffee_kg) * 1e6).round();
        let mut rounded: Vec<(f64, usize)> = Vec::new();
        let mut floors = [0_u64; 5];
        let mut sum = 0_u64;
        for (index, part) in parts.iter().enumerate() {
            let milligrams = part * 1e6;
            floors[index] = milligrams.floor() as u64;
            sum += floors[index];
            rounded.push((milligrams - milligrams.floor(), index));
        }
        let mut remainder = (total as u64)
            .checked_sub(sum)
            .filter(|remainder| *remainder <= 5)
            .ok_or_else(|| anyhow::anyhow!("Material distribution does not balance"))?;
        rounded.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for (_, index) in rounded {
            if remainder == 0 {
                break;
            }
            floors[index] += 1;
            remainder -= 1;
        }
        Ok(Distribution {
            beverage_mg: floors[0],
            spent_bed_mg: floors[1],
            kettle_mg: floors[2],
            spill_mg: floors[3],
            evaporated_mg: floors[4],
        })
    }
}

fn water_cylinder(mass: f64, radius: f64, length: f64) -> [f64; 3] {
    let side = mass * (3. * radius * radius + length * length) / 12.;
    [side, side, mass * radius * radius / 2.]
}

fn empty(centre: Point) -> BodyLoad {
    BodyLoad {
        mass_kg: 0.,
        centre_m: centre.into(),
        inertia_kgm2: [0.; 3],
    }
}

/// A row-major rotation matrix as a unit quaternion.
pub fn rotation_of(rows: &[f64; 9]) -> UnitQuaternion<f64> {
    UnitQuaternion::from_matrix(&Matrix3::from_row_slice(rows))
}
