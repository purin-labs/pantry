//! The world and the devices of the controller simulator (Plan 24 S2).
//!
//! Two FR10 arms and one deck oven share one world: mould group `g` starts on
//! cold rack shelf `g`, the oven has shelves 1 to 4 and the cooling rack
//! shelves 1 to 12. A move replays the timeline of its physics case (see
//! `physics.rs`) at the simulator's time scale. Each device has its own
//! sequence and its own clock, and it writes each event to every connection
//! of its port.
use std::collections::{BTreeMap, VecDeque};
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;

use cobot_protocol::{
    Capability, CarrierAt, CobotTask, ControlOp, ControlOutcome, ControllerDevice, ControllerEvent,
    ControllerTaskState, DeviceOp, FaultCode, ObservedState, Place, RunState, Station, TaskState,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::physics::{End, Physics, Timeline};
use crate::port::{Fault, PortOp, ScriptMove};

/// The default layout: two arms and the oven.
pub const DEVICES: [&str; 3] = ["cobot-1", "cobot-2", "oven-1"];
const COBOTS: [usize; 2] = [0, 1];
const OVEN: usize = 2;
/// A device sends its clock this often, in wall seconds.
const CLOCK_EVERY: f64 = 0.25;
/// The events that `stale` can send again.
const SENT_KEPT: usize = 16;
const FIRMWARE: &str = concat!("bakery-native ", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "at", rename_all = "snake_case")]
enum GroupAt {
    Placed {
        station: Station,
        shelf: u8,
    },
    /// On the tool of an arm that stopped with it.
    Tool {
        device: &'static str,
    },
    /// Nobody knows: a person must look.
    Unknown,
}

impl GroupAt {
    fn at(place: Place) -> Self {
        GroupAt::Placed {
            station: place.station,
            shelf: place.shelf,
        }
    }
}

/// How a task ends if nothing stops it first.
#[derive(Clone, Debug)]
enum Finish {
    Complete,
    Fail {
        reason: &'static str,
        carrier: CarrierAt,
        fault: FaultCode,
    },
}

#[derive(Clone, Debug)]
struct Plan {
    timeline: Timeline,
    /// Seconds into the timeline at which the task ends.
    end_at: f64,
    finish: Finish,
}

#[derive(Clone, Debug)]
struct Task {
    id: String,
    device: usize,
    task: CobotTask,
    /// A shadow-mode move from the controller's own script (Plan 24 S5).
    scripted: bool,
    state: TaskState,
    plan: Option<Plan>,
    /// Device-clock seconds of motion, without pauses.
    elapsed: f64,
    carrier_at: Option<CarrierAt>,
    reason: Option<String>,
    /// The physics case of a rejection that physics decided.
    rejected_by: Option<(String, String)>,
}

impl Task {
    fn is_move(&self) -> bool {
        matches!(self.task, CobotTask::MoveMouldGroup { .. })
    }

    fn progress(&self) -> Option<f64> {
        match (&self.plan, self.state) {
            (_, TaskState::Rejected) | (None, _) => None,
            (Some(_), TaskState::Completed) => Some(1.),
            (Some(plan), _) => Some((self.elapsed / plan.timeline.seconds.max(1e-9)).min(1.)),
        }
    }

    fn phase(&self) -> Option<String> {
        match (&self.plan, self.state) {
            (Some(plan), TaskState::Running | TaskState::Indeterminate) => {
                plan.timeline.phase(self.elapsed).map(str::to_string)
            }
            _ => None,
        }
    }

    fn observed_seconds(&self) -> Option<f64> {
        match self.state {
            TaskState::Completed | TaskState::Indeterminate => Some(round_ms(self.elapsed)),
            _ => None,
        }
    }

    fn event(&self, sequence: u64, clock_ms: u64) -> ControllerEvent {
        ControllerEvent::Task {
            task_id: self.id.clone(),
            state: self.state.into(),
            progress: self.progress().map(round_ms),
            phase: self.phase(),
            carrier_at: self.carrier_at,
            reason: self.reason.clone(),
            observed_seconds: self.observed_seconds(),
            sequence,
            clock_ms,
        }
    }

    /// The event of a task, or the shadow observation of a scripted move.
    fn line(&self, sequence: u64, clock_ms: u64) -> ControllerEvent {
        if !self.scripted {
            return self.event(sequence, clock_ms);
        }
        let state = match self.state {
            TaskState::Running => ObservedState::Started,
            TaskState::Completed => ObservedState::Completed,
            _ => ObservedState::Failed,
        };
        ControllerEvent::Observed {
            move_id: self.id.clone(),
            task: self.task.clone(),
            state,
            carrier_at: self.carrier_at,
            reason: self.reason.clone(),
            sequence,
            clock_ms,
        }
    }
}

