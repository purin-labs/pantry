//! The replies of the two station cells (espresso and pour-over), as typed
//! structures. The TypeScript contract is `station-replies.ts` in
//! `@satyr/production-simulation`.
//!
//! A station reply crosses the host with its object keys in sorted order,
//! as the earlier untyped replies did, and the digest of a recording is the
//! SHA-256 of that sorted JSON without its `digest` key. The host serializes
//! a reply with `sorted`.
use anyhow::Result;
use serde::{Serialize, Serializer};

use crate::artifact::{ExecutionIdentity, digest};
use crate::cell::Slot;
use crate::host::{CheckpointRef, Executing, Stopped};

/// Serializes `value` with every object's keys in sorted order.
pub fn sorted<T: Serialize, S: Serializer>(value: &T, serializer: S) -> Result<S::Ok, S::Error> {
    serde_json::to_value(value)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}

/// A checkpoint reference of sealed station content.
pub fn reference(content: &str, step: usize) -> CheckpointRef {
    CheckpointRef {
        digest: digest(content.as_bytes()),
        byte_length: content.len(),
        step,
    }
}

/// What every station recording names: its world, its build and the two
/// checkpoints it lies between.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub schema_version: u8,
    pub kind: &'static str,
    pub cell_id: String,
    pub run_id: String,
    pub model_hash: String,
    pub runner_sha256: String,
    pub runtime_sha256: String,
    pub predecessor: String,
    pub checkpoint: String,
}

impl Header {
    pub fn new(
        kind: &'static str,
        cell_id: &str,
        run_id: &str,
        model_hash: &str,
        predecessor: String,
        checkpoint: String,
    ) -> Self {
        let (ExecutionIdentity::Native {
            controller_hash,
            runtime_hash,
            ..
        }
        | ExecutionIdentity::Browser {
            controller_hash,
            runtime_hash,
            ..
        }) = ExecutionIdentity::current();
        Self {
            schema_version: 1,
            kind,
            cell_id: cell_id.to_owned(),
            run_id: run_id.to_owned(),
            model_hash: model_hash.to_owned(),
            runner_sha256: controller_hash,
            runtime_sha256: runtime_hash,
            predecessor,
            checkpoint,
        }
    }
}

/// An operation segment with its digest: the SHA-256 of the segment's
/// sorted JSON without the `digest` key.
#[derive(Serialize)]
pub struct Digested<T> {
    #[serde(flatten)]
    pub content: T,
    pub digest: String,
}

impl<T: Serialize> Digested<T> {
    pub fn new(content: T) -> Result<Self> {
        let digest = digest(serde_json::to_string(&serde_json::to_value(&content)?)?.as_bytes());
        Ok(Self { content, digest })
    }
}

/// The reply of a station cell to one command. `Segment` is an operation's
/// recording, `Recording` an idle one, `Outcome` an operation's end and
/// `Sample` an observation.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Reply<Segment, Recording, Outcome, Sample> {
    Opened {
        checkpoint: CheckpointRef,
        slot: Slot,
        operation: Option<Executing>,
    },
    Started {
        attempt_id: String,
        plan: &'static [&'static str],
    },
    /// An operation advanced. `outcome` is null until it ends.
    #[serde(rename = "advanced")]
    Advanced {
        stop: Stopped,
        segment: Segment,
        checkpoint: CheckpointRef,
        outcome: Option<Outcome>,
        /// A station offers no hold: always null.
        hold: (),
    },
    /// An idle station advanced.
    #[serde(rename = "advanced")]
    Rested {
        stop: Stopped,
        recording: Recording,
        checkpoint: CheckpointRef,
        hold: (),
    },
    Observed {
        model_hash: String,
        sample: Sample,
        #[serde(skip_serializing_if = "Option::is_none")]
        grinder_sample: Option<crate::appliance_run::Sample>,
    },
    Exported {
        content: String,
        checkpoint: CheckpointRef,
        sequence: usize,
    },
    Disposed,
}

/// The slot of a station: it admits no carrier.
pub fn no_carrier() -> Slot {
    Slot::Inactive { generation: 0 }
}
