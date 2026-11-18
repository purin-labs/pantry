// Generated from TypeScript JSON Schema. Run pnpm --filter @seams/contracts executor:generate.

pub const REQUEST_SCHEMA_VERSION: &str = "workspace_executor_request.v1";

pub const PREPARATION_REQUEST_SCHEMA_VERSION: &str = "workspace_executor_preparation.v1";

pub const RESPONSE_SCHEMA_VERSION: &str = "workspace_executor_response.v1";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExecutorRequestWire {
    pub schema_version: String,
    pub execution_id: String,
    pub execution_receipt_id: String,
    pub deadline_at_unix_ms: u64,
    pub base_revision: String,
    pub base_canonical_head: String,
    pub base_manifest_digest: String,
    pub operation: WorkspaceExecutorOperationWire,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceExecutorOperationWire {
    ProductFolderCandidate {
        product_root: String,
        workspace_yaml: String,
        base: ProductFolderFilesWire,
        candidate: ProductFolderFilesWire,
        claimed_changeset: ClaimedChangeset,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductFolderFilesWire {
    pub product_markdown: String,
    pub variants_yaml: String,
}

pub type ClaimedChangeset = serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExecutorPreparationRequestWire {
    pub schema_version: String,
    pub preparation_id: String,
    pub identity: PreparationIdentity,
    pub limits: PreparationLimits,
    pub deadline_at_unix_ms: u64,
    pub operation: WorkspaceExecutorPreparationOperationWire,
}

pub type PreparationIdentity = crate::contracts::MessageAttachmentPreparationIdentity;

pub type PreparationLimits = crate::contracts::MessageAttachmentPreparationLimits;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceExecutorPreparationOperationWire {
    PrepareMessageAttachment {
        media_class: AttachmentMediaClassWire,
        media_type: String,
        byte_length: u64,
        max_text_chars: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentMediaClassWire {
    Document,
    Audio,
    Video,
    Opaque,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExecutorResponse {
    pub schema_version: String,
    pub execution_id: String,
    pub execution_receipt_id: String,
    pub base_revision: String,
    pub base_canonical_head: String,
    pub base_manifest_digest: String,
    pub operation: WorkspaceExecutorProductResult,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceExecutorProductResult {
    ValidatedProductFolderChangeset {
        product_root: String,
        replacement_overlay: ProductFolderReplacementOverlay,
        validated_changeset: ValidatedChangeset,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductFolderReplacementOverlay {
    pub product_markdown: WorkspaceFileReplacement,
    pub variants_yaml: WorkspaceFileReplacement,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileReplacement {
    pub path: String,
    pub utf8: String,
}

pub type ValidatedChangeset = crate::file_native::ValidatedProductFolderChangesetV1;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExecutorPreparationResponse {
    pub schema_version: String,
    pub preparation_id: String,
    pub identity: PreparationIdentity,
    pub operation: WorkspaceExecutorInspectionOperation,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceExecutorInspectionOperation {
    AttachmentText {
        attachment_id: String,
        text: String,
        truncated: bool,
        source_sha256: String,
    },
    AttachmentVideoFrames {
        attachment_id: String,
        policy_revision: String,
        selected_timestamps_ms: Vec<u64>,
        frames: Vec<DecodedVideoFrame>,
        omitted_frames: u32,
        source_sha256: String,
    },
    AttachmentNotInspectable {
        attachment_id: String,
        reason: AttachmentInspectionLimit,
        source_sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecodedVideoFrame {
    pub timestamp_ms: u64,
    pub width: u32,
    pub height: u32,
    pub media_type: String,
    pub jpeg_base64: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentInspectionLimit {
    HandlerUnavailable,
    FormatUnreadable,
    CodecUnsupported,
    PictureTooLarge,
}
