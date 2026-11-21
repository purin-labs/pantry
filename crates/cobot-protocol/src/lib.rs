//! The controller protocol of Plan 24 (part B): JSON lines over TCP, one
//! connection for each device. The shop gateway's `cobot` adapter
//! (`crates/shop-gateway`) sends `DeviceOp` lines and reads `ControllerEvent`
//! lines. The controller simulator (`crates/bakery-native/controller`) does
//! the reverse. Both sides use these types, so the wire has one definition.
#![deny(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Station {
    ColdRack,
    Oven,
    CoolingRack,
}

impl Station {
    /// The shelves of the default layout.
    pub fn shelves(self) -> u8 {
        match self {
            Station::ColdRack | Station::CoolingRack => 12,
            Station::Oven => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Place {
    pub station: Station,
    pub shelf: u8,
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
pub enum CobotTask {
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
pub enum TaskState {
    Accepted,
    Running,
    Completed,
    Rejected,
    Indeterminate,
}

impl TaskState {
    /// The device has not ended the task.
    pub fn is_open(self) -> bool {
        matches!(self, TaskState::Accepted | TaskState::Running)
    }
}

/// A controller's task state. `unknown` answers a `status` for a task that
/// the controller never saw.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControllerTaskState {
    Accepted,
    Running,
    Completed,
    Rejected,
    Indeterminate,
    Unknown,
}

impl ControllerTaskState {
    /// The task state, or None when the controller has no record.
    pub fn known(self) -> Option<TaskState> {
        match self {
            ControllerTaskState::Accepted => Some(TaskState::Accepted),
            ControllerTaskState::Running => Some(TaskState::Running),
            ControllerTaskState::Completed => Some(TaskState::Completed),
            ControllerTaskState::Rejected => Some(TaskState::Rejected),
            ControllerTaskState::Indeterminate => Some(TaskState::Indeterminate),
            ControllerTaskState::Unknown => None,
        }
    }
}

impl From<TaskState> for ControllerTaskState {
    fn from(state: TaskState) -> Self {
        match state {
            TaskState::Accepted => ControllerTaskState::Accepted,
            TaskState::Running => ControllerTaskState::Running,
            TaskState::Completed => ControllerTaskState::Completed,
            TaskState::Rejected => ControllerTaskState::Rejected,
            TaskState::Indeterminate => ControllerTaskState::Indeterminate,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarrierAt {
    Source,
    Tool,
    Destination,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Idle,
    Busy,
    Paused,
    Stopped,
    Estop,
}

/// A pause, a resume or a stop of one device.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlOp {
    Pause,
    Resume,
    Stop,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlOutcome {
    Done,
    Refused,
}

/// The state of a move that the controller ran from its own script (shadow
/// mode, Plan 24 S5).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservedState {
    Started,
    Completed,
    Failed,
}

/// The fault codes of the simulator. A real controller can send other codes;
/// the `fault` event carries the code as text.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FaultCode {
    Estop,
    ArmStop,
    GripLost,
    DoorBlocked,
    DoorConflict,
}

impl FaultCode {
    /// The code on the wire.
    pub fn code(self) -> &'static str {
        match self {
            FaultCode::Estop => "ESTOP",
            FaultCode::ArmStop => "ARM_STOP",
            FaultCode::GripLost => "GRIP_LOST",
            FaultCode::DoorBlocked => "DOOR_BLOCKED",
            FaultCode::DoorConflict => "DOOR_CONFLICT",
        }
    }

    pub fn text(self) -> &'static str {
        match self {
            FaultCode::Estop => "The local emergency stop is pressed.",
            FaultCode::ArmStop => "The arm stopped. A person must check it.",
            FaultCode::GripLost => "The gripper lost the mould group.",
            FaultCode::DoorBlocked => "The oven door blocks the arm.",
            FaultCode::DoorConflict => "Two arms are inside the oven door at the same time.",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub id: String,
    pub label: String,
    pub revision: u32,
}

/// The device in a controller's `hello`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerDevice {
    pub source_key: String,
    /// `cobot` or `appliance`.
    pub kind: String,
    pub model: String,
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub capabilities: Vec<Capability>,
}

/// One line from the gateway on a device connection.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeviceOp {
    Hello,
    Submit { task_id: String, task: CobotTask },
    Status { task_id: String },
    Pause,
    Resume,
    Stop,
}

impl DeviceOp {
    pub fn name(&self) -> &'static str {
        match self {
            DeviceOp::Hello => "hello",
            DeviceOp::Submit { .. } => "submit",
            DeviceOp::Status { .. } => "status",
            DeviceOp::Pause => "pause",
            DeviceOp::Resume => "resume",
            DeviceOp::Stop => "stop",
        }
    }
}

impl From<ControlOp> for DeviceOp {
    fn from(op: ControlOp) -> Self {
        match op {
            ControlOp::Pause => DeviceOp::Pause,
            ControlOp::Resume => DeviceOp::Resume,
            ControlOp::Stop => DeviceOp::Stop,
        }
    }
}

/// One line from a controller. Each line has the device's `sequence`, which
/// only rises, and its monotonic `clockMs`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControllerEvent {
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
    pub fn stamp(&self) -> (u64, u64) {
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