fn round_ms(value: f64) -> f64 {
    (value * 1000.).round() / 1000.
}

struct Device {
    key: &'static str,
    cobot: bool,
    clock_ms: f64,
    sequence: u64,
    frozen: bool,
    paused: bool,
    /// Stopped on request; a `resume` makes it idle again.
    stopped: bool,
    fault: Option<FaultCode>,
    current: Option<String>,
    armed: Option<(Fault, Option<f64>)>,
    subscribers: Vec<TcpStream>,
    sent: VecDeque<(bool, String)>,
    ops: BTreeMap<&'static str, u64>,
    since_clock: f64,
    script: Vec<(f64, ScriptMove)>,
    started: u64,
}

impl Device {
    fn new(key: &'static str, cobot: bool) -> Self {
        Self {
            key,
            cobot,
            clock_ms: 0.,
            sequence: 0,
            frozen: false,
            paused: false,
            stopped: false,
            fault: None,
            current: None,
            armed: None,
            subscribers: Vec::new(),
            sent: VecDeque::new(),
            ops: BTreeMap::new(),
            since_clock: 0.,
            script: Vec::new(),
            started: 0,
        }
    }
}

pub struct Sim {
    time_scale: f64,
    physics: Physics,
    devices: Vec<Device>,
    groups: BTreeMap<u8, GroupAt>,
    tasks: BTreeMap<String, Task>,
    estop: bool,
    state_file: Option<PathBuf>,
    dirty: bool,
}

fn default_groups() -> BTreeMap<u8, GroupAt> {
    (1..=Station::ColdRack.shelves())
        .map(|group| {
            (
                group,
                GroupAt::Placed {
                    station: Station::ColdRack,
                    shelf: group,
                },
            )
        })
        .collect()
}

impl Sim {
    pub fn new(physics: Physics, time_scale: f64, state_file: Option<PathBuf>) -> Self {
        Self {
            time_scale,
            physics,
            devices: vec![
                Device::new(DEVICES[0], true),
                Device::new(DEVICES[1], true),
                Device::new(DEVICES[2], false),
            ],
            groups: default_groups(),
            tasks: BTreeMap::new(),
            estop: false,
            state_file,
            dirty: true,
        }
    }

    pub fn subscribe(&mut self, device: usize, stream: TcpStream) {
        self.devices[device].subscribers.push(stream);
    }

    /// Makes one event with the device's next sequence and its clock, and
    /// writes it to every connection of the device. A frozen device sends
    /// nothing.
    fn emit(&mut self, index: usize, event: impl FnOnce(&Self, u64, u64) -> ControllerEvent) {
        if self.devices[index].frozen {
            return;
        }
        self.devices[index].sequence += 1;
        let sequence = self.devices[index].sequence;
        let clock_ms = self.devices[index].clock_ms.floor() as u64;
        let event = event(self, sequence, clock_ms);
        let is_task = matches!(event, ControllerEvent::Task { .. });
        if !matches!(event, ControllerEvent::Clock { .. }) {
            self.dirty = true;
        }
        let line = match serde_json::to_string(&event) {
            Ok(line) => line,
            Err(error) => {
                eprintln!("{}: an event did not serialize: {error}", DEVICES[index]);
                return;
            }
        };
        let device = &mut self.devices[index];
        device.sent.push_back((is_task, line.clone()));
        while device.sent.len() > SENT_KEPT {
            device.sent.pop_front();
        }
        write_line(&mut device.subscribers, &line);
    }

    fn run_state(&self, index: usize) -> RunState {
        let device = &self.devices[index];
        if self.estop {
            RunState::Estop
        } else if device.fault.is_some() || device.stopped {
            RunState::Stopped
        } else if device.paused {
            RunState::Paused
        } else if device.current.is_some() {
            RunState::Busy
        } else {
            RunState::Idle
        }
    }

