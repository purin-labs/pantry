//! The cobot task adapter (Plan 24 S3).
//!
//! Pantry sends named tasks (`cobot_task`, `cobot_inquire`) and `pause`,
//! `resume` and `stop` for a cobot or the oven. This adapter translates them
//! into the controller protocol: JSON lines over TCP, one connection for each
//! device (`crates/bakery-native/controller` is the simulator). It translates
//! the controller's events back. Pantry never talks to a controller. The
//! controller addresses stay in this computer's `cobots.json`.
//!
//! The journal `cobot-journal.json` records each dispatch before the
//! `submit`. A second `cobot_task` with a known `requestId` answers from the
//! journal with `replayed: true` and sends nothing to the controller: a
//! duplicate delivery resolves to the first task. After a reconnect to a
//! controller, and after a restart of the gateway, the adapter asks `status`
//! for each open task by its identity. It never sends `submit` again.

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::journal::{self, now_seconds};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const RECONNECT_WAIT: Duration = Duration::from_secs(1);
/// A controller that does not answer a pause, a resume or a stop in this time
/// gives `ack refused`.
const CONTROL_ANSWER: Duration = Duration::from_secs(5);
/// At most one `cobot_clock` message each second.
const CLOCK_EVERY: Duration = Duration::from_secs(1);
/// At start, the first hello waits this long for the controllers' devices.
const FIRST_HELLO_WAIT: Duration = Duration::from_secs(3);

/// One device's controller on the shop LAN or on this computer.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerAddress {
    pub source_key: String,
    pub host: String,
    pub port: u16,
}

