//! One envelope for every checkpoint that the engine writes (Refactor 16,
//! step 6D): its schema, its kind, the engine that wrote it, the payload and
//! the SHA-256 of the payload. A cell's stored content and an appliance
//! continuation are envelopes.
//!
//! Only this engine reads its envelopes: `open` refuses another engine
//! identity. A checkpoint of an earlier shape is read by the retained bundle
//! that wrote it (Plan 70B), so this module has no reader for it.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::artifact::{ExecutionIdentity, digest};

/// The envelope schema.
pub const SCHEMA: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    RackCellCheckpoint,
    EspressoCellCheckpoint,
    PourOverCellCheckpoint,
    ApplianceCheckpoint,
}

/// A checkpoint as the engine writes and reads it. The payload stays JSON
/// until the envelope is opened, so that its digest is checked on the
/// values as they arrived.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub schema: u32,
    pub kind: Kind,
    pub engine: ExecutionIdentity,
    pub payload: Value,
    /// The SHA-256 of the payload's canonical JSON (`canonical`).
    pub sha256: String,
}

/// The payload's JSON with sorted keys and every number written as an f64,
/// with -0 as 0. A checkpoint that crosses JavaScript keeps this form:
/// `JSON.parse` and `JSON.stringify` may reorder keys and write `1.0` as `1`
/// and `-0` as `0`, but they keep every other value.
fn canonical(value: &Value, out: &mut Vec<u8>) -> Result<()> {
    match value {
        Value::Number(number) => {
            let value = number.as_f64().context("A checkpoint number is no f64")?;
            // JavaScript writes -0 as 0.
            let value = if value == 0. { 0. } else { value };
            serde_json::to_writer(&mut *out, &value)?;
        }
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                canonical(item, out)?;
            }
            out.push(b']');
        }
        // A serde_json map without `preserve_order` iterates sorted keys.
        Value::Object(fields) => {
            out.push(b'{');
            for (index, (key, item)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key)?;
                out.push(b':');
                canonical(item, out)?;
            }
            out.push(b'}');
        }
        other => serde_json::to_writer(&mut *out, other)?,
    }
    Ok(())
}

fn payload_digest(payload: &Value) -> Result<String> {
    let mut bytes = Vec::new();
    canonical(payload, &mut bytes)?;
    Ok(digest(&bytes))
}

impl Envelope {
    /// Seals `payload` as a checkpoint of this engine. The digest is taken
    /// on the payload as written, so an f32 keeps the value of its text.
    pub fn seal<T: Serialize>(kind: Kind, payload: &T) -> Result<Self> {
        let payload: Value = serde_json::from_str(&serde_json::to_string(payload)?)?;
        Ok(Self {
            schema: SCHEMA,
            kind,
            engine: ExecutionIdentity::current(),
            sha256: payload_digest(&payload)?,
            payload,
        })
    }

    /// The typed payload, when the envelope is of this schema, kind and
    /// engine and its digest holds.
    pub fn open<T: DeserializeOwned>(self, kind: Kind) -> Result<T> {
        ensure!(
            self.schema == SCHEMA && self.kind == kind,
            "The checkpoint is not a {kind:?} of envelope schema {SCHEMA}"
        );
        ensure!(
            self.engine == ExecutionIdentity::current(),
            "The checkpoint belongs to another engine build"
        );
        ensure!(
            payload_digest(&self.payload)? == self.sha256,
            "The checkpoint payload differs from its SHA-256"
        );
        Ok(serde_json::from_value(self.payload)?)
    }
}

/// The JSON of a sealed payload.
pub fn write<T: Serialize>(kind: Kind, payload: &T) -> Result<String> {
    Ok(serde_json::to_string(&Envelope::seal(kind, payload)?)?)
}

/// Reads stored JSON content of `kind` back to its payload.
pub fn read<T: DeserializeOwned>(kind: Kind, content: &[u8]) -> Result<T> {
    serde_json::from_slice::<Envelope>(content)?.open(kind)
}