    /// One line from the gateway on a device's connection. A frozen device
    /// does not answer.
    pub fn device_op(&mut self, index: usize, line: &str) {
        if self.devices[index].frozen {
            return;
        }
        let op: DeviceOp = match serde_json::from_str(line) {
            Ok(op) => op,
            Err(error) => {
                eprintln!("{}: refused line {line}: {error}", DEVICES[index]);
                return;
            }
        };
        *self.devices[index].ops.entry(op.name()).or_default() += 1;
        match op {
            DeviceOp::Hello => {
                self.emit(index, |sim, sequence, clock_ms| {
                    sim.hello(index, sequence, clock_ms)
                });
            }
            DeviceOp::Submit { task_id, task } => self.submit(index, task_id, task),
            DeviceOp::Status { task_id } => {
                self.emit(index, |sim, sequence, clock_ms| {
                    match sim.tasks.get(&task_id) {
                        Some(task) => task.event(sequence, clock_ms),
                        None => ControllerEvent::Task {
                            task_id,
                            state: ControllerTaskState::Unknown,
                            progress: None,
                            phase: None,
                            carrier_at: None,
                            reason: None,
                            observed_seconds: None,
                            sequence,
                            clock_ms,
                        },
                    }
                });
            }
            DeviceOp::Pause => {
                let done = !self.estop;
                if done {
                    self.devices[index].paused = true;
                }
                self.control_answer(index, ControlOp::Pause, done);
            }
            DeviceOp::Resume => {
                let done = !self.estop && self.devices[index].fault.is_none();
                if done {
                    self.devices[index].paused = false;
                    self.devices[index].stopped = false;
                }
                self.control_answer(index, ControlOp::Resume, done);
            }
            DeviceOp::Stop => {
                if let Some(id) = self.open_task(index) {
                    self.end_open(&id, "stop_requested", None);
                }
                self.devices[index].stopped = true;
                self.control_answer(index, ControlOp::Stop, true);
            }
        }
    }

    fn control_answer(&mut self, index: usize, op: ControlOp, done: bool) {
        let outcome = if done {
            ControlOutcome::Done
        } else {
            ControlOutcome::Refused
        };
        self.emit(index, |_, sequence, clock_ms| ControllerEvent::Control {
            op,
            outcome,
            sequence,
            clock_ms,
        });
    }

    fn hello(&self, index: usize, sequence: u64, clock_ms: u64) -> ControllerEvent {
        let device = &self.devices[index];
        let (kind, model, id, label) = if device.cobot {
            (
                "cobot",
                "FAIRINO FR10 (simulated)",
                "move_mould_group",
                "Move a mould group",
            )
        } else {
            (
                "appliance",
                "Deck oven (simulated)",
                "bake",
                "Bake a program",
            )
        };
        ControllerEvent::Hello {
            device: ControllerDevice {
                source_key: device.key.into(),
                kind: kind.into(),
                model: model.into(),
                serial: Some(format!("SIM-{}", device.key.to_uppercase())),
                firmware: Some(FIRMWARE.into()),
                capabilities: vec![Capability {
                    id: id.into(),
                    label: label.into(),
                    revision: 1,
                }],
            },
            state: self.run_state(index),
            sequence,
            clock_ms,
        }
    }

    fn open_task(&self, index: usize) -> Option<String> {
        self.devices[index]
            .current
            .clone()
            .filter(|id| self.tasks.get(id).is_some_and(|task| task.state.is_open()))
    }

    fn oven_baking(&self) -> bool {
        self.open_task(OVEN).is_some()
    }

    fn door_in_use(&self) -> bool {
        COBOTS.iter().any(|&cobot| {
            self.open_task(cobot)
                .and_then(|id| self.tasks.get(&id))
                .and_then(|task| task.plan.as_ref().map(|plan| (task, plan)))
                .is_some_and(|(task, plan)| plan.timeline.in_door(task.elapsed))
        })
    }

