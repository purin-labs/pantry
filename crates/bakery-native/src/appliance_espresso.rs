//! Shared espresso-machine control rehearsal. Thermal losses, flow and component inertia
//! are assumptions; this is not espresso extraction or pressure-vessel qualification.
use crate::{
    appliances::{Contents, Hand, Name, Program, apply_pose_wrench, norm3, range, sub3},
    native::ApplianceEngine,
};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

/// Appliance-specific assumptions are fixed by the selected model, never supplied by a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Model {
    Linea,
    EagleOne,
    #[serde(rename = "e1-prima")]
    #[value(name = "e1-prima")]
    E1Prima,
}
impl Model {
    pub fn appliance(self) -> Name {
        match self {
            Self::Linea => Name::Linea,
            Self::EagleOne => Name::EagleOne,
            Self::E1Prima => Name::E1Prima,
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Linea => "lcs",
            Self::EagleOne => "eo",
            Self::E1Prima => "e1p",
        }
    }
    fn part(self, suffix: &str) -> String {
        format!("{}_{}", self.prefix(), suffix)
    }
    pub fn groups(self) -> &'static [Group] {
        match self {
            Self::Linea | Self::EagleOne => &[Group::Left, Group::Right],
            Self::E1Prima => &[Group::Left],
        }
    }
    fn outlets(self) -> &'static [Outlet] {
        match self {
            Self::Linea | Self::EagleOne => &[Outlet::Left, Outlet::Right, Outlet::HotWater],
            Self::E1Prima => &[Outlet::Left, Outlet::HotWater],
        }
    }
    fn require_group(self, group: Group) -> Result<()> {
        ensure!(
            self.groups().contains(&group),
            "This espresso machine has one brew group"
        );
        Ok(())
    }
    fn require_outlet(self, outlet: Outlet) -> Result<()> {
        ensure!(
            self.outlets().contains(&outlet),
            "This espresso machine has one brew group"
        );
        Ok(())
    }
    fn has_power_actuator(self) -> bool {
        !matches!(self, Self::E1Prima)
    }
    fn has_dose_actuators(self) -> bool {
        !matches!(self, Self::E1Prima)
    }
    fn has_guided_cups(self) -> bool {
        !matches!(self, Self::E1Prima)
    }
    pub fn has_live_timers(self) -> bool {
        !matches!(self, Self::E1Prima)
    }
    fn maximum_w(self) -> f64 {
        match self {
            Self::Linea => 3730.,
            Self::EagleOne => 5000.,
            Self::E1Prima => 2600.,
        }
    }
    fn cup_radius(self) -> f64 {
        match self {
            Self::Linea => 0.032,
            Self::EagleOne | Self::E1Prima => 0.027,
        }
    }
    fn coffee_capacity(self) -> f64 {
        // Eagle One and E1 PRIMA use small NEO brew circuits and dry-heated groups.
        // This is an aggregate heat-capacity surrogate, not independent boiler or TERS physics.
        match self {
            Self::Linea => 3.4 * 4180. + 1500.,
            Self::EagleOne => 0.28 * 2. * 4180. + 1800.,
            Self::E1Prima => 0.20 * 4180. + 1100.,
        }
    }
    fn steam_capacity(self) -> f64 {
        match self {
            Self::Linea | Self::EagleOne => 7. * 4180. + 2000.,
            Self::E1Prima => 1.5 * 4180. + 1200.,
        }
    }
    fn hot_water_actuator(self) -> String {
        match self {
            Self::E1Prima => "e1p_hot_water_lever_actuator".into(),
            Self::Linea | Self::EagleOne => self.part("hot_water_control"),
        }
    }
    fn steam_actuator(self, group: Group) -> String {
        match self {
            Self::E1Prima => "e1p_steam_lever_actuator".into(),
            Self::Linea | Self::EagleOne => {
                format!("{}_{}_steam_control", self.prefix(), group.label())
            }
        }
    }
    fn wand_actuator(self, group: Group) -> String {
        match self {
            Self::E1Prima => "e1p_steam_wand_actuator".into(),
            Self::Linea | Self::EagleOne => {
                format!("{}_{}_wand_control", self.prefix(), group.label())
            }
        }
    }
    fn wand_range_deg(self) -> (f64, f64) {
        match self {
            Self::E1Prima => (-11., 31.),
            Self::Linea | Self::EagleOne => (-40., 40.),
        }
    }
    fn steam_travel(self) -> f64 {
        match self {
            Self::Linea => std::f64::consts::PI,
            Self::EagleOne => 0.45,
            Self::E1Prima => 0.42,
        }
    }
    fn power_travel(self) -> f64 {
        match self {
            Self::Linea => std::f64::consts::FRAC_PI_2,
            Self::EagleOne => -0.001,
            Self::E1Prima => 0.,
        }
    }
    fn water_travel(self) -> f64 {
        match self {
            Self::Linea => -0.001,
            Self::EagleOne => 0.45,
            Self::E1Prima => 0.42,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    Left,
    Right,
}
impl Group {
    pub fn index(self) -> usize {
        match self {
            Self::Left => 0,
            Self::Right => 1,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortafilterPosition {
    Unlocked,
    Removed,
    Seated,
    Locked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuidedFilter {
    pub target: PortafilterPosition,
    pub lift_setpoint_m: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Power {
    Off,
    On { coffee_c: f64, steam_c: f64 },
    NoWater,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Dispense {
    Idle,
    Dispensing {
        elapsed_s: f64,
        duration_s: f64,
        delivered_g: f64,
    },
    Complete {
        elapsed_s: f64,
        delivered_g: f64,
    },
    Interrupted {
        elapsed_s: f64,
        delivered_g: f64,
    },
}
impl Dispense {
    pub fn active(&self) -> bool {
        matches!(self, Self::Dispensing { .. })
    }
    pub fn elapsed(&self) -> f64 {
        match self {
            Self::Idle => 0.,
            Self::Dispensing { elapsed_s, .. }
            | Self::Complete { elapsed_s, .. }
            | Self::Interrupted { elapsed_s, .. } => *elapsed_s,
        }
    }
    fn step(&mut self, dt: f64, flow_g_s: f64) -> f64 {
        let Self::Dispensing {
            elapsed_s,
            duration_s,
            delivered_g,
        } = self
        else {
            return 0.;
        };
        let active_dt = dt.min((*duration_s - *elapsed_s).max(0.));
        let delivered = active_dt * flow_g_s;
        *elapsed_s += active_dt;
        *delivered_g += delivered;
        if *elapsed_s >= *duration_s - 1e-9 {
            *self = Self::Complete {
                elapsed_s: *duration_s,
                delivered_g: *delivered_g,
            };
        }
        delivered
    }
    fn validate(&self, maximum_g: f64) -> Result<()> {
        match *self {
            Self::Idle => {}
            Self::Dispensing {
                elapsed_s,
                duration_s,
                delivered_g,
            } => {
                range(duration_s, 1., 60.)?;
                range(elapsed_s, 0., duration_s)?;
                range(delivered_g, 0., maximum_g)?;
            }
            Self::Complete {
                elapsed_s,
                delivered_g,
            }
            | Self::Interrupted {
                elapsed_s,
                delivered_g,
            } => {
                range(elapsed_s, 0., 60.)?;
                range(delivered_g, 0., maximum_g)?;
            }
        }
        Ok(())
    }
    fn interrupt(&mut self) {
        if let Self::Dispensing {
            elapsed_s,
            delivered_g,
            ..
        } = *self
        {
            *self = Self::Interrupted {
                elapsed_s,
                delivered_g,
            };
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outlet {
    Left,
    Right,
    HotWater,
}
impl Outlet {
    fn index(self) -> usize {
        match self {
            Self::Left => 0,
            Self::Right => 1,
            Self::HotWater => 2,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::HotWater => "hot_water",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CupPosition {
    Placed,
    Removed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoseSlot {
    One,
    Two,
}
impl DoseSlot {
    pub fn index(self) -> usize {
        match self {
            Self::One => 0,
            Self::Two => 1,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DoseControl {
    One,
    Two,
    Manual,
}
impl DoseControl {
    fn index(self) -> usize {
        match self {
            Self::One => 1,
            Self::Two => 2,
            Self::Manual => 3,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cup {
    pub position: CupPosition,
    pub mass_g: f64,
    pub temperature_c: f64,
    pub travel_m: f64,
    pub travel_setpoint_m: f64,
    pub support_n: f64,
}
impl Cup {
    fn collect(&mut self, delivered_g: f64, inlet_c: f64, dt: f64) -> f64 {
        let collected = if matches!(self.position, CupPosition::Placed) && self.travel_m < 0.001 {
            delivered_g.min((250. - self.mass_g).max(0.))
        } else {
            0.
        };
        // Water and a 200 g ceramic cup share one temperature. No extraction chemistry.
        let capacity = 150. + self.mass_g * 4.18;
        self.temperature_c = (capacity * self.temperature_c + collected * 4.18 * inlet_c)
            / (capacity + collected * 4.18);
        self.mass_g += collected;
        self.temperature_c +=
            (20. - self.temperature_c) * (1. - (-0.8 * dt / (150. + self.mass_g * 4.18)).exp());
        delivered_g - collected
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Espresso {
    pub model: Model,
    pub cups: [Cup; 3],
    pub drain_g: f64,
    pub discarded_g: f64,
    pub served_g: f64,
    pub dose_controls: [DoseControl; 2],
    pub shot_doses_s: [[f64; 2]; 2],
    pub hot_water_dose_s: f64,
    pub filters: [GuidedFilter; 2],
    pub power: Power,
    pub water_available: bool,
    pub coffee_c: f64,
    pub steam_c: f64,
    pub heater_w: f64,
    pub input_j: f64,
    pub loss_j: f64,
    pub drawn_water_g: f64,
    pub grounds_exchange_j: f64,
    pub shots: [Dispense; 2],
    pub hot_water: Dispense,
    pub steam_open: [bool; 2],
    pub brew_pressure_bar: [f64; 2],
    pub steam_pressure_bar: f64,
}
impl Espresso {
    pub fn new(model: Model) -> Self {
        Self {
            model,
            cups: std::array::from_fn(|_| Cup {
                position: CupPosition::Placed,
                mass_g: 0.,
                temperature_c: 20.,
                travel_m: 0.,
                travel_setpoint_m: 0.,
                support_n: 0.,
            }),
            drain_g: 0.,
            discarded_g: 0.,
            served_g: 0.,
            dose_controls: [DoseControl::Manual; 2],
            shot_doses_s: [[12., 25.]; 2],
            hot_water_dose_s: 15.,
            filters: std::array::from_fn(|_| GuidedFilter {
                target: PortafilterPosition::Locked,
                lift_setpoint_m: 0.,
            }),
            power: Power::Off,
            water_available: true,
            coffee_c: 20.,
            steam_c: 20.,
            heater_w: 0.,
            input_j: 0.,
            loss_j: 0.,
            drawn_water_g: 0.,
            grounds_exchange_j: 0.,
            shots: [Dispense::Idle, Dispense::Idle],
            hot_water: Dispense::Idle,
            steam_open: [false; 2],
            brew_pressure_bar: [0.; 2],
            steam_pressure_bar: 0.,
        }
    }
    pub fn busy(&self) -> bool {
        self.hot_water.active()
            || self.shots.iter().any(Dispense::active)
            || self.steam_open.iter().any(|value| *value)
    }
    pub fn ready(&self) -> bool {
        matches!(self.power, Power::On { coffee_c, steam_c } if self.water_available && self.coffee_c >= coffee_c - 1. && self.steam_c >= steam_c - 2.)
    }
    pub fn complete(&self) -> bool {
        let flows = [&self.shots[0], &self.shots[1], &self.hot_water];
        !self.steam_open.iter().any(|open| *open)
            && flows
                .iter()
                .all(|flow| matches!(flow, Dispense::Idle | Dispense::Complete { .. }))
            && flows
                .iter()
                .any(|flow| matches!(flow, Dispense::Complete { .. }))
    }

    pub fn timer_text(&self, group: Group) -> String {
        if !matches!(self.power, Power::On { .. }) {
            return String::new();
        }
        // Step accumulation can finish a whole second a few ulps below it.
        format!(
            "{:02.0}",
            (self.shots[group.index()].elapsed() + 1e-8).floor()
        )
    }
    pub fn start(&mut self, program: &Program, engine: &mut ApplianceEngine) -> Result<()> {
        match *program {
            Program::EspressoShotPreset { group, slot } => {
                self.model.require_group(group)?;
                self.start(
                    &Program::EspressoShot {
                        group,
                        duration_s: self.shot_doses_s[group.index()][slot.index()],
                    },
                    engine,
                )?;
                self.dose_controls[group.index()] = match slot {
                    DoseSlot::One => DoseControl::One,
                    DoseSlot::Two => DoseControl::Two,
                };
                return self.press_dose(engine, group, true);
            }
            Program::EspressoHotWaterPreset => {
                return self.start(
                    &Program::EspressoHotWater {
                        duration_s: self.hot_water_dose_s,
                    },
                    engine,
                );
            }
            Program::EspressoWarmup { coffee_c, steam_c } => {
                ensure!(
                    self.water_available && !self.busy(),
                    "Restore water and stop dispensing before warm-up"
                );
                self.power = Power::On { coffee_c, steam_c };
                if self.model.has_power_actuator() {
                    engine.control(&self.model.part("power_control"), self.model.power_travel())?;
                }
            }
            Program::EspressoShot { group, duration_s } => {
                self.model.require_group(group)?;
                ensure!(self.ready(), "Warm both boilers before a shot");
                if self.model == Model::E1Prima {
                    ensure!(
                        engine.joint("e1p_drip_tray_slide")?.0 <= 0.01,
                        "Close the drip tray before dispensing"
                    );
                }
                ensure!(
                    self.locked(engine, group)?,
                    "Seat and lock the selected portafilter before dispensing"
                );
                ensure!(
                    !self.shots[group.index()].active(),
                    "The selected group is already dispensing"
                );
                self.shots[group.index()] = Dispense::Dispensing {
                    elapsed_s: 0.,
                    duration_s,
                    delivered_g: 0.,
                };
                self.dose_controls[group.index()] = DoseControl::Manual;
                self.press_dose(engine, group, true)?;
            }
            Program::EspressoHotWater { duration_s } => {
                ensure!(self.ready(), "Warm both boilers before hot water");
                if self.model == Model::E1Prima {
                    ensure!(
                        engine.joint("e1p_drip_tray_slide")?.0 <= 0.01,
                        "Close the drip tray before dispensing"
                    );
                }
                ensure!(!self.hot_water.active(), "Hot water is already dispensing");
                self.hot_water = Dispense::Dispensing {
                    elapsed_s: 0.,
                    duration_s,
                    delivered_g: 0.,
                };
                engine.control(&self.model.hot_water_actuator(), self.model.water_travel())?;
            }
            _ => bail!("Select an espresso program"),
        }
        Ok(())
    }
    fn outlet_active(&self, outlet: Outlet) -> bool {
        match outlet {
            Outlet::Left => self.shots[0].active(),
            Outlet::Right => self.shots[1].active(),
            Outlet::HotWater => self.hot_water.active(),
        }
    }
    pub fn move_cup(&mut self, outlet: Outlet, position: CupPosition) -> Result<()> {
        self.model.require_outlet(outlet)?;
        ensure!(
            !self.outlet_active(outlet),
            "Stop the selected outlet before moving its cup"
        );
        if matches!(position, CupPosition::Placed) && outlet.index() < 2 {
            ensure!(
                matches!(
                    self.filters[outlet.index()].target,
                    PortafilterPosition::Locked | PortafilterPosition::Unlocked
                ),
                "Raise the portafilter before placing its cup"
            );
        }
        self.cups[outlet.index()].position = position;
        Ok(())
    }
    pub fn empty_cup(&mut self, outlet: Outlet, engine: &mut ApplianceEngine) -> Result<()> {
        self.model.require_outlet(outlet)?;
        let cup = &mut self.cups[outlet.index()];
        ensure!(
            matches!(cup.position, CupPosition::Removed) && cup.travel_m >= 0.179,
            "Remove the cup before emptying it"
        );
        self.discarded_g += cup.mass_g;
        cup.mass_g = 0.;
        if self.model.has_guided_cups() {
            engine.set_cup_contents(
                &self.model.part(&format!("{}_cup", outlet.label())),
                0.,
                self.model.cup_radius(),
            )?;
        }
        Ok(())
    }
    pub fn serve_cup(&mut self, outlet: Outlet, engine: &mut ApplianceEngine) -> Result<()> {
        self.model.require_outlet(outlet)?;
        ensure!(
            !self.outlet_active(outlet),
            "Stop dispensing before serving"
        );
        let cup = &mut self.cups[outlet.index()];
        ensure!(
            matches!(cup.position, CupPosition::Removed) && cup.travel_m >= 0.179,
            "Remove the cup before serving"
        );
        self.served_g += cup.mass_g;
        cup.mass_g = 0.;
        if self.model.has_guided_cups() {
            engine.set_cup_contents(
                &self.model.part(&format!("{}_cup", outlet.label())),
                0.,
                self.model.cup_radius(),
            )?;
        }
        Ok(())
    }
    fn press_dose(&self, engine: &mut ApplianceEngine, group: Group, active: bool) -> Result<()> {
        if !self.model.has_dose_actuators() {
            return Ok(());
        }
        for index in 1..=3 {
            engine.control(
                &self
                    .model
                    .part(&format!("{}_dose_{index}_control", group.label())),
                if active && index == self.dose_controls[group.index()].index() {
                    -0.001
                } else {
                    0.
                },
            )?;
        }
        Ok(())
    }
    pub fn set_shot_dose(&mut self, group: Group, slot: DoseSlot, duration_s: f64) -> Result<()> {
        self.model.require_group(group)?;
        range(duration_s, 1., 60.)?;
        ensure!(
            !self.shots[group.index()].active(),
            "Stop the group before programming its dose"
        );
        self.shot_doses_s[group.index()][slot.index()] = duration_s;
        Ok(())
    }
    pub fn set_hot_water_dose(&mut self, duration_s: f64) -> Result<()> {
        range(duration_s, 1., 60.)?;
        ensure!(
            !self.hot_water.active(),
            "Stop hot water before programming its dose"
        );
        self.hot_water_dose_s = duration_s;
        Ok(())
    }
    pub fn stop(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        self.stop_hot_water(engine)?;
        self.power = Power::Off;
        self.heater_w = 0.;
        for &group in self.model.groups() {
            self.shots[group.index()].interrupt();
            self.steam_open[group.index()] = false;
            engine.control(&self.model.steam_actuator(group), 0.)?;
            self.press_dose(engine, group, false)?;
        }
        if self.model.has_power_actuator() {
            engine.control(&self.model.part("power_control"), 0.)?;
        }
        Ok(())
    }
    pub fn stop_hot_water(&mut self, engine: &mut ApplianceEngine) -> Result<()> {
        self.hot_water.interrupt();
        engine.control(&self.model.hot_water_actuator(), 0.)
    }
    pub fn stop_shot(&mut self, group: Group, engine: &mut ApplianceEngine) -> Result<()> {
        self.model.require_group(group)?;
        self.shots[group.index()].interrupt();
        self.press_dose(engine, group, false)
    }
    pub fn wand(
        &self,
        group: Group,
        angle_degrees: f64,
        engine: &mut ApplianceEngine,
    ) -> Result<()> {
        self.model.require_group(group)?;
        let (minimum, maximum) = self.model.wand_range_deg();
        range(angle_degrees, minimum, maximum)?;
        ensure!(
            !self.steam_open[group.index()],
            "Close steam before moving the wand in this rehearsal"
        );
        engine.control(&self.model.wand_actuator(group), angle_degrees.to_radians())
    }
    pub fn water(&mut self, available: bool, engine: &mut ApplianceEngine) -> Result<()> {
        self.water_available = available;
        if !available {
            self.stop(engine)?;
            self.power = Power::NoWater;
        }
        Ok(())
    }
    pub fn steam(&mut self, group: Group, open: bool, engine: &mut ApplianceEngine) -> Result<()> {
        self.model.require_group(group)?;
        if open {
            ensure!(self.ready(), "Warm both boilers before opening steam");
        }
        engine.control(
            &self.model.steam_actuator(group),
            if open { self.model.steam_travel() } else { 0. },
        )?;
        self.steam_open[group.index()] = open;
        Ok(())
    }
    pub fn portafilter(
        &mut self,
        group: Group,
        position: PortafilterPosition,
        engine: &mut ApplianceEngine,
    ) -> Result<()> {
        self.model.require_group(group)?;
        ensure!(
            !self.shots[group.index()].active() && self.brew_pressure_bar[group.index()] < 0.2,
            "Stop dispensing and wait for group pressure to decay before portafilter handling"
        );
        if self.model == Model::E1Prima {
            let (pos, quat) = engine.body_pose("e1p_portafilter")?;
            let seat = engine.site("e1p_group_seat_site")?;
            let sign = if quat[0] < 0. { -1. } else { 1. };
            let twist = 2. * (sign * quat[3]).atan2(sign * quat[0]);
            let lift = pos[2] - seat[2];
            match position {
                PortafilterPosition::Unlocked => {
                    ensure!(lift.abs() < 0.005, "Seat the portafilter before turning it");
                }
                PortafilterPosition::Removed => {
                    ensure!(
                        self.cups[0].travel_m >= 0.179,
                        "Remove the cup before lowering the portafilter"
                    );
                    ensure!(twist < -0.45, "Unlock the portafilter before lowering it");
                }
                PortafilterPosition::Seated => {
                    ensure!(
                        twist < -0.45,
                        "Keep the portafilter unlocked during seating"
                    );
                }
                PortafilterPosition::Locked => {
                    ensure!(
                        lift.abs() < 0.005 && (pos[1] - seat[1]).abs() < 0.02,
                        "Raise and seat the portafilter before locking"
                    );
                }
            }
            self.filters[0].target = position;
            return Ok(());
        }
        let prefix = self.model.prefix();
        let label = group.label();
        let twist = engine.joint(&format!("{prefix}_{label}_lock"))?.0;
        let lift = engine.joint(&format!("{prefix}_{label}_lift"))?.0;
        match position {
            PortafilterPosition::Unlocked => {
                ensure!(lift.abs() < 0.003, "Seat the portafilter before turning it");
                engine.control(&format!("{prefix}_{label}_lock_control"), -0.61)?;
            }
            PortafilterPosition::Removed => {
                ensure!(
                    self.cups[group.index()].travel_m >= 0.179,
                    "Remove the cup before lowering the portafilter"
                );
                ensure!(twist < -0.55, "Unlock the portafilter before lowering it");
            }
            PortafilterPosition::Seated => {
                ensure!(
                    twist < -0.55,
                    "Keep the portafilter unlocked during seating"
                );
            }
            PortafilterPosition::Locked => {
                ensure!(
                    lift.abs() < 0.003,
                    "Raise and seat the portafilter before locking"
                );
                engine.control(&format!("{prefix}_{label}_lock_control"), 0.)?;
            }
        }
        self.filters[group.index()].target = position;
        Ok(())
    }
    pub(crate) fn before_step(&self, hand: &Hand, engine: &mut ApplianceEngine) -> Result<()> {
        if self.model != Model::E1Prima || !matches!(hand, Hand::Released) {
            return Ok(());
        }
        let (pos, quat) = engine.body_pose("e1p_portafilter")?;
        let seat = engine.site("e1p_group_seat_site")?;
        let unlocked_orientation = [(-0.275_f64).cos(), 0., 0., (-0.275_f64).sin()];
        match self.filters[0].target {
            PortafilterPosition::Unlocked => apply_pose_wrench(
                engine,
                "e1p_portafilter",
                [seat[0], seat[1] - 0.012, seat[2] + 0.001],
                unlocked_orientation,
            ),
            PortafilterPosition::Removed => {
                let target = if pos[1] > seat[1] - 0.059 {
                    [seat[0], seat[1] - 0.072, seat[2] + 0.001]
                } else {
                    [seat[0], seat[1] - 0.072, seat[2] - 0.079]
                };
                apply_pose_wrench(engine, "e1p_portafilter", target, unlocked_orientation)
            }
            PortafilterPosition::Seated => {
                let target = if pos[2] < seat[2] - 0.002 {
                    [seat[0], seat[1] - 0.072, seat[2] + 0.001]
                } else {
                    [seat[0], seat[1] - 0.012, seat[2] + 0.001]
                };
                apply_pose_wrench(engine, "e1p_portafilter", target, unlocked_orientation)
            }
            PortafilterPosition::Locked => {
                let distance = norm3(sub3(pos, seat));
                let angle = 2. * quat[0].abs().clamp(0., 1.).acos();
                if distance < 0.002 && angle < 0.02 || distance >= 0.03 {
                    engine.apply_force("e1p_portafilter", [0.; 6])
                } else {
                    let target = if angle > 0.12 {
                        [seat[0], seat[1] - 0.012, seat[2] + 0.001]
                    } else {
                        [seat[0], seat[1], seat[2] + 0.0002]
                    };
                    apply_pose_wrench(engine, "e1p_portafilter", target, [1., 0., 0., 0.])
                }
            }
        }
    }
    fn locked(&self, engine: &ApplianceEngine, group: Group) -> Result<bool> {
        if !self.model.groups().contains(&group) {
            return Ok(false);
        }
        if self.model == Model::E1Prima {
            let (pos, quat) = engine.body_pose("e1p_portafilter")?;
            let seat = engine.site("e1p_group_seat_site")?;
            let vel = engine.body_velocity("e1p_portafilter")?;
            let distance = norm3(sub3(pos, seat));
            let angle = 2. * quat[0].abs().clamp(0., 1.).acos();
            let speed = vel.iter().map(|v| v * v).sum::<f64>().sqrt();
            return Ok(
                matches!(self.filters[0].target, PortafilterPosition::Locked)
                    && distance < 0.005
                    && angle < 0.08
                    && speed < 0.05,
            );
        }
        let prefix = self.model.prefix();
        let label = group.label();
        let (lock, speed) = engine.joint(&format!("{prefix}_{label}_lock"))?;
        let (lift, velocity) = engine.joint(&format!("{prefix}_{label}_lift"))?;
        Ok(matches!(
            self.filters[group.index()].target,
            PortafilterPosition::Locked
        ) && lock.abs() < 0.03
            && lift.abs() < 0.003
            && speed.abs() < 0.05
            && velocity.abs() < 0.01)
    }
    pub fn step(&mut self, engine: &mut ApplianceEngine, contents: &mut Contents) -> Result<()> {
        let prefix = self.model.prefix();
        let dt = engine.timestep();
        let mut water_kg = 0.;
        let mut delivered_g = [0.; 3];
        for &group in self.model.groups() {
            let index = group.index();
            let filter = &mut self.filters[index];
            let target = if matches!(filter.target, PortafilterPosition::Removed) {
                -0.1
            } else {
                0.
            };
            filter.lift_setpoint_m +=
                (target - filter.lift_setpoint_m).clamp(-0.04 * dt, 0.04 * dt);
            if self.model != Model::E1Prima {
                engine.control(
                    &format!("{prefix}_{}_lift_control", group.label()),
                    filter.lift_setpoint_m,
                )?;
            }
            if self.shots[index].active()
                && (!self.water_available || !self.locked(engine, group)?)
            {
                self.shots[index].interrupt();
            }
            delivered_g[index] = self.shots[index].step(dt, 2.);
            water_kg += delivered_g[index] / 1000.;
            let active = self.shots[index].active();
            let target = if active { 9. } else { 0. };
            self.brew_pressure_bar[index] +=
                (target - self.brew_pressure_bar[index]) * (1. - (-dt / 0.3).exp());
            self.press_dose(engine, group, active)?;
        }
        // Assumed 10 g/s hot-water flow, replenished with 20 C inlet water.
        delivered_g[2] = self.hot_water.step(dt, 10.);
        let hot_water_kg = delivered_g[2] / 1000.;
        for &outlet in self.model.outlets() {
            let cup = &mut self.cups[outlet.index()];
            let target = match cup.position {
                CupPosition::Placed => 0.,
                CupPosition::Removed => 0.18,
            };
            cup.travel_setpoint_m += (target - cup.travel_setpoint_m).clamp(-0.04 * dt, 0.04 * dt);
            if self.model.has_guided_cups() {
                cup.travel_m = engine
                    .joint(&format!("{prefix}_{}_cup_travel", outlet.label()))?
                    .0;
                engine.control(
                    &format!("{prefix}_{}_cup_control", outlet.label()),
                    cup.travel_setpoint_m,
                )?;
            } else {
                cup.travel_m = cup.travel_setpoint_m;
            }
            let inlet_c = match outlet {
                Outlet::HotWater => self.steam_c.min(100.),
                _ => self.coffee_c,
            };
            self.drain_g += cup.collect(delivered_g[outlet.index()], inlet_c, dt);
            if self.model.has_guided_cups() {
                engine.set_cup_contents(
                    &format!("{prefix}_{}_cup", outlet.label()),
                    cup.mass_g,
                    self.model.cup_radius(),
                )?;
                cup.support_n =
                    engine.support_force(&format!("{prefix}_{}_cup_contact", outlet.label()))?;
            } else {
                cup.support_n = if cup.travel_m < 0.001 {
                    (0.2 + cup.mass_g / 1000.) * 9.81
                } else {
                    0.
                };
            }
        }
        engine.control(
            &self.model.hot_water_actuator(),
            if self.hot_water.active() {
                self.model.water_travel()
            } else {
                0.
            },
        )?;
        let steam_count = self.steam_open.iter().filter(|open| **open).count() as f64;
        let steam_kg = steam_count * 0.0008 * dt;
        let coffee_draw = water_kg * 4180. * (self.coffee_c - 20.).max(0.);
        let steam_draw = steam_kg * (2_257_000. + 4180. * (self.steam_c - 20.).max(0.))
            + hot_water_kg * 4180. * (self.steam_c - 20.).max(0.);
        self.drawn_water_g += (water_kg + steam_kg + hot_water_kg) * 1000.;
        let coffee_loss = 2. * (self.coffee_c - 20.);
        let steam_loss = 3. * (self.steam_c - 20.);
        let (coffee_w, steam_w) = match self.power {
            Power::On { coffee_c, steam_c } if self.water_available => {
                let coffee = ((coffee_c - self.coffee_c) * 1500.).clamp(0., 1600.);
                let steam =
                    ((steam_c - self.steam_c) * 2000.).clamp(0., self.model.maximum_w() - coffee);
                (coffee, steam)
            }
            _ => (0., 0.),
        };
        self.heater_w = coffee_w + steam_w;
        self.coffee_c +=
            ((coffee_w - coffee_loss) * dt - coffee_draw) / self.model.coffee_capacity();
        self.steam_c += ((steam_w - steam_loss) * dt - steam_draw) / self.model.steam_capacity();
        self.input_j += self.heater_w * dt;
        self.loss_j += (coffee_loss + steam_loss) * dt + coffee_draw + steam_draw;
        if self.locked(engine, Group::Left)? {
            self.grounds_exchange_j +=
                contents.exchange(&mut self.coffee_c, self.model.coffee_capacity(), 2., dt)?;
        }
        // Approximate saturation-pressure indicator, not a thermodynamic solver.
        self.steam_pressure_bar = ((self.steam_c - 100.) * 0.048).max(0.);
        if self.model == Model::Linea {
            engine.control(
                &self.model.part("coffee_pressure_control"),
                self.brew_pressure_bar.iter().copied().fold(0., f64::max) / 12. * 4.,
            )?;
            engine.control(
                &self.model.part("steam_pressure_control"),
                self.steam_pressure_bar / 3. * 4.,
            )?;
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        for cup in &self.cups {
            range(cup.mass_g, 0., 250.)?;
            range(cup.temperature_c, 0., 130.)?;
            range(cup.travel_m, -0.001, 0.181)?;
            range(cup.travel_setpoint_m, 0., 0.18)?;
            range(cup.support_n, -1., 100.)?;
        }
        range(self.drain_g, 0., 1e15)?;
        range(self.discarded_g, 0., 1e15)?;
        range(self.served_g, 0., 1e15)?;
        for doses in self.shot_doses_s {
            for duration in doses {
                range(duration, 1., 60.)?;
            }
        }
        range(self.hot_water_dose_s, 1., 60.)?;
        for filter in &self.filters {
            range(filter.lift_setpoint_m, -0.1, 0.)?;
        }
        range(self.coffee_c, 0., 150.)?;
        range(self.steam_c, 0., 160.)?;
        range(self.heater_w, 0., self.model.maximum_w())?;
        for energy in [self.input_j, self.drawn_water_g] {
            range(energy, 0., 1e15)?;
        }
        // Cold contents can draw a boiler below ambient, making net loss negative.
        range(self.loss_j, -1e15, 1e15)?;
        for pressure in self.brew_pressure_bar {
            range(pressure, 0., 9.001)?;
        }
        range(self.steam_pressure_bar, 0., 3.)?;
        range(self.grounds_exchange_j, -1e15, 1e15)?;
        if let Power::On { coffee_c, steam_c } = self.power {
            range(coffee_c, 85., 96.)?;
            range(steam_c, 110., 130.)?;
            ensure!(
                self.water_available,
                "Powered espresso checkpoint needs water"
            );
        }
        ensure!(
            !self.busy() || matches!(self.power, Power::On { .. }),
            "Dispensing requires power"
        );
        for shot in &self.shots {
            shot.validate(120.)?;
        }
        if self.model == Model::E1Prima {
            ensure!(
                matches!(self.shots[1], Dispense::Idle)
                    && !self.steam_open[1]
                    && self.brew_pressure_bar[1] == 0.
                    && self.cups[1].mass_g == 0.,
                "Single-group espresso checkpoint cannot contain right-group activity"
            );
        }
        self.hot_water.validate(600.)?;
        Ok(())
    }
}