/// `cobots.json` in the gateway's folder.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CobotsFile {
    #[serde(default)]
    controllers: Vec<ControllerAddress>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Station {
    ColdRack,
    Oven,
    CoolingRack,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Place {
    station: Station,
    shelf: u8,
}

/// A named task. The gateway passes it to the controller as it is; it never
/// holds joint angles, speeds or safety settings.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CobotTask {
    MoveMouldGroup {
        mould_group: u8,
        from: Place,
        to: Place,
    },
    Bake {
        program_seconds: u32,
        temperature_c: u32,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskState {
    Accepted,
    Running,
    Completed,
    Rejected,
    Indeterminate,
}

/// A controller's task state. `unknown` answers a `status` for a task that
/// the controller never saw.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ControllerTaskState {
    Accepted,
    Running,
    Completed,
    Rejected,
    Indeterminate,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CarrierAt {
    Source,
    Tool,
    Destination,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RunState {
    Idle,
    Busy,
    Paused,
    Stopped,
    Estop,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ControlOp {
    Pause,
    Resume,
    Stop,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ControlOutcome {
    Done,
    Refused,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ObservedState {
    Started,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    id: String,
    label: String,
    revision: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControllerDevice {
    source_key: String,
    kind: String,
    model: String,
    serial: Option<String>,
    firmware: Option<String>,
    capabilities: Vec<Capability>,
}

/// One line from a controller. Each line has the device's `sequence`, which
/// only rises, and its monotonic `clockMs`.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ControllerEvent {
    Hello {
        device: ControllerDevice,
        state: RunState,
        sequence: u64,
        clock_ms: u64,
    },
    Task {
        task_id: String,
        state: ControllerTaskState,
        progress: Option<f64>,
        phase: Option<String>,
        carrier_at: Option<CarrierAt>,
        reason: Option<String>,
        observed_seconds: Option<f64>,
        sequence: u64,
        clock_ms: u64,
    },
    Control {
        op: ControlOp,
        outcome: ControlOutcome,
        sequence: u64,
        clock_ms: u64,
    },
    Clock {
        state: RunState,
        sequence: u64,
        clock_ms: u64,
    },
    Fault {
        code: String,
        text: String,
        sequence: u64,
        clock_ms: u64,
    },
    FaultCleared {
        code: String,
        sequence: u64,
        clock_ms: u64,
    },
    Observed {
        move_id: String,
        task: CobotTask,
        state: ObservedState,
        carrier_at: Option<CarrierAt>,
        reason: Option<String>,
        sequence: u64,
        clock_ms: u64,
    },
}

impl ControllerEvent {
    /// The device's sequence and clock on this line.
    fn stamp(&self) -> (u64, u64) {
        match self {
            ControllerEvent::Hello {
                sequence, clock_ms, ..
            }
            | ControllerEvent::Task {
                sequence, clock_ms, ..
            }
            | ControllerEvent::Control {
                sequence, clock_ms, ..
            }
            | ControllerEvent::Clock {
                sequence, clock_ms, ..
            }
            | ControllerEvent::Fault {
                sequence, clock_ms, ..
            }
            | ControllerEvent::FaultCleared {
                sequence, clock_ms, ..
            }
            | ControllerEvent::Observed {
                sequence, clock_ms, ..
            } => (*sequence, *clock_ms),
        }
    }
}

/// What Pantry sends that this adapter answers.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    CobotTask {
        request_id: String,
        source_key: String,
        run_id: String,
        task_id: String,
        task: CobotTask,
    },
    CobotInquire {
        request_id: String,
        source_key: String,
    },
    Pause {
        request_id: String,
        source_key: String,
    },
    Resume {
        request_id: String,
        source_key: String,
    },
    Stop {
        request_id: String,
        source_key: String,
    },
}

/// The latest state of one task as the controller reported it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Report {
    state: TaskState,
    /// The controller's sequence. 0 when the gateway decided without the
    /// controller, for example when the controller was offline.
    sequence: u64,
    device_clock_ms: u64,
    progress: Option<f64>,
    phase: Option<String>,
    carrier_at: Option<CarrierAt>,
    reason: Option<String>,
    observed_seconds: Option<f64>,
}

impl Report {
    /// A report that the gateway makes with no controller answer.
    fn gateway(state: TaskState, reason: &str) -> Self {
        Self {
            state,
            sequence: 0,
            device_clock_ms: 0,
            progress: None,
            phase: None,
            carrier_at: None,
            reason: Some(reason.to_string()),
            observed_seconds: None,
        }
    }

    fn message(&self, request_id: &str, source_key: &str, replayed: bool) -> Value {
        json!({
            "type": "cobot_report",
            "requestId": request_id,
            "sourceKey": source_key,
            "state": self.state,
            "sequence": self.sequence,
            "deviceClockMs": self.device_clock_ms,
            "progress": self.progress,
            "phase": self.phase,
            "carrierAt": self.carrier_at,
            "reason": self.reason,
            "observedSeconds": self.observed_seconds,
            "replayed": replayed,
        })
    }
}

/// One dispatch in the journal, by its `requestId`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dispatch {
    source_key: String,
    run_id: String,
    task_id: String,
    task: CobotTask,
    /// None from the journal write until the controller's first answer.
    last: Option<Report>,
    at_seconds: u64,
}

impl Dispatch {
    /// The controller has not ended it, as far as the journal knows.
    fn is_open(&self) -> bool {
        self.last
            .as_ref()
            .is_none_or(|last| matches!(last.state, TaskState::Accepted | TaskState::Running))
    }

    fn is_running(&self) -> bool {
        self.last
            .as_ref()
            .is_some_and(|last| matches!(last.state, TaskState::Accepted | TaskState::Running))
    }
}

enum Incoming {
    Connected(usize, TcpStream),
    Line(usize, String),
    Disconnected(usize),
}

struct Link {
    address: ControllerAddress,
    writer: Option<TcpStream>,
    device: Option<Value>,
    clock: Option<(u64, u64, RunState)>,
    pending: VecDeque<(String, ControlOp, Instant)>,
}

pub struct Cobots {
    links: Vec<Link>,
    incoming: Receiver<Incoming>,
    journal_path: PathBuf,
    journal: BTreeMap<String, Dispatch>,
    /// Messages for Pantry, sent when the session is welcomed.
    outbox: Vec<Value>,
    devices_changed: bool,
    last_clock: Option<Instant>,
}

impl Cobots {
    /// Reads `cobots.json` and the journal, and starts one connection for
    /// each controller. A run with `--simulate` adds its `cobots` list.
    pub fn load(folder: &Path, simulated: Vec<ControllerAddress>) -> Result<Self, String> {
        let file: CobotsFile = journal::load(&folder.join("cobots.json"))?;
        let journal_path = folder.join("cobot-journal.json");
        let mut journal: BTreeMap<String, Dispatch> = journal::load(&journal_path)?;
        let oldest = journal::oldest_kept();
        journal.retain(|_, dispatch| dispatch.is_open() || dispatch.at_seconds >= oldest);
        let (sender, incoming) = channel();
        let links = file
            .controllers
            .into_iter()
            .chain(simulated)
            .enumerate()
            .map(|(index, address)| {
                let sender = sender.clone();
                let dialed = address.clone();
                thread::spawn(move || connect_loop(index, dialed, sender));
                Link {
                    address,
                    writer: None,
                    device: None,
                    clock: None,
                    pending: VecDeque::new(),
                }
            })
            .collect();
        Ok(Self {
            links,
            incoming,
            journal_path,
            journal,
            outbox: Vec::new(),
            devices_changed: false,
            last_clock: None,
        })
    }

    /// Waits a short time for each controller's hello, so that the first
    /// hello to Pantry holds the devices.
    pub fn wait_for_devices(&mut self) {
        let started = Instant::now();
        while self.links.iter().any(|link| link.device.is_none())
            && started.elapsed() < FIRST_HELLO_WAIT
        {
            match self.incoming.recv_timeout(Duration::from_millis(50)) {
                Ok(incoming) => self.receive(incoming),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        self.devices_changed = false;
    }

    /// The devices that the controllers reported, for the gateway's hello.
    pub fn found_devices(&self) -> Vec<Value> {
        self.links
            .iter()
            .filter_map(|link| link.device.clone())
            .collect()
    }

    /// True once after a controller reported a new or changed device.
    pub fn take_devices_changed(&mut self) -> bool {
        std::mem::take(&mut self.devices_changed)
    }

    fn link_of(&self, source_key: &str) -> Option<usize> {
        self.links
            .iter()
            .position(|link| link.address.source_key == source_key)
    }

    /// Answers a message from Pantry, or None when it is not this adapter's.
    /// `pause`, `resume` and `stop` are this adapter's only for its devices.
    pub fn handle(&mut self, message: &Value) -> Option<Result<Vec<Value>, String>> {
        match message.get("type").and_then(Value::as_str)? {
            "cobot_task" | "cobot_inquire" => {}
            "pause" | "resume" | "stop" => {
                let source_key = message.get("sourceKey").and_then(Value::as_str)?;
                self.link_of(source_key)?;
            }
            _ => return None,
        }
        let request: Request = match serde_json::from_value(message.clone()) {
            Ok(request) => request,
            Err(error) => return Some(Err(format!("a cobot message: {error}"))),
        };
        Some(self.answer(request))
    }

    fn answer(&mut self, request: Request) -> Result<Vec<Value>, String> {
        match request {
            Request::CobotTask {
                request_id,
                source_key,
                run_id,
                task_id,
                task,
            } => self.dispatch(request_id, source_key, run_id, task_id, task),
            Request::CobotInquire {
                request_id,
                source_key,
            } => {
                let Some(index) = self.link_of(&source_key) else {
                    let unknown = Report::gateway(TaskState::Rejected, "unknown_device");
                    return Ok(vec![unknown.message(&request_id, &source_key, false)]);
                };
                if self.send(index, &json!({ "op": "status", "taskId": request_id })) {
                    return Ok(Vec::new());
                }
                // The controller is away: the journal answers, and nothing is sent.
                let report = self
                    .journal
                    .get(&request_id)
                    .and_then(|dispatch| dispatch.last.clone())
                    .unwrap_or_else(|| {
                        Report::gateway(TaskState::Indeterminate, "controller_offline")
                    });
                Ok(vec![report.message(&request_id, &source_key, true)])
            }
            Request::Pause {
                request_id,
                source_key,
            } => Ok(self.control(request_id, &source_key, ControlOp::Pause)),
            Request::Resume {
                request_id,
                source_key,
            } => Ok(self.control(request_id, &source_key, ControlOp::Resume)),
            Request::Stop {
                request_id,
                source_key,
            } => Ok(self.control(request_id, &source_key, ControlOp::Stop)),
        }
    }

    fn dispatch(
        &mut self,
        request_id: String,
        source_key: String,
        run_id: String,
        task_id: String,
        task: CobotTask,
    ) -> Result<Vec<Value>, String> {
        let Some(index) = self.link_of(&source_key) else {
            let unknown = Report::gateway(TaskState::Rejected, "unknown_device");
            return Ok(vec![unknown.message(&request_id, &source_key, false)]);
        };
        if let Some(known) = self.journal.get(&request_id) {
            // A duplicate delivery resolves to the first task. A dispatch with
            // no controller answer yet gets that answer when it comes.
            return Ok(known
                .last
                .iter()
                .map(|last| last.message(&request_id, &known.source_key, true))
                .collect());
        }
        let offline = self.links[index].writer.is_none();
        let dispatch = Dispatch {
            source_key: source_key.clone(),
            run_id,
            task_id,
            task: task.clone(),
            last: offline.then(|| Report::gateway(TaskState::Rejected, "controller_offline")),
            at_seconds: now_seconds(),
        };
        let answer = dispatch
            .last
            .iter()
            .map(|last| last.message(&request_id, &source_key, false))
            .collect();
        // The journal holds the dispatch before the controller sees it.
        self.journal.insert(request_id.clone(), dispatch);
        self.persist()?;
        if !offline {
            // A write that fails leaves the task open; the reconnect asks status.
            self.send(
                index,
                &json!({ "op": "submit", "taskId": request_id, "task": task }),
            );
        }
        Ok(answer)
    }

    /// A pause, a resume or a stop goes to the controller. Its `ack` waits
    /// for the controller's answer.
    fn control(&mut self, request_id: String, source_key: &str, op: ControlOp) -> Vec<Value> {
        let sent = self
            .link_of(source_key)
            .filter(|&index| self.send(index, &json!({ "op": op })));
        match sent {
            Some(index) => {
                self.links[index]
                    .pending
                    .push_back((request_id, op, Instant::now()));
                Vec::new()
            }
            None => vec![ack(&request_id, ControlOutcome::Refused)],
        }
    }

    /// Asks each connected controller the state of each open task. After a
    /// welcome, so that Pantry gets the state it may have missed.
    pub fn reopen(&mut self) {
        for index in 0..self.links.len() {
            self.ask_open(index);
        }
    }

    fn ask_open(&mut self, index: usize) {
        let source_key = self.links[index].address.source_key.clone();
        let open: Vec<String> = self
            .journal
            .iter()
            .filter(|(_, dispatch)| dispatch.source_key == source_key && dispatch.is_open())
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in open {
            self.send(index, &json!({ "op": "status", "taskId": request_id }));
        }
    }

    /// Reads the controllers' events, ends the control requests that got no
    /// answer in time, and adds the clock. Returns the messages for Pantry.
    pub fn tick(&mut self) -> Vec<Value> {
        while let Ok(incoming) = self.incoming.try_recv() {
            self.receive(incoming);
        }
        for link in &mut self.links {
            while link
                .pending
                .front()
                .is_some_and(|(_, _, at)| at.elapsed() >= CONTROL_ANSWER)
            {
                if let Some((request_id, _, _)) = link.pending.pop_front() {
                    self.outbox.push(ack(&request_id, ControlOutcome::Refused));
                }
            }
        }
        let running = self.journal.values().any(Dispatch::is_running);
        if running && self.last_clock.is_none_or(|at| at.elapsed() >= CLOCK_EVERY) {
            let clocks: Vec<Value> = self
                .links
                .iter()
                .filter_map(|link| {
                    link.clock.map(|(sequence, clock_ms, state)| {
                        json!({
                            "sourceKey": link.address.source_key,
                            "sequence": sequence,
                            "deviceClockMs": clock_ms,
                            "state": state,
                        })
                    })
                })
                .collect();
            if !clocks.is_empty() {
                self.outbox
                    .push(json!({ "type": "cobot_clock", "clocks": clocks }));
                self.last_clock = Some(Instant::now());
            }
        }
        std::mem::take(&mut self.outbox)
    }

    fn receive(&mut self, incoming: Incoming) {
        match incoming {
            Incoming::Connected(index, writer) => {
                self.links[index].writer = Some(writer);
                self.send(index, &json!({ "op": "hello" }));
                self.ask_open(index);
            }
            Incoming::Disconnected(index) => {
                self.links[index].writer = None;
                self.links[index].clock = None;
            }
            Incoming::Line(index, line) => match serde_json::from_str(&line) {
                Ok(event) => self.apply(index, event),
                Err(error) => eprintln!(
                    "{}: refused a controller line: {error}",
                    self.links[index].address.source_key
                ),
            },
        }
    }

    fn apply(&mut self, index: usize, event: ControllerEvent) {
        let source_key = self.links[index].address.source_key.clone();
        // Each line moves the device's clock on; an older line does not.
        let (sequence, clock_ms) = event.stamp();
        if let Some((last, _, state)) = self.links[index].clock
            && sequence > last
        {
            self.links[index].clock = Some((sequence, clock_ms, state));
        }
        match event {
            ControllerEvent::Hello {
                device,
                state,
                sequence,
                clock_ms,
            } => {
                if device.source_key != source_key {
                    eprintln!(
                        "{source_key}: the controller says it is {}; check cobots.json",
                        device.source_key
                    );
                    return;
                }
                self.links[index].clock = Some((sequence, clock_ms, state));
                let found = found_device(device);
                if self.links[index].device.as_ref() != Some(&found) {
                    self.links[index].device = Some(found);
                    self.devices_changed = true;
                }
            }
            ControllerEvent::Clock {
                state,
                sequence,
                clock_ms,
            } => self.links[index].clock = Some((sequence, clock_ms, state)),
            ControllerEvent::Task {
                task_id,
                state,
                progress,
                phase,
                carrier_at,
                reason,
                observed_seconds,
                sequence,
                clock_ms,
            } => {
                let (state, reason) = match state {
                    ControllerTaskState::Accepted => (TaskState::Accepted, reason),
                    ControllerTaskState::Running => (TaskState::Running, reason),
                    ControllerTaskState::Completed => (TaskState::Completed, reason),
                    ControllerTaskState::Rejected => (TaskState::Rejected, reason),
                    ControllerTaskState::Indeterminate => (TaskState::Indeterminate, reason),
                    // The controller has no record. The task is never sent again.
                    ControllerTaskState::Unknown => (
                        TaskState::Indeterminate,
                        Some("controller_has_no_record".into()),
                    ),
                };
                let report = Report {
                    state,
                    sequence,
                    device_clock_ms: clock_ms,
                    progress: progress.map(|value| value.clamp(0., 1.)),
                    phase: phase.map(|text| short_text(&text)),
                    carrier_at,
                    reason: reason.map(|text| reason_code(&text)),
                    observed_seconds: observed_seconds.map(|value| value.max(0.)),
                };
                self.task_report(&task_id, &source_key, report);
            }
            ControllerEvent::Control { op, outcome, .. } => {
                let pending = &mut self.links[index].pending;
                if let Some(position) = pending.iter().position(|(_, sent, _)| *sent == op)
                    && let Some((request_id, _, _)) = pending.remove(position)
                {
                    self.outbox.push(ack(&request_id, outcome));
                }
            }
            ControllerEvent::Fault { code, text, .. } => self.outbox.push(json!({
                "type": "health",
                "reports": [{
                    "sourceKey": source_key,
                    "health": "fault",
                    "faultCode": fault_code(&code),
                    "faultText": text.chars().take(500).collect::<String>(),
                }],
            })),
            ControllerEvent::FaultCleared { code, .. } => {
                eprintln!("{source_key}: the controller cleared {code}");
                self.outbox.push(json!({
                "type": "health",
                "reports": [{
                    "sourceKey": source_key,
                    "health": "ok",
                    "faultCode": Value::Null,
                    "faultText": Value::Null,
                }],
                }));
            }
            ControllerEvent::Observed {
                move_id,
                task,
                state,
                carrier_at,
                reason,
                sequence,
                clock_ms,
            } => self.outbox.push(json!({
                "type": "cobot_observed",
                "sourceKey": source_key,
                "observationId": short_text(&move_id),
                "task": task,
                "state": state,
                "sequence": sequence,
                "deviceClockMs": clock_ms,
                "carrierAt": carrier_at,
                "reason": reason.map(|text| reason_code(&text)),
            })),
        }
    }

    /// Records a controller's report in the journal and passes it to Pantry.
    /// A report with a sequence that is not above the journal's goes to
    /// Pantry as evidence of stale data, and the journal keeps its state.
    fn task_report(&mut self, task_id: &str, source_key: &str, report: Report) {
        if !is_dispatch_id(task_id) {
            eprintln!("{source_key}: a report for {task_id}, which Pantry did not send");
            return;
        }
        if let Some(dispatch) = self.journal.get_mut(task_id) {
            let fresh = dispatch
                .last
                .as_ref()
                .is_none_or(|last| last.sequence == 0 || report.sequence > last.sequence);
            if fresh {
                dispatch.last = Some(report.clone());
                dispatch.at_seconds = now_seconds();
                if let Err(error) = self.persist() {
                    eprintln!("The cobot journal: {error}");
                }
            }
        }
        self.outbox.push(report.message(task_id, source_key, false));
    }

    fn send(&mut self, index: usize, message: &Value) -> bool {
        let link = &mut self.links[index];
        let Some(writer) = link.writer.as_mut() else {
            return false;
        };
        let written = writeln!(writer, "{message}").and_then(|()| writer.flush());
        if written.is_err() {
            // The connection thread sees the end and dials again.
            link.writer = None;
        }
        written.is_ok()
    }

    fn persist(&self) -> Result<(), String> {
        journal::save(&self.journal_path, &self.journal)
    }
}

fn connect_loop(index: usize, address: ControllerAddress, sender: Sender<Incoming>) {
    loop {
        if let Some(stream) = dial(&address)
            && let Ok(writer) = stream.try_clone()
        {
            if sender.send(Incoming::Connected(index, writer)).is_err() {
                return;
            }
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if !line.trim().is_empty() && sender.send(Incoming::Line(index, line)).is_err() {
                    return;
                }
            }
            if sender.send(Incoming::Disconnected(index)).is_err() {
                return;
            }
        }
        thread::sleep(RECONNECT_WAIT);
    }
}

fn dial(address: &ControllerAddress) -> Option<TcpStream> {
    let socket = (address.host.as_str(), address.port)
        .to_socket_addrs()
        .ok()?
        .next()?;
    let stream = TcpStream::connect_timeout(&socket, CONNECT_TIMEOUT).ok()?;
    stream.set_nodelay(true).ok()?;
    stream.set_write_timeout(Some(CONNECT_TIMEOUT)).ok()?;
    Some(stream)
}

fn found_device(device: ControllerDevice) -> Value {
    let kind = match device.kind.as_str() {
        "cobot" | "appliance" => device.kind.as_str(),
        _ => "other",
    };
    let capabilities: Vec<Value> = device
        .capabilities
        .iter()
        .take(32)
        .map(|capability| {
            json!({
                "id": short_text(&capability.id),
                "label": short_text(&capability.label),
                "revision": capability.revision.max(1),
            })
        })
        .collect();
    json!({
        "sourceKey": device.source_key,
        "kind": kind,
        "suggestedName": device.source_key,
        "model": short_text(&device.model),
        "serial": device.serial.as_deref().map(short_text),
        "firmwareVersion": device.firmware.as_deref().map(short_text),
        "capabilities": capabilities,
    })
}

fn ack(request_id: &str, outcome: ControlOutcome) -> Value {
    json!({ "type": "ack", "requestId": request_id, "outcome": outcome })
}

/// The protocol's dispatch identity: `dsp_` and 24 lower-case hex digits.
fn is_dispatch_id(text: &str) -> bool {
    text.strip_prefix("dsp_").is_some_and(|hex| {
        hex.len() == 24
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// A controller's text, cut to the protocol's 120 characters.
fn short_text(text: &str) -> String {
    let cut: String = text.chars().take(120).collect();
    if cut.is_empty() { "-".into() } else { cut }
}

/// A controller's reason as the protocol's reason code.
fn reason_code(text: &str) -> String {
    let valid = !text.is_empty()
        && text.len() <= 40
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if valid {
        text.to_string()
    } else {
        "controller_reason".into()
    }
}

/// A controller's fault code as the Devices page's fault code.
fn fault_code(text: &str) -> String {
    let code: String = text
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .take(16)
        .collect();
    if code.is_empty() {
        "FAULT".into()
    } else {
        code
    }
}