    /// Why a device refuses this task now, or None.
    fn refusal(&self, index: usize, task: &CobotTask) -> Option<&'static str> {
        let device = &self.devices[index];
        match (device.cobot, task) {
            (true, CobotTask::Bake { .. }) | (false, CobotTask::MoveMouldGroup { .. }) => {
                return Some("unsupported_task");
            }
            _ => {}
        }
        if self.estop {
            return Some("estop_active");
        }
        if device.fault.is_some() {
            return Some("device_fault");
        }
        if device.stopped {
            return Some("device_stopped");
        }
        if device.paused {
            return Some("device_paused");
        }
        if self.open_task(index).is_some() {
            return Some("device_busy");
        }
        match task {
            CobotTask::MoveMouldGroup {
                mould_group,
                from,
                to,
            } => {
                let valid =
                    |place: &Place| place.shelf >= 1 && place.shelf <= place.station.shelves();
                if !(1..=32).contains(mould_group) || !valid(from) || !valid(to) {
                    return Some("invalid_place");
                }
                if !matches!(
                    (from.station, to.station),
                    (Station::ColdRack, Station::Oven) | (Station::Oven, Station::CoolingRack)
                ) {
                    return Some("no_physics_case");
                }
                if self.groups.get(mould_group) != Some(&GroupAt::at(*from)) {
                    return Some("not_at_source");
                }
                if self.groups.values().any(|at| *at == GroupAt::at(*to)) {
                    return Some("destination_occupied");
                }
                if self.oven_baking() {
                    return Some("oven_baking");
                }
                None
            }
            CobotTask::Bake {
                program_seconds,
                temperature_c,
            } => {
                if !(1..=7200).contains(program_seconds) || !(50..=300).contains(temperature_c) {
                    return Some("invalid_task");
                }
                if !self.groups.values().any(|at| {
                    matches!(
                        at,
                        GroupAt::Placed {
                            station: Station::Oven,
                            ..
                        }
                    )
                }) {
                    return Some("oven_empty");
                }
                if self.door_in_use() {
                    return Some("oven_door_in_use");
                }
                None
            }
        }
    }

    /// The plan of a task that the device accepts.
    fn plan(&mut self, index: usize, task: &CobotTask) -> Plan {
        match task {
            CobotTask::Bake {
                program_seconds, ..
            } => {
                let seconds = f64::from(*program_seconds);
                Plan {
                    timeline: Timeline {
                        case: "bake".into(),
                        digest: String::new(),
                        steps: 0,
                        timestep: 0.,
                        seconds,
                        pickup_seconds: 0.,
                        door: (seconds, seconds),
                        phases: vec![(0., "baking".into())],
                        end: End::Completed,
                    },
                    end_at: seconds,
                    finish: Finish::Complete,
                }
            }
            CobotTask::MoveMouldGroup { from, .. } => {
                let loading = from.station == Station::ColdRack;
                // An armed lost grip on a loading replays the engine's slip
                // case: the time and the place of the loss come from physics.
                if loading && self.devices[index].armed == Some((Fault::GripLost, None)) {
                    self.devices[index].armed = None;
                    return slip_plan(&self.physics.load_slip, self.physics.load.seconds);
                }
                let timeline = if loading {
                    self.physics.load.clone()
                } else {
                    self.physics.unload.clone()
                };
                if self.devices[index].armed == Some((Fault::GripLost, None)) {
                    // No physics case loses the grip on a retrieval: the
                    // controller loses it halfway between the pickup and the end.
                    let middle = (timeline.pickup_seconds + timeline.seconds) / 2.;
                    self.devices[index].armed =
                        Some((Fault::GripLost, Some(middle / timeline.seconds)));
                }
                Plan {
                    end_at: timeline.seconds,
                    timeline,
                    finish: Finish::Complete,
                }
            }
        }
    }

    fn submit(&mut self, index: usize, id: String, task: CobotTask) {
        // A known task identity runs nothing: the answer is its state.
        if self.tasks.contains_key(&id) {
            self.emit(index, |sim, sequence, clock_ms| {
                sim.tasks[&id].event(sequence, clock_ms)
            });
            return;
        }
        let mut refusal = self.refusal(index, &task).map(|reason| (reason, None));
        let blocked = refusal.is_none()
            && self.devices[index]
                .armed
                .is_some_and(|(fault, _)| fault == Fault::DoorBlocked);
        if blocked {
            self.devices[index].armed = None;
            let loading = matches!(&task, CobotTask::MoveMouldGroup { from, .. } if from.station == Station::ColdRack);
            // The engine's closed-door case refuses a loading before its first
            // step. No physics case covers a retrieval; the controller refuses it.
            let evidence = loading.then(|| {
                let timeline = &self.physics.load_closed_door;
                (timeline.case.clone(), timeline.digest.clone())
            });
            refusal = Some(("door_blocked", evidence));
        }
        if let Some((reason, evidence)) = refusal {
            let rejected = Task {
                id: id.clone(),
                device: index,
                task,
                scripted: false,
                state: TaskState::Rejected,
                plan: None,
                elapsed: 0.,
                carrier_at: None,
                reason: Some(reason.into()),
                rejected_by: evidence,
            };
            self.tasks.insert(id.clone(), rejected);
            self.emit(index, |sim, sequence, clock_ms| {
                sim.tasks[&id].event(sequence, clock_ms)
            });
            if blocked {
                self.raise(index, FaultCode::DoorBlocked);
            }
            return;
        }
        let plan = self.plan(index, &task);
        let accepted = Task {
            id: id.clone(),
            device: index,
            carrier_at: matches!(task, CobotTask::MoveMouldGroup { .. })
                .then_some(CarrierAt::Source),
            task,
            scripted: false,
            state: TaskState::Accepted,
            plan: Some(plan),
            elapsed: 0.,
            reason: None,
            rejected_by: None,
        };
        self.tasks.insert(id.clone(), accepted);
        self.devices[index].current = Some(id.clone());
        self.emit(index, |sim, sequence, clock_ms| {
            sim.tasks[&id].event(sequence, clock_ms)
        });
    }

    fn raise(&mut self, index: usize, code: FaultCode) {
        self.devices[index].fault = Some(code);
        self.emit(index, |_, sequence, clock_ms| ControllerEvent::Fault {
            code: code.code().into(),
            text: code.text().into(),
            sequence,
            clock_ms,
        });
    }

    fn emit_task(&mut self, id: &str) {
        if let Some(device) = self.tasks.get(id).map(|task| task.device) {
            self.emit(device, |sim, sequence, clock_ms| {
                sim.tasks[id].line(sequence, clock_ms)
            });
        }
    }

    /// Ends a task, places its mould group by where the tray is, and sends
    /// its event.
    fn end_task(
        &mut self,
        id: &str,
        state: TaskState,
        reason: Option<&str>,
        carrier: Option<CarrierAt>,
    ) {
        let Some(task) = self.tasks.get_mut(id) else {
            return;
        };
        task.state = state;
        task.reason = reason.map(str::to_string);
        let device = task.device;
        if let CobotTask::MoveMouldGroup {
            mould_group,
            from,
            to,
        } = task.task
        {
            let carrier = carrier.unwrap_or(CarrierAt::Unknown);
            task.carrier_at = Some(carrier);
            let at = match carrier {
                CarrierAt::Source => GroupAt::at(from),
                CarrierAt::Destination => GroupAt::at(to),
                CarrierAt::Tool => GroupAt::Tool {
                    device: DEVICES[device],
                },
                CarrierAt::Unknown => GroupAt::Unknown,
            };
            self.groups.insert(mould_group, at);
        }
        if self.devices[device].current.as_deref() == Some(id) {
            self.devices[device].current = None;
        }
        self.emit_task(id);
    }

    /// Ends an open task early. The arm holds where it is, so the playback
    /// knows the tray; `carrier` overrides it.
    fn end_open(&mut self, id: &str, reason: &str, carrier: Option<CarrierAt>) {
        let Some(task) = self.tasks.get(id) else {
            return;
        };
        let at = match (&task.plan, task.is_move()) {
            (Some(plan), true) => {
                Some(carrier.unwrap_or_else(|| plan.timeline.carrier_at(task.elapsed)))
            }
            _ => None,
        };
        let carrier = if task.is_move() { at } else { None };
        self.end_task(id, TaskState::Indeterminate, Some(reason), carrier);
    }

    /// A fault on one device now.
    fn trigger(&mut self, index: usize, fault: Fault) {
        match fault {
            Fault::Estop => self.estop_all(),
            Fault::ArmStop => {
                if let Some(id) = self.open_task(index) {
                    self.end_open(&id, "arm_stop", None);
                }
                self.raise(index, FaultCode::ArmStop);
            }
            Fault::GripLost => {
                if let Some(id) = self.open_task(index) {
                    let task = &self.tasks[&id];
                    let before_pickup = task
                        .plan
                        .as_ref()
                        .is_some_and(|plan| task.elapsed < plan.timeline.pickup_seconds);
                    let carrier = if before_pickup {
                        CarrierAt::Source
                    } else {
                        CarrierAt::Unknown
                    };
                    self.end_open(&id, "grip_lost", Some(carrier));
                }
                self.raise(index, FaultCode::GripLost);
            }
            Fault::DoorBlocked => {
                if let Some(id) = self.open_task(index) {
                    self.end_open(&id, "door_blocked", None);
                }
                self.raise(index, FaultCode::DoorBlocked);
            }
        }
    }

    /// The local emergency stop: every device stops. An open move keeps a
    /// known tray only before its pickup; after it nobody knows.
    fn estop_all(&mut self) {
        self.estop = true;
        for index in 0..self.devices.len() {
            if let Some(id) = self.open_task(index) {
                let task = &self.tasks[&id];
                let carrier = task.plan.as_ref().map(|plan| {
                    if task.elapsed < plan.timeline.pickup_seconds {
                        CarrierAt::Source
                    } else {
                        CarrierAt::Unknown
                    }
                });
                let carrier = if task.is_move() { carrier } else { None };
                self.end_task(&id, TaskState::Indeterminate, Some("estop"), carrier);
            }
            self.raise(index, FaultCode::Estop);
        }
    }

    /// Advances every device by `wall` seconds of wall time.
    pub fn tick(&mut self, wall: f64) {
        let dt = wall * self.time_scale;
        for index in 0..self.devices.len() {
            if self.devices[index].frozen {
                continue;
            }
            self.devices[index].clock_ms += dt * 1000.;
            self.devices[index].since_clock += wall;
            if self.devices[index].since_clock >= CLOCK_EVERY {
                self.devices[index].since_clock = 0.;
                let state = self.run_state(index);
                self.emit(index, |_, sequence, clock_ms| ControllerEvent::Clock {
                    state,
                    sequence,
                    clock_ms,
                });
            }
            self.start_due_script(index);
            self.advance_task(index, dt);
        }
        self.check_door_conflict();
        self.write_state();
    }

    fn moving(&self, index: usize) -> bool {
        let device = &self.devices[index];
        !self.estop && device.fault.is_none() && !device.stopped && !device.paused
    }

    fn advance_task(&mut self, index: usize, dt: f64) {
        let Some(id) = self.open_task(index) else {
            return;
        };
        if !self.moving(index) {
            return;
        }
        let task = self.tasks.get_mut(&id).expect("an open task exists");
        if task.state == TaskState::Accepted {
            task.state = TaskState::Running;
            self.devices[index].started += 1;
            self.emit_task(&id);
            return;
        }
        let plan = task.plan.clone().expect("a running task has a plan");
        let before = task.elapsed;
        let phase_before = task.phase();
        let mut after = (before + dt).min(plan.end_at);
        // An armed fault waits for its point of the run.
        let mut fire = None;
        match self.devices[index].armed {
            Some((fault, Some(at))) if after >= at * plan.timeline.seconds => {
                after = after.min(at * plan.timeline.seconds).max(before);
                fire = Some(fault);
            }
            Some((Fault::DoorBlocked, None))
                if task.is_move()
                    && before < plan.timeline.door.0
                    && after >= plan.timeline.door.0 =>
            {
                after = plan.timeline.door.0;
                fire = Some(Fault::DoorBlocked);
            }
            _ => {}
        }
        task.elapsed = after;
        if let Some(fault) = fire {
            self.devices[index].armed = None;
            self.trigger(index, fault);
            return;
        }
        if after >= plan.end_at {
            match plan.finish {
                Finish::Complete => {
                    let carrier = task.is_move().then_some(CarrierAt::Destination);
                    self.end_task(&id, TaskState::Completed, None, carrier);
                }
                Finish::Fail {
                    reason,
                    carrier,
                    fault,
                } => {
                    self.end_task(&id, TaskState::Indeterminate, Some(reason), Some(carrier));
                    self.raise(index, fault);
                }
            }
            return;
        }
        if task.is_move() {
            task.carrier_at = Some(plan.timeline.carrier_at(after));
        }
        if task.phase() != phase_before && !task.scripted {
            self.emit_task(&id);
        }
    }

    /// Two arms inside the oven door at the same time both stop.
    fn check_door_conflict(&mut self) {
        let inside: Vec<(usize, String)> = COBOTS
            .iter()
            .filter_map(|&cobot| {
                let id = self.open_task(cobot)?;
                let task = &self.tasks[&id];
                let plan = task.plan.as_ref()?;
                (task.state == TaskState::Running && plan.timeline.in_door(task.elapsed))
                    .then_some((cobot, id))
            })
            .collect();
        if inside.len() < 2 {
            return;
        }
        for (cobot, id) in inside {
            self.end_open(&id, "door_conflict", None);
            self.raise(cobot, FaultCode::DoorConflict);
        }
    }

    fn start_due_script(&mut self, index: usize) {
        let clock = self.devices[index].clock_ms;
        let Some(position) = self.devices[index]
            .script
            .iter()
            .position(|(at, _)| *at <= clock)
        else {
            return;
        };
        let (_, scripted) = self.devices[index].script.remove(position);
        let id = scripted.move_id.clone();
        if self.tasks.contains_key(&id) {
            return;
        }
        let refusal = self.refusal(index, &scripted.task);
        let plan = refusal.is_none().then(|| self.plan(index, &scripted.task));
        let task = Task {
            id: id.clone(),
            device: index,
            carrier_at: refusal.is_none().then_some(CarrierAt::Source),
            task: scripted.task,
            scripted: true,
            state: if refusal.is_some() {
                TaskState::Rejected
            } else {
                TaskState::Running
            },
            plan,
            elapsed: 0.,
            reason: refusal.map(str::to_string),
            rejected_by: None,
        };
        self.tasks.insert(id.clone(), task);
        if refusal.is_none() {
            self.devices[index].current = Some(id.clone());
            self.devices[index].started += 1;
        }
        self.emit_task(&id);
    }

    /// One line on the control port. The answer is one JSON value.
    pub fn control(&mut self, line: &str) -> Value {
        let op: PortOp = match serde_json::from_str(line) {
            Ok(op) => op,
            Err(error) => return json!({ "ok": false, "error": error.to_string() }),
        };
        let device = |name: &str| DEVICES.iter().position(|key| *key == name);
        let unknown = |name: &str| json!({ "ok": false, "error": format!("no device {name}") });
        match op {
            PortOp::State => self.state(),
            PortOp::Reset => {
                self.reset();
                json!({ "ok": true })
            }
            PortOp::Inject {
                device: name,
                fault,
                at_progress,
            } => {
                let Some(index) = device(&name) else {
                    return unknown(&name);
                };
                if !self.devices[index].cobot && fault != Fault::Estop {
                    return json!({ "ok": false, "error": "only an arm has this fault" });
                }
                if at_progress.is_some_and(|at| !(0. ..=1.).contains(&at)) {
                    return json!({ "ok": false, "error": "atProgress is between 0 and 1" });
                }
                self.inject(index, fault, at_progress);
                json!({ "ok": true, "armed": self.devices[index].armed.is_some() })
            }
            PortOp::Clear { device: name } => {
                let Some(index) = device(&name) else {
                    return unknown(&name);
                };
                self.clear(index);
                json!({ "ok": true })
            }
            PortOp::Freeze { device: name } => {
                let Some(index) = device(&name) else {
                    return unknown(&name);
                };
                self.devices[index].frozen = true;
                self.dirty = true;
                json!({ "ok": true })
            }
            PortOp::Stale { device: name } => {
                let Some(index) = device(&name) else {
                    return unknown(&name);
                };
                let device = &mut self.devices[index];
                let older = device
                    .sent
                    .iter()
                    .find(|(is_task, _)| *is_task)
                    .or_else(|| device.sent.front())
                    .map(|(_, line)| line.clone());
                match older {
                    Some(line) => {
                        write_line(&mut device.subscribers, &line);
                        json!({ "ok": true, "sent": serde_json::from_str::<Value>(&line).unwrap_or(Value::Null) })
                    }
                    None => json!({ "ok": false, "error": "the device sent nothing yet" }),
                }
            }
            PortOp::Script {
                device: name,
                moves,
            } => {
                let Some(index) = device(&name) else {
                    return unknown(&name);
                };
                let clock = self.devices[index].clock_ms;
                let count = moves.len();
                self.devices[index].script.extend(
                    moves
                        .into_iter()
                        .map(|scripted| (clock + scripted.after_ms as f64, scripted)),
                );
                json!({ "ok": true, "scheduled": count })
            }
        }
    }

    fn inject(&mut self, index: usize, fault: Fault, at_progress: Option<f64>) {
        let open = self.open_task(index);
        let running = open.as_ref().and_then(|id| {
            let task = &self.tasks[id];
            task.plan
                .as_ref()
                .map(|plan| (task.elapsed, plan.clone(), task.task.clone()))
        });
        match (fault, at_progress, running) {
            // A stop or an emergency stop with no point happens now.
            (Fault::Estop | Fault::ArmStop, None, _) => self.trigger(index, fault),
            (
                Fault::GripLost,
                None,
                Some((elapsed, plan, CobotTask::MoveMouldGroup { from, .. })),
            ) => {
                let slip = &self.physics.load_slip;
                if from.station == Station::ColdRack && elapsed < slip.ends_at() {
                    // The running loading switches to the engine's slip case,
                    // which follows the same plan up to the loss.
                    let id = open.expect("a running task has an id");
                    self.tasks.get_mut(&id).expect("an open task exists").plan =
                        Some(slip_plan(slip, self.physics.load.seconds));
                } else {
                    let middle = (plan.timeline.pickup_seconds + plan.timeline.seconds) / 2.;
                    let at = middle.max(elapsed) / plan.timeline.seconds;
                    self.devices[index].armed = Some((Fault::GripLost, Some(at)));
                }
            }
            (Fault::DoorBlocked, _, Some((elapsed, plan, _)))
                if elapsed >= plan.timeline.door.0 =>
            {
                // The arm is past the door; the next move meets the blocked door.
                self.devices[index].armed = Some((Fault::DoorBlocked, None));
            }
            (Fault::DoorBlocked, _, _) => {
                self.devices[index].armed = Some((Fault::DoorBlocked, None))
            }
            _ => self.devices[index].armed = Some((fault, at_progress)),
        }
        self.dirty = true;
    }

    /// A person at the machine clears the device: its fault, its stop and a
    /// frozen clock. Clearing any device ends the emergency stop. A mould
    /// group that stayed on its tool is no longer known.
    fn clear(&mut self, index: usize) {
        self.devices[index].frozen = false;
        self.devices[index].stopped = false;
        self.devices[index].armed = None;
        if self.estop {
            self.estop = false;
            for other in 0..self.devices.len() {
                if self.devices[other].fault == Some(FaultCode::Estop) {
                    self.cleared(other);
                }
            }
        }
        if self.devices[index].fault.is_some() {
            self.cleared(index);
        }
        let key = DEVICES[index];
        for at in self.groups.values_mut() {
            if *at == (GroupAt::Tool { device: key }) {
                *at = GroupAt::Unknown;
            }
        }
        self.dirty = true;
    }

    fn cleared(&mut self, index: usize) {
        if let Some(code) = self.devices[index].fault.take() {
            self.emit(index, |_, sequence, clock_ms| {
                ControllerEvent::FaultCleared {
                    code: code.code().into(),
                    sequence,
                    clock_ms,
                }
            });
        }
    }

    fn reset(&mut self) {
        self.estop = false;
        for index in 0..self.devices.len() {
            let device = &mut self.devices[index];
            device.frozen = false;
            device.paused = false;
            device.stopped = false;
            device.current = None;
            device.armed = None;
            device.script.clear();
            self.cleared(index);
        }
        self.tasks.clear();
        self.groups = default_groups();
        self.dirty = true;
    }

    /// The world and each device, for evidence.
    pub fn state(&self) -> Value {
        let devices: Vec<Value> = (0..self.devices.len())
            .map(|index| {
                let device = &self.devices[index];
                json!({
                    "sourceKey": device.key,
                    "state": self.run_state(index),
                    "fault": device.fault,
                    "frozen": device.frozen,
                    "sequence": device.sequence,
                    "clockMs": device.clock_ms.floor() as u64,
                    "currentTask": device.current,
                    "armed": device.armed.map(|(fault, at)| json!({ "fault": fault, "atProgress": at })),
                    "operations": device.ops,
                    "tasksStarted": device.started,
                    "connections": device.subscribers.len(),
                })
            })
            .collect();
        let tasks: Vec<Value> = self
            .tasks
            .values()
            .map(|task| {
                let (case, digest) = match (&task.plan, &task.rejected_by) {
                    (Some(plan), _) => (
                        Some(plan.timeline.case.clone()),
                        Some(plan.timeline.digest.clone()),
                    ),
                    (None, Some((case, digest))) => (Some(case.clone()), Some(digest.clone())),
                    (None, None) => (None, None),
                };
                json!({
                    "taskId": task.id,
                    "sourceKey": DEVICES[task.device],
                    "scripted": task.scripted,
                    "task": task.task,
                    "state": task.state,
                    "progress": task.progress().map(round_ms),
                    "carrierAt": task.carrier_at,
                    "reason": task.reason,
                    "observedSeconds": task.observed_seconds(),
                    "physicsCase": case,
                    "physicsDigest": digest.filter(|digest| !digest.is_empty()),
                })
            })
            .collect();
        let groups: Vec<Value> = self
            .groups
            .iter()
            .map(|(group, at)| json!({ "mouldGroup": group, "at": at }))
            .collect();
        json!({
            "ok": true,
            "timeScale": self.time_scale,
            "estop": self.estop,
            "devices": devices,
            "tasks": tasks,
            "world": { "mouldGroups": groups },
            "physics": self.physics.all(),
        })
    }

    fn write_state(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        if let Some(path) = &self.state_file {
            let next = path.with_extension("json.next");
            let written = std::fs::write(&next, self.state().to_string())
                .and_then(|()| std::fs::rename(&next, path));
            if let Err(error) = written {
                eprintln!("{}: {error}", path.display());
            }
        }
    }
}

/// The engine's slip run, measured against the nominal loading's length, so
/// that its progress matches the loading that it replaces.
fn slip_plan(slip: &Timeline, nominal_seconds: f64) -> Plan {
    let carrier = match &slip.end {
        End::Failed { carrier_at, .. } => *carrier_at,
        End::Completed => CarrierAt::Unknown,
    };
    Plan {
        timeline: Timeline {
            seconds: nominal_seconds,
            ..slip.clone()
        },
        end_at: slip.ends_at(),
        finish: Finish::Fail {
            reason: "grip_lost",
            carrier,
            fault: FaultCode::GripLost,
        },
    }
}

fn write_line(subscribers: &mut Vec<TcpStream>, line: &str) {
    subscribers.retain_mut(|stream| {
        stream
            .write_all(line.as_bytes())
            .and_then(|()| stream.write_all(b"\n"))
            .and_then(|()| stream.flush())
            .is_ok()
    });
}
