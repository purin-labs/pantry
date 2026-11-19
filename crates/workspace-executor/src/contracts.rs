//! Executor-local copies of the contract values that the workspace executor
//! admits and returns.
//!
//! The executor is a separate container with its own boundary, so it owns these
//! definitions instead of depending on the Pantry or Underclerk Rust contract
//! crates. The serde shape and the validation rules match the TypeScript
//! contracts in `packages/contracts/src` and `packages/commerce-contracts/src`;
//! the wire schemas in `packages/contracts/src/workspace-executor.ts` are the
//! source of truth for the request and response envelopes.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

// ---------------------------------------------------------------------------
// Actor identities
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorContractError {
    InvalidIdentity { field: String },
}

macro_rules! actor_identity {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, ActorContractError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 256
                    || value != value.trim()
                    || value.chars().any(char::is_control)
                {
                    return Err(ActorContractError::InvalidIdentity {
                        field: stringify!($name).to_string(),
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

actor_identity!(SessionId);
actor_identity!(TurnId);

// ---------------------------------------------------------------------------
// Bounded identities
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    InvalidIdentity { field: String },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentityError> {
        let value = value.into();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(IdentityError::InvalidIdentity {
                field: "Sha256Digest".to_string(),
            });
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ---------------------------------------------------------------------------
// Commerce values
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommerceValidationError {
    InvalidIdentity { field: String },
}

macro_rules! string_identity {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, CommerceValidationError> {
                let value = value.into();
                if value.trim().is_empty() || value != value.trim() {
                    return Err(CommerceValidationError::InvalidIdentity {
                        field: stringify!($name).to_string(),
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn validate(&self) -> Result<(), CommerceValidationError> {
                Self::new(self.0.clone()).map(|_| ())
            }
        }
    };
}

string_identity!(OrganisationId);

// ---------------------------------------------------------------------------
// Message attachment preparation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageContractError {
    InvalidIdentity { field: String },
}

/// A content-addressed attachment identity minted at admission.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct AttachmentId(String);

impl AttachmentId {
    pub const PREFIX: &'static str = "att_";

    pub fn parse(value: impl Into<String>) -> Result<Self, MessageContractError> {
        let value = value.into();
        let Some(body) = value.strip_prefix(Self::PREFIX) else {
            return Err(Self::invalid());
        };

        if body.is_empty()
            || body.len() > 64
            || !body
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        {
            return Err(Self::invalid());
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn invalid() -> MessageContractError {
        MessageContractError::InvalidIdentity {
            field: "AttachmentId".to_string(),
        }
    }
}

/// A preparation identity or limit could not be admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageAttachmentPreparationError {
    InvalidIdentity { field: String },
    InvalidDigest { field: String },
    InvalidHandlerRevision,
    InvalidLimit { field: String },
}

impl MessageAttachmentPreparationError {
    fn reason(&self) -> String {
        match self {
            Self::InvalidIdentity { field } => format!("invalid identity: {field}"),
            Self::InvalidDigest { field } => format!("invalid digest: {field}"),
            Self::InvalidHandlerRevision => "handler revision is empty or unsafe".to_string(),
            Self::InvalidLimit { field } => format!("limit must be positive: {field}"),
        }
    }
}

impl fmt::Display for MessageAttachmentPreparationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason())
    }
}

/// The immutable input identity for one attachment preparation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentPreparationIdentity {
    organisation_id: OrganisationId,
    session_id: SessionId,
    turn_id: TurnId,
    attachment_id: AttachmentId,
    source_sha256: Sha256Digest,
    handler_revision: String,
}

impl MessageAttachmentPreparationIdentity {
    pub fn new(
        organisation_id: OrganisationId,
        session_id: SessionId,
        turn_id: TurnId,
        attachment_id: AttachmentId,
        source_sha256: Sha256Digest,
        handler_revision: impl Into<String>,
    ) -> Result<Self, MessageAttachmentPreparationError> {
        let handler_revision = handler_revision.into();
        if handler_revision.trim().is_empty()
            || handler_revision != handler_revision.trim()
            || handler_revision.len() > 256
            || handler_revision.chars().any(char::is_control)
        {
            return Err(MessageAttachmentPreparationError::InvalidHandlerRevision);
        }

        if organisation_id.as_str().contains('/')
            || organisation_id.as_str().chars().any(char::is_control)
        {
            return Err(MessageAttachmentPreparationError::InvalidIdentity {
                field: "organisationId".to_string(),
            });
        }

        Ok(Self {
            organisation_id,
            session_id,
            turn_id,
            attachment_id,
            source_sha256,
            handler_revision,
        })
    }

    pub fn organisation_id(&self) -> &OrganisationId {
        &self.organisation_id
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }

    pub fn attachment_id(&self) -> &AttachmentId {
        &self.attachment_id
    }

    pub fn source_sha256(&self) -> &Sha256Digest {
        &self.source_sha256
    }

    pub fn handler_revision(&self) -> &str {
        &self.handler_revision
    }
}

/// Limits admitted for one preparation operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentPreparationLimits {
    max_input_bytes: u64,
    max_output_bytes: u64,
    max_duration_ms: u64,
    max_frames: u64,
}

impl MessageAttachmentPreparationLimits {
    pub fn new(
        max_input_bytes: u64,
        max_output_bytes: u64,
        max_duration_ms: u64,
        max_frames: u64,
    ) -> Result<Self, MessageAttachmentPreparationError> {
        let values = [
            ("maxInputBytes", max_input_bytes),
            ("maxOutputBytes", max_output_bytes),
            ("maxDurationMs", max_duration_ms),
            ("maxFrames", max_frames),
        ];
        if let Some((field, _)) = values.into_iter().find(|(_, value)| *value == 0) {
            return Err(MessageAttachmentPreparationError::InvalidLimit {
                field: field.to_string(),
            });
        }

        Ok(Self {
            max_input_bytes,
            max_output_bytes,
            max_duration_ms,
            max_frames,
        })
    }

    pub fn max_input_bytes(&self) -> u64 {
        self.max_input_bytes
    }

    pub fn max_output_bytes(&self) -> u64 {
        self.max_output_bytes
    }

    pub fn max_duration_ms(&self) -> u64 {
        self.max_duration_ms
    }

    pub fn max_frames(&self) -> u64 {
        self.max_frames
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawIdentity {
    organisation_id: String,
    session_id: String,
    turn_id: String,
    attachment_id: String,
    source_sha256: String,
    handler_revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawLimits {
    max_input_bytes: u64,
    max_output_bytes: u64,
    max_duration_ms: u64,
    max_frames: u64,
}

impl TryFrom<RawIdentity> for MessageAttachmentPreparationIdentity {
    type Error = MessageAttachmentPreparationError;

    fn try_from(raw: RawIdentity) -> Result<Self, Self::Error> {
        let organisation_id = OrganisationId::new(raw.organisation_id).map_err(|_| {
            MessageAttachmentPreparationError::InvalidIdentity {
                field: "organisationId".to_string(),
            }
        })?;
        let session_id = SessionId::parse(raw.session_id).map_err(|_| {
            MessageAttachmentPreparationError::InvalidIdentity {
                field: "sessionId".to_string(),
            }
        })?;
        let turn_id = TurnId::parse(raw.turn_id).map_err(|_| {
            MessageAttachmentPreparationError::InvalidIdentity {
                field: "turnId".to_string(),
            }
        })?;
        let attachment_id = AttachmentId::parse(raw.attachment_id).map_err(|_| {
            MessageAttachmentPreparationError::InvalidIdentity {
                field: "attachmentId".to_string(),
            }
        })?;
        let source_sha256 = Sha256Digest::parse(raw.source_sha256).map_err(|_| {
            MessageAttachmentPreparationError::InvalidDigest {
                field: "sourceSha256".to_string(),
            }
        })?;
        Self::new(
            organisation_id,
            session_id,
            turn_id,
            attachment_id,
            source_sha256,
            raw.handler_revision,
        )
    }
}

impl TryFrom<RawLimits> for MessageAttachmentPreparationLimits {
    type Error = MessageAttachmentPreparationError;

    fn try_from(raw: RawLimits) -> Result<Self, Self::Error> {
        Self::new(
            raw.max_input_bytes,
            raw.max_output_bytes,
            raw.max_duration_ms,
            raw.max_frames,
        )
    }
}

impl<'de> Deserialize<'de> for MessageAttachmentPreparationIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        RawIdentity::deserialize(deserializer)
            .and_then(|raw| raw.try_into().map_err(serde::de::Error::custom))
    }
}

impl<'de> Deserialize<'de> for MessageAttachmentPreparationLimits {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        RawLimits::deserialize(deserializer)
            .and_then(|raw| raw.try_into().map_err(serde::de::Error::custom))
    }
}
