//! The lines of the simulator's control port, for people and journeys. The
//! device ports speak the controller protocol of the `cobot-protocol` crate.
use cobot_protocol::CobotTask;
use serde::{Deserialize, Serialize};

/// A fault that the control port injects.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fault {
    GripLost,
    DoorBlocked,
    ArmStop,
    Estop,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptMove {
    pub move_id: String,
    pub task: CobotTask,
    pub after_ms: u64,
}

/// One line on the control port.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PortOp {
    Inject {
        device: String,
        fault: Fault,
        #[serde(default)]
        at_progress: Option<f64>,
    },
    Clear {
        device: String,
    },
    Stale {
        device: String,
    },
    Freeze {
        device: String,
    },
    Script {
        device: String,
        moves: Vec<ScriptMove>,
    },
    State,
    Reset,
}
