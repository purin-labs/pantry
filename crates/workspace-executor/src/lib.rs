use std::{
    fs,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub mod contracts;
pub mod file_native;

use crate::contracts::{
    EffectReceiptId, ExecutionId, MessageAttachmentPreparationIdentity,
    MessageAttachmentPreparationLimits, Sha256Digest, WorkspaceRevision,
};
use crate::file_native::ProductFolderV1;
use serde::{Deserialize, Serialize};
use tempfile::TempDir;

pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// The ceiling for an attachment carried in the binary envelope.
///
/// Deliberately far below the ingestion limit. Ingestion stores whatever the
/// organisation sent; inspection reads it here under this container's memory, so the
/// two limits answer different questions and must not be conflated.
pub const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
/// The envelope's fixed header: an 8-byte big-endian JSON length.
pub const ENVELOPE_HEADER_BYTES: usize = 8;
const MAX_DEADLINE_AHEAD: Duration = Duration::from_secs(10 * 60);

mod wire;
use wire::{
    AttachmentInspectionLimit, AttachmentMediaClassWire, DecodedVideoFrame, ProductFolderFilesWire,
    ProductFolderReplacementOverlay, WorkspaceExecutorInspectionOperation,
    WorkspaceExecutorOperationWire, WorkspaceExecutorPreparationOperationWire,
    WorkspaceExecutorPreparationRequestWire, WorkspaceExecutorProductResult,
    WorkspaceFileReplacement,
};
pub use wire::{
    PREPARATION_REQUEST_SCHEMA_VERSION, REQUEST_SCHEMA_VERSION, RESPONSE_SCHEMA_VERSION,
    WorkspaceExecutorPreparationResponse, WorkspaceExecutorRequestWire, WorkspaceExecutorResponse,
};

#[derive(Debug, Deserialize)]
enum RequestWire {
    Product(WorkspaceExecutorRequestWire),
    Preparation(WorkspaceExecutorPreparationRequestWire),
}

#[derive(Debug)]
struct ValidatedProductRequest {
    execution_id: ExecutionId,
    execution_receipt_id: EffectReceiptId,
    base_revision: WorkspaceRevision,
    base_canonical_head: Sha256Digest,
    base_manifest_digest: Sha256Digest,
    operation: ValidatedProductOperation,
}

#[derive(Debug)]
struct ValidatedPreparationRequest {
    preparation_id: String,
    identity: MessageAttachmentPreparationIdentity,
    limits: MessageAttachmentPreparationLimits,
    deadline_at: SystemTime,
    operation: ValidatedPreparationOperation,
}

#[derive(Debug)]
enum ValidatedRequest {
    Product(ValidatedProductRequest),
    Preparation(ValidatedPreparationRequest),
}

#[derive(Debug)]
enum ValidatedPreparationOperation {
    PrepareMessageAttachment {
        media_class: AttachmentMediaClassWire,
        media_type: String,
        byte_length: u64,
        max_text_chars: u32,
    },
}

#[derive(Debug)]
enum ValidatedProductOperation {
    ProductFolderCandidate {
        product_root: String,
        workspace_yaml: String,
        base: ProductFolderFilesWire,
        candidate: ProductFolderFilesWire,
        claimed_changeset: serde_json::Value,
    },
}

/// The largest picture this executor will decode. A decoder allocates the full
/// frame, so an unbounded dimension is an unbounded allocation driven by an
/// untrusted header.
const MAX_DECODE_PIXELS: usize = 1920 * 1080;
/// Total JPEG bytes across every frame in one response. The response itself is
/// capped by the caller, so frames beyond this are counted, not sent.
const MAX_FRAME_RESPONSE_BYTES: usize = 640 * 1024;
const FRAME_JPEG_QUALITY: u8 = 75;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceExecutorErrorCode {
    InvalidRequest,
    DeadlineExpired,
    DeadlineTooFarAhead,
    InputTooLarge,
    /// The received bytes did not hash to the digest the request named.
    AttachmentDigestMismatch,
    InvalidProductRoot,
    InvalidProductFolder,
    InvalidChangesetCandidate,
    InternalFailure,
}

#[derive(Debug)]
pub struct WorkspaceExecutorError {
    code: WorkspaceExecutorErrorCode,
    message: &'static str,
}

impl WorkspaceExecutorError {
    pub fn code(&self) -> WorkspaceExecutorErrorCode {
        self.code
    }

    pub fn message(&self) -> &'static str {
        self.message
    }
}

/// Executes a request whose attachment bytes travel beside its JSON.
///
/// The envelope is an 8-byte big-endian JSON length, the JSON request, then the
/// raw attachment bytes. Keeping the bytes out of the JSON is what makes this
/// path viable at all: base64 inside a JSON document inflates by a third and
/// forces both sides to hold the whole thing as a string.
///
/// The digest in the request is checked against the bytes actually received
/// before anything parses them, so a truncated transfer fails as a mismatch
/// rather than as a malformed document.
pub fn execute_envelope(
    envelope: &[u8],
    now: SystemTime,
) -> Result<WorkspaceExecutorPreparationResponse, WorkspaceExecutorError> {
    let (request_bytes, attachment_bytes) = split_envelope(envelope)?;
    let request = validate_request(decode_request_wire(request_bytes)?, now)?;
    let started = Instant::now();

    let ValidatedRequest::Preparation(request) = request else {
        return Err(error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "the binary envelope carries attachment inspection only",
        ));
    };

    let ValidatedPreparationOperation::PrepareMessageAttachment {
        media_class,
        media_type,
        byte_length,
        max_text_chars,
    } = &request.operation;

    if attachment_bytes.len() > MAX_ATTACHMENT_BYTES
        || attachment_bytes.len() as u64 > request.limits.max_input_bytes()
    {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "attachment exceeds the executor byte limit",
        ));
    }

    if attachment_bytes.len() as u64 != *byte_length {
        return Err(error(
            WorkspaceExecutorErrorCode::AttachmentDigestMismatch,
            "attachment length does not match the request",
        ));
    }

    if digest_hex(attachment_bytes) != request.identity.source_sha256().as_str() {
        return Err(error(
            WorkspaceExecutorErrorCode::AttachmentDigestMismatch,
            "attachment bytes do not match the digest the request named",
        ));
    }

    let operation = inspect_attachment(
        request.identity.attachment_id().as_str(),
        *media_class,
        media_type,
        attachment_bytes,
        *max_text_chars,
        request.identity.source_sha256(),
        request.limits.max_frames(),
    );
    let output_bytes = serde_json::to_vec(&operation)
        .map(|bytes| bytes.len() as u64)
        .unwrap_or_default();
    let elapsed = started.elapsed();
    let completed_at = now
        .checked_add(elapsed)
        .ok_or_else(|| internal_error("preparation completion time overflowed"))?;
    let duration_ms = elapsed.as_millis() as u64;

    if output_bytes > request.limits.max_output_bytes() {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "attachment result exceeds the preparation output limit",
        ));
    }
    if duration_ms > request.limits.max_duration_ms() {
        return Err(error(
            WorkspaceExecutorErrorCode::DeadlineExpired,
            "attachment preparation exceeded its duration limit",
        ));
    }
    if completed_at > request.deadline_at {
        return Err(error(
            WorkspaceExecutorErrorCode::DeadlineExpired,
            "attachment preparation completed after its deadline",
        ));
    }

    Ok(WorkspaceExecutorPreparationResponse {
        schema_version: RESPONSE_SCHEMA_VERSION.to_owned(),
        preparation_id: request.preparation_id,
        identity: request.identity,
        operation,
        input_bytes: attachment_bytes.len() as u64,
        output_bytes,
        duration_ms,
    })
}

fn split_envelope(envelope: &[u8]) -> Result<(&[u8], &[u8]), WorkspaceExecutorError> {
    let header = envelope.get(..ENVELOPE_HEADER_BYTES).ok_or_else(|| {
        error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "envelope is shorter than its header",
        )
    })?;
    let json_len = u64::from_be_bytes(header.try_into().expect("header is eight bytes")) as usize;
    let body = &envelope[ENVELOPE_HEADER_BYTES..];
    let request_bytes = body.get(..json_len).ok_or_else(|| {
        error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "envelope declares more JSON than it carries",
        )
    })?;

    if json_len > MAX_REQUEST_BYTES {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "workspace executor request exceeds the byte limit",
        ));
    }

    Ok((request_bytes, &body[json_len..]))
}

/// Reads what this build can read, and names the limit when it cannot.
fn inspect_attachment(
    attachment_id: &str,
    media_class: AttachmentMediaClassWire,
    media_type: &str,
    bytes: &[u8],
    max_text_chars: u32,
    sha256: &Sha256Digest,
    max_frames: u64,
) -> WorkspaceExecutorInspectionOperation {
    let unreadable = |reason| WorkspaceExecutorInspectionOperation::AttachmentNotInspectable {
        attachment_id: attachment_id.to_string(),
        reason,
        source_sha256: sha256.as_str().to_string(),
    };

    match media_class {
        // Audio and opaque files have no reader here. Their facts come from
        // the Worker-side header inspection, which needs no container.
        AttachmentMediaClassWire::Audio | AttachmentMediaClassWire::Opaque => {
            unreadable(AttachmentInspectionLimit::HandlerUnavailable)
        }
        AttachmentMediaClassWire::Video => {
            decode_video_frames(attachment_id, bytes, sha256, max_frames)
        }
        AttachmentMediaClassWire::Document => {
            if !is_plain_text_media_type(media_type) {
                return unreadable(AttachmentInspectionLimit::HandlerUnavailable);
            }

            match std::str::from_utf8(bytes) {
                Ok(text) => {
                    let limit = max_text_chars as usize;
                    let taken: String = text.chars().take(limit).collect();
                    let truncated = taken.chars().count() < text.chars().count();

                    WorkspaceExecutorInspectionOperation::AttachmentText {
                        attachment_id: attachment_id.to_string(),
                        text: taken,
                        truncated,
                        source_sha256: sha256.as_str().to_string(),
                    }
                }
                Err(_) => unreadable(AttachmentInspectionLimit::FormatUnreadable),
            }
        }
    }
}

/// Decodes the keyframes the planner selected and returns them as JPEG.
///
/// Selection is the contracts crate's job and is deterministic; this only turns
/// the chosen packets into pixels. Each packet is decoded on a fresh decoder so
/// a malformed frame cannot poison the next, and the decoder's own bound on
/// picture size is checked before any allocation the header could inflate.
fn decode_video_frames(
    attachment_id: &str,
    bytes: &[u8],
    sha256: &Sha256Digest,
    max_frames: u64,
) -> WorkspaceExecutorInspectionOperation {
    use media_inspect::video_frames::{H264DecodePlan, MAX_SAMPLED_FRAMES, plan_h264_decode};

    let limit = |reason| WorkspaceExecutorInspectionOperation::AttachmentNotInspectable {
        attachment_id: attachment_id.to_string(),
        reason,
        source_sha256: sha256.as_str().to_string(),
    };

    let selection_limit = max_frames.min(MAX_SAMPLED_FRAMES as u64) as usize;
    let (policy_revision, packets, selected_timestamps_ms) =
        match plan_h264_decode(bytes, selection_limit) {
            H264DecodePlan::Ready {
                policy_revision,
                packets,
                selected_timestamps_ms,
            } => (policy_revision, packets, selected_timestamps_ms),
            H264DecodePlan::NotH264 { .. } => {
                return limit(AttachmentInspectionLimit::CodecUnsupported);
            }
            H264DecodePlan::ParameterSetsMissing
            | H264DecodePlan::NoVideoTrack
            | H264DecodePlan::ContainerUnreadable => {
                return limit(AttachmentInspectionLimit::FormatUnreadable);
            }
        };

    let mut frames = Vec::new();
    let mut omitted_frames = 0u32;
    let mut budget = MAX_FRAME_RESPONSE_BYTES;

    for packet in packets {
        let Some(decoded) = decode_one_keyframe(&packet.annex_b) else {
            continue;
        };

        match decoded {
            Err(reason) => return limit(reason),
            Ok((width, height, jpeg)) => {
                if jpeg.len() > budget {
                    omitted_frames += 1;
                    continue;
                }

                budget -= jpeg.len();
                frames.push(DecodedVideoFrame {
                    timestamp_ms: packet.timestamp_ms,
                    width,
                    height,
                    media_type: "image/jpeg".to_owned(),
                    sha256: digest_hex(&jpeg),
                    jpeg_base64: base64_encode(&jpeg),
                });
            }
        }
    }

    WorkspaceExecutorInspectionOperation::AttachmentVideoFrames {
        attachment_id: attachment_id.to_string(),
        policy_revision,
        selected_timestamps_ms,
        frames,
        omitted_frames,
        source_sha256: sha256.as_str().to_string(),
    }
}

/// One keyframe to one JPEG.
///
/// `None` means the decoder produced no picture for the packet, which happens
/// for a truncated slice; the frame is skipped and the rest still decode.
/// `Some(Err)` is a limit worth stopping on, such as a picture too large to
/// allocate.
fn decode_one_keyframe(
    annex_b: &[u8],
) -> Option<Result<(u32, u32, Vec<u8>), AttachmentInspectionLimit>> {
    use openh264::decoder::Decoder;

    let mut decoder = Decoder::new().ok()?;
    let picture = match decoder.decode(annex_b) {
        Ok(Some(picture)) => picture,
        Ok(None) => {
            // A single IDR may be held back until flush; drain it.
            let mut remaining = decoder.flush_remaining().ok()?;

            if remaining.is_empty() {
                return None;
            }

            let picture = remaining.remove(0);

            return Some(encode_jpeg(&picture));
        }
        Err(_) => return None,
    };

    Some(encode_jpeg(&picture))
}

fn encode_jpeg(
    picture: &openh264::decoder::DecodedYUV<'_>,
) -> Result<(u32, u32, Vec<u8>), AttachmentInspectionLimit> {
    use jpeg_encoder::{ColorType, Encoder};
    use openh264::formats::YUVSource;

    let (width, height) = picture.dimensions();

    if width == 0
        || height == 0
        || width.saturating_mul(height) > MAX_DECODE_PIXELS
        || width > u16::MAX as usize
        || height > u16::MAX as usize
    {
        return Err(AttachmentInspectionLimit::PictureTooLarge);
    }

    let mut rgb = vec![0u8; width * height * 3];

    picture.write_rgb8(&mut rgb);

    let mut jpeg = Vec::new();

    Encoder::new(&mut jpeg, FRAME_JPEG_QUALITY)
        .encode(&rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|_| AttachmentInspectionLimit::FormatUnreadable)?;

    Ok((width as u32, height as u32, jpeg))
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let buffer = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let triple = (buffer[0] as u32) << 16 | (buffer[1] as u32) << 8 | buffer[2] as u32;

        output.push(TABLE[(triple >> 18) as usize & 63] as char);
        output.push(TABLE[(triple >> 12) as usize & 63] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }

    output
}

fn is_plain_text_media_type(media_type: &str) -> bool {
    media_type.starts_with("text/") || matches!(media_type, "application/json" | "application/xml")
}

fn digest_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);

    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }

    hex
}

pub fn execute_json(
    request_bytes: &[u8],
    now: SystemTime,
) -> Result<WorkspaceExecutorResponse, WorkspaceExecutorError> {
    if request_bytes.len() > MAX_REQUEST_BYTES {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "workspace executor request exceeds the byte limit",
        ));
    }

    let request = validate_request(decode_request_wire(request_bytes)?, now)?;
    let ValidatedRequest::Product(request) = request else {
        return Err(error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "attachment preparation requires the binary envelope entry point",
        ));
    };
    let started = SystemTime::now();
    let operation = execute_operation(&request)?;
    let duration_ms = SystemTime::now()
        .duration_since(started)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let output_bytes = serde_json::to_vec(&operation)
        .map_err(internal_error)?
        .len()
        .try_into()
        .unwrap_or(u64::MAX);

    Ok(WorkspaceExecutorResponse {
        schema_version: RESPONSE_SCHEMA_VERSION.to_owned(),
        execution_id: request.execution_id.as_str().to_owned(),
        execution_receipt_id: request.execution_receipt_id.as_str().to_owned(),
        base_revision: request.base_revision.as_str().to_owned(),
        base_canonical_head: request.base_canonical_head.as_str().to_owned(),
        base_manifest_digest: request.base_manifest_digest.as_str().to_owned(),
        operation,
        input_bytes: request_bytes.len().try_into().unwrap_or(u64::MAX),
        output_bytes,
        duration_ms,
    })
}

fn decode_request_wire(request_bytes: &[u8]) -> Result<RequestWire, WorkspaceExecutorError> {
    let raw: serde_json::Value = serde_json::from_slice(request_bytes).map_err(|_| {
        error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "workspace executor request is invalid",
        )
    })?;
    let kind = raw
        .get("operation")
        .and_then(|operation| operation.get("kind"))
        .and_then(serde_json::Value::as_str);

    match kind {
        Some("product_folder_candidate") => {
            serde_json::from_value::<WorkspaceExecutorRequestWire>(raw)
                .map(RequestWire::Product)
                .map_err(|_| invalid_request(()))
        }
        Some("prepare_message_attachment") => {
            serde_json::from_value::<WorkspaceExecutorPreparationRequestWire>(raw)
                .map(RequestWire::Preparation)
                .map_err(|_| invalid_request(()))
        }
        _ => Err(invalid_request(())),
    }
}

fn validate_request(
    wire: RequestWire,
    now: SystemTime,
) -> Result<ValidatedRequest, WorkspaceExecutorError> {
    match wire {
        RequestWire::Product(wire) => validate_product_request(wire, now),
        RequestWire::Preparation(wire) => validate_preparation_request(wire, now),
    }
}

fn validate_product_request(
    wire: WorkspaceExecutorRequestWire,
    now: SystemTime,
) -> Result<ValidatedRequest, WorkspaceExecutorError> {
    if wire.schema_version != REQUEST_SCHEMA_VERSION {
        return Err(error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "workspace executor schema version is unsupported",
        ));
    }
    validate_deadline(wire.deadline_at_unix_ms, now)?;

    let WorkspaceExecutorOperationWire::ProductFolderCandidate {
        product_root,
        workspace_yaml,
        base,
        candidate,
        claimed_changeset,
    } = wire.operation;

    validate_product_root(&product_root)?;
    validate_file_size(&workspace_yaml)?;
    validate_file_size(&base.product_markdown)?;
    validate_file_size(&base.variants_yaml)?;
    validate_file_size(&candidate.product_markdown)?;
    validate_file_size(&candidate.variants_yaml)?;

    Ok(ValidatedRequest::Product(ValidatedProductRequest {
        execution_id: ExecutionId::parse(wire.execution_id).map_err(invalid_request)?,
        execution_receipt_id: EffectReceiptId::parse(wire.execution_receipt_id)
            .map_err(invalid_request)?,
        base_revision: WorkspaceRevision::parse(wire.base_revision).map_err(invalid_request)?,
        base_canonical_head: Sha256Digest::parse(wire.base_canonical_head)
            .map_err(invalid_request)?,
        base_manifest_digest: Sha256Digest::parse(wire.base_manifest_digest)
            .map_err(invalid_request)?,
        operation: ValidatedProductOperation::ProductFolderCandidate {
            product_root,
            workspace_yaml,
            base,
            candidate,
            claimed_changeset,
        },
    }))
}

fn validate_preparation_request(
    wire: WorkspaceExecutorPreparationRequestWire,
    now: SystemTime,
) -> Result<ValidatedRequest, WorkspaceExecutorError> {
    if wire.schema_version != PREPARATION_REQUEST_SCHEMA_VERSION {
        return Err(error(
            WorkspaceExecutorErrorCode::InvalidRequest,
            "workspace executor preparation schema version is unsupported",
        ));
    }
    let deadline_at = validate_preparation_deadline(
        wire.deadline_at_unix_ms,
        wire.limits.max_duration_ms(),
        now,
    )?;
    validate_opaque_identity(&wire.preparation_id)?;

    let WorkspaceExecutorPreparationOperationWire::PrepareMessageAttachment {
        media_class,
        media_type,
        byte_length,
        max_text_chars,
    } = wire.operation;
    validate_opaque_identity(&media_type)?;
    if byte_length > MAX_ATTACHMENT_BYTES as u64 || byte_length > wire.limits.max_input_bytes() {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "attachment exceeds the executor byte limit",
        ));
    }
    if max_text_chars as u64 > wire.limits.max_output_bytes() {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "attachment text limit exceeds the preparation output limit",
        ));
    }

    Ok(ValidatedRequest::Preparation(ValidatedPreparationRequest {
        preparation_id: wire.preparation_id,
        identity: wire.identity,
        limits: wire.limits,
        deadline_at,
        operation: ValidatedPreparationOperation::PrepareMessageAttachment {
            media_class,
            media_type,
            byte_length,
            max_text_chars,
        },
    }))
}

fn validate_deadline(
    deadline_at_unix_ms: u64,
    now: SystemTime,
) -> Result<(), WorkspaceExecutorError> {
    let deadline = UNIX_EPOCH
        .checked_add(Duration::from_millis(deadline_at_unix_ms))
        .ok_or_else(|| invalid_request(()))?;
    if deadline <= now {
        return Err(error(
            WorkspaceExecutorErrorCode::DeadlineExpired,
            "workspace executor deadline has expired",
        ));
    }
    if deadline.duration_since(now).unwrap_or_default() > MAX_DEADLINE_AHEAD {
        return Err(error(
            WorkspaceExecutorErrorCode::DeadlineTooFarAhead,
            "workspace executor deadline exceeds the maximum duration",
        ));
    }
    Ok(())
}

fn validate_preparation_deadline(
    deadline_at_unix_ms: u64,
    max_duration_ms: u64,
    now: SystemTime,
) -> Result<SystemTime, WorkspaceExecutorError> {
    validate_deadline(deadline_at_unix_ms, now)?;
    let deadline = UNIX_EPOCH
        .checked_add(Duration::from_millis(deadline_at_unix_ms))
        .ok_or_else(|| invalid_request(()))?;
    if deadline.duration_since(now).unwrap_or_default() > Duration::from_millis(max_duration_ms) {
        return Err(error(
            WorkspaceExecutorErrorCode::DeadlineTooFarAhead,
            "workspace executor preparation deadline exceeds its duration limit",
        ));
    }
    Ok(deadline)
}

fn validate_product_root(product_root: &str) -> Result<(), WorkspaceExecutorError> {
    let Some(product_id) = product_root.strip_prefix("products/") else {
        return Err(invalid_product_root());
    };
    if product_id.is_empty()
        || product_id.contains('/')
        || product_id.contains('\\')
        || product_id == "."
        || product_id == ".."
    {
        return Err(invalid_product_root());
    }
    Ok(())
}

fn validate_file_size(value: &str) -> Result<(), WorkspaceExecutorError> {
    if value.len() > MAX_FILE_BYTES {
        return Err(error(
            WorkspaceExecutorErrorCode::InputTooLarge,
            "workspace executor file exceeds the byte limit",
        ));
    }
    Ok(())
}

fn validate_opaque_identity(value: &str) -> Result<(), WorkspaceExecutorError> {
    if value.is_empty()
        || value.len() > 256
        || value != value.trim()
        || value.chars().any(char::is_control)
    {
        return Err(invalid_request(()));
    }
    Ok(())
}

fn execute_operation(
    request: &ValidatedProductRequest,
) -> Result<WorkspaceExecutorProductResult, WorkspaceExecutorError> {
    match &request.operation {
        ValidatedProductOperation::ProductFolderCandidate {
            product_root,
            workspace_yaml,
            base,
            candidate,
            claimed_changeset,
        } => execute_product_folder_candidate(
            request,
            product_root,
            workspace_yaml,
            base,
            candidate,
            claimed_changeset,
        ),
    }
}

fn execute_product_folder_candidate(
    request: &ValidatedProductRequest,
    product_root: &str,
    workspace_yaml: &str,
    base: &ProductFolderFilesWire,
    candidate: &ProductFolderFilesWire,
    claimed_changeset: &serde_json::Value,
) -> Result<WorkspaceExecutorProductResult, WorkspaceExecutorError> {
    let base_dir = TempDir::new().map_err(internal_error)?;
    let candidate_dir = TempDir::new().map_err(internal_error)?;
    write_product_folder(base_dir.path(), product_root, workspace_yaml, base)?;
    write_product_folder(
        candidate_dir.path(),
        product_root,
        workspace_yaml,
        candidate,
    )?;

    let before = ProductFolderV1::parse(base_dir.path()).map_err(|_| invalid_product_folder())?;
    let after =
        ProductFolderV1::parse(candidate_dir.path()).map_err(|_| invalid_product_folder())?;
    let expected_product_id = product_root
        .strip_prefix("products/")
        .ok_or_else(invalid_product_root)?;
    if before.product().product_id().as_str() != expected_product_id
        || after.product().product_id().as_str() != expected_product_id
    {
        return Err(invalid_product_root());
    }

    let validated_changeset = before
        .validate_changeset_candidate(&after, request.base_revision.clone(), claimed_changeset)
        .map_err(|_| {
            error(
                WorkspaceExecutorErrorCode::InvalidChangesetCandidate,
                "product-folder changeset candidate did not match the derived change",
            )
        })?;

    Ok(
        WorkspaceExecutorProductResult::ValidatedProductFolderChangeset {
            product_root: product_root.to_string(),
            replacement_overlay: ProductFolderReplacementOverlay {
                product_markdown: WorkspaceFileReplacement {
                    path: format!("{product_root}/product.md"),
                    utf8: candidate.product_markdown.clone(),
                },
                variants_yaml: WorkspaceFileReplacement {
                    path: format!("{product_root}/variants.yaml"),
                    utf8: candidate.variants_yaml.clone(),
                },
            },
            validated_changeset,
        },
    )
}

fn write_product_folder(
    root: &Path,
    product_root: &str,
    workspace_yaml: &str,
    files: &ProductFolderFilesWire,
) -> Result<(), WorkspaceExecutorError> {
    let product_dir = root.join(product_root);
    fs::create_dir_all(&product_dir).map_err(internal_error)?;
    fs::write(root.join("workspace.yaml"), workspace_yaml).map_err(internal_error)?;
    fs::write(product_dir.join("product.md"), &files.product_markdown).map_err(internal_error)?;
    fs::write(product_dir.join("variants.yaml"), &files.variants_yaml).map_err(internal_error)?;
    Ok(())
}

fn error(code: WorkspaceExecutorErrorCode, message: &'static str) -> WorkspaceExecutorError {
    WorkspaceExecutorError { code, message }
}

fn invalid_request(_: impl std::fmt::Debug) -> WorkspaceExecutorError {
    error(
        WorkspaceExecutorErrorCode::InvalidRequest,
        "workspace executor request is invalid",
    )
}

fn invalid_product_root() -> WorkspaceExecutorError {
    error(
        WorkspaceExecutorErrorCode::InvalidProductRoot,
        "product root is outside the authorized product-folder scope",
    )
}

fn invalid_product_folder() -> WorkspaceExecutorError {
    error(
        WorkspaceExecutorErrorCode::InvalidProductFolder,
        "product folder is invalid",
    )
}

fn internal_error(_: impl std::fmt::Debug) -> WorkspaceExecutorError {
    error(
        WorkspaceExecutorErrorCode::InternalFailure,
        "workspace executor failed internally",
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::SystemTime,
    };

    use serde_json::{Value, json};

    use super::{WorkspaceExecutorErrorCode, execute_json};

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/product-folder-v1")
    }

    fn fixture(path: &str) -> String {
        fs::read_to_string(fixture_root().join(path)).unwrap()
    }

    fn candidate_product() -> String {
        fixture("products/product_field_watch/product.md").replace("Field Watch", "Field Watch II")
    }

    fn claimed_changeset(candidate_product_markdown: &str) -> Value {
        let before_dir = tempfile::TempDir::new().unwrap();
        let after_dir = tempfile::TempDir::new().unwrap();
        write_fixture(
            before_dir.path(),
            &fixture("products/product_field_watch/product.md"),
        );
        write_fixture(after_dir.path(), candidate_product_markdown);
        let before = crate::file_native::ProductFolderV1::parse(before_dir.path()).unwrap();
        let after = crate::file_native::ProductFolderV1::parse(after_dir.path()).unwrap();
        serde_json::to_value(
            before
                .validated_changeset(
                    &after,
                    crate::contracts::WorkspaceRevision::parse("workspace_revision_42").unwrap(),
                )
                .unwrap(),
        )
        .unwrap()
    }

    fn write_fixture(root: &Path, product_markdown: &str) {
        let product = root.join("products/product_field_watch");
        fs::create_dir_all(&product).unwrap();
        fs::write(root.join("workspace.yaml"), fixture("workspace.yaml")).unwrap();
        fs::write(product.join("product.md"), product_markdown).unwrap();
        fs::write(
            product.join("variants.yaml"),
            fixture("products/product_field_watch/variants.yaml"),
        )
        .unwrap();
    }

    fn request(claimed: Value) -> Vec<u8> {
        let deadline = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        serde_json::to_vec(&json!({
            "schemaVersion": "workspace_executor_request.v1",
            "executionId": "execution_123",
            "executionReceiptId": "receipt-execution_123",
            "deadlineAtUnixMs": deadline,
            "baseRevision": "workspace_revision_42",
            "baseCanonicalHead": "8cf934c40388c5b902ee1fd48bd60aeb7eb21bbad135a362db30ae4dbb1e4f31",
            "baseManifestDigest": "7e58973e38c083cd0d7bf2762b44a952f39bbad0b321d7ac539bb9b5cd9fd9a0",
            "operation": {
                "kind": "product_folder_candidate",
                "productRoot": "products/product_field_watch",
                "workspaceYaml": fixture("workspace.yaml"),
                "base": {
                    "productMarkdown": fixture("products/product_field_watch/product.md"),
                    "variantsYaml": fixture("products/product_field_watch/variants.yaml")
                },
                "candidate": {
                    "productMarkdown": candidate_product(),
                    "variantsYaml": fixture("products/product_field_watch/variants.yaml")
                },
                "claimedChangeset": claimed
            }
        }))
        .unwrap()
    }

    #[test]
    fn validates_candidate_and_returns_only_the_product_overlay() {
        let candidate = candidate_product();
        let response =
            execute_json(&request(claimed_changeset(&candidate)), SystemTime::now()).unwrap();
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["schemaVersion"], "workspace_executor_response.v1");
        assert_eq!(value["baseManifestDigest"].as_str().unwrap().len(), 64);
        assert_eq!(
            value["operation"]["replacementOverlay"]["productMarkdown"]["path"],
            "products/product_field_watch/product.md"
        );
        assert_eq!(
            value["operation"]["replacementOverlay"]["variantsYaml"]["path"],
            "products/product_field_watch/variants.yaml"
        );
    }

    #[test]
    fn rejects_a_forged_changeset() {
        let error = execute_json(&request(json!({})), SystemTime::now()).unwrap_err();
        assert_eq!(
            error.code(),
            WorkspaceExecutorErrorCode::InvalidChangesetCandidate
        );
    }

    #[test]
    fn rejects_a_product_root_that_does_not_match_the_folder() {
        let candidate = candidate_product();
        let mut value: Value =
            serde_json::from_slice(&request(claimed_changeset(&candidate))).unwrap();
        value["operation"]["productRoot"] = json!("products/product_other");
        let error =
            execute_json(&serde_json::to_vec(&value).unwrap(), SystemTime::now()).unwrap_err();
        assert_eq!(
            error.code(),
            WorkspaceExecutorErrorCode::InvalidProductFolder
        );
    }
}

#[cfg(test)]
mod envelope_tests {
    use super::*;

    fn envelope(json: &str, attachment: &[u8]) -> Vec<u8> {
        let mut bytes = (json.len() as u64).to_be_bytes().to_vec();

        bytes.extend_from_slice(json.as_bytes());
        bytes.extend_from_slice(attachment);
        bytes
    }

    fn request_json(media_class: &str, media_type: &str, body: &[u8], max_chars: u32) -> String {
        format!(
            r#"{{"schemaVersion":"{PREPARATION_REQUEST_SCHEMA_VERSION}","preparationId":"preparation_1",
            "identity":{{"organisationId":"organisation_1","sessionId":"session_1","turnId":"turn_1",
            "attachmentId":"att_1","sourceSha256":"{digest}","handlerRevision":"handler.v1"}},
            "limits":{{"maxInputBytes":33554432,"maxOutputBytes":2097152,"maxDurationMs":30000,"maxFrames":4}},
            "deadlineAtUnixMs":{deadline},"operation":{{"kind":"prepare_message_attachment",
            "mediaClass":"{media_class}","mediaType":"{media_type}","byteLength":{length},
            "maxTextChars":{max_chars}}}}}"#,
            deadline = NOW_MS + 30_000,
            length = body.len(),
            digest = digest_hex(body)
        )
    }

    const NOW_MS: u64 = 1_700_000_000_000;

    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(NOW_MS)
    }

    #[test]
    fn reads_bounded_text_from_a_plain_document() {
        let body = b"espresso,3.50\nlatte,4.25\n";
        let response = execute_envelope(
            &envelope(&request_json("document", "text/csv", body, 1_000), body),
            now(),
        )
        .expect("envelope executes");
        let serialized = serde_json::to_value(&response).expect("response serializes");
        assert_eq!(serialized["preparationId"], "preparation_1");
        assert_eq!(serialized["identity"]["organisationId"], "organisation_1");
        assert_eq!(serialized["identity"]["sourceSha256"], digest_hex(body));
        assert_eq!(serialized["inputBytes"], body.len());
        assert!(serialized.get("executionId").is_none());

        match preparation_operation(response) {
            WorkspaceExecutorInspectionOperation::AttachmentText {
                text,
                truncated,
                source_sha256,
                ..
            } => {
                assert_eq!(text, "espresso,3.50\nlatte,4.25\n");
                assert!(!truncated);
                // The result names the bytes it came from.
                assert_eq!(source_sha256, digest_hex(body));
            }
            other => panic!("expected attachment text, got {other:?}"),
        }
    }

    #[test]
    fn truncates_at_the_requested_bound() {
        let body = b"abcdefghij";
        let response = execute_envelope(
            &envelope(&request_json("document", "text/plain", body, 4), body),
            now(),
        )
        .expect("envelope executes");

        match preparation_operation(response) {
            WorkspaceExecutorInspectionOperation::AttachmentText {
                text, truncated, ..
            } => {
                assert_eq!(text, "abcd");
                assert!(truncated);
            }
            other => panic!("expected attachment text, got {other:?}"),
        }
    }

    #[test]
    fn refuses_bytes_that_do_not_match_the_named_digest() {
        let declared = b"the bytes the request described";
        let delivered = b"different bytes of the same length";
        let json = request_json("document", "text/plain", declared, 1_000);

        // A truncated or swapped transfer must fail as a mismatch, before any
        // parser sees the body.
        let failure = execute_envelope(&envelope(&json, delivered), now())
            .expect_err("mismatched bytes are refused");

        assert_eq!(
            failure.code(),
            WorkspaceExecutorErrorCode::AttachmentDigestMismatch
        );
    }

    #[test]
    fn names_the_limit_for_a_class_with_no_reader() {
        // Video has a reader now, so it is exercised by its own tests below.
        for (class, media_type) in [("audio", "audio/wav"), ("opaque", "application/x-3ds")] {
            let body = b"\x00\x01\x02\x03";
            let response = execute_envelope(
                &envelope(&request_json(class, media_type, body, 100), body),
                now(),
            )
            .expect("envelope executes");

            match preparation_operation(response) {
                WorkspaceExecutorInspectionOperation::AttachmentNotInspectable {
                    reason, ..
                } => {
                    assert_eq!(reason, AttachmentInspectionLimit::HandlerUnavailable);
                }
                other => panic!("expected a stated limit for {class}, got {other:?}"),
            }
        }
    }

    #[test]
    fn names_the_limit_for_a_document_it_cannot_decode() {
        let body = &[0xff, 0xfe, 0xfd];
        let response = execute_envelope(
            &envelope(&request_json("document", "text/plain", body, 100), body),
            now(),
        )
        .expect("envelope executes");

        match preparation_operation(response) {
            WorkspaceExecutorInspectionOperation::AttachmentNotInspectable { reason, .. } => {
                assert_eq!(reason, AttachmentInspectionLimit::FormatUnreadable);
            }
            other => panic!("expected a stated limit, got {other:?}"),
        }
    }

    #[test]
    fn refuses_an_envelope_that_lies_about_its_json_length() {
        let body = b"x";
        let json = request_json("document", "text/plain", body, 10);
        let mut bytes = (json.len() as u64 + 4_096).to_be_bytes().to_vec();

        bytes.extend_from_slice(json.as_bytes());

        let failure = execute_envelope(&bytes, now()).expect_err("a short envelope is refused");

        assert_eq!(failure.code(), WorkspaceExecutorErrorCode::InvalidRequest);
    }

    #[test]
    fn refuses_an_attachment_beyond_the_executor_limit() {
        let body = vec![0u8; 16];
        let mut value: serde_json::Value =
            serde_json::from_str(&request_json("document", "text/plain", &body, 10)).unwrap();
        value["operation"]["byteLength"] = serde_json::json!(MAX_ATTACHMENT_BYTES as u64 + 1);
        let json = serde_json::to_string(&value).unwrap();

        // The declared size is refused before any byte is examined.
        let failure = execute_envelope(&envelope(&json, &body), now())
            .expect_err("an oversized attachment is refused");

        assert_eq!(failure.code(), WorkspaceExecutorErrorCode::InputTooLarge);
    }

    #[test]
    fn refuses_product_workspace_fields_in_a_preparation_request() {
        let body = b"x";
        let mut value: serde_json::Value =
            serde_json::from_str(&request_json("document", "text/plain", body, 10)).unwrap();
        value["executionId"] = serde_json::json!("execution_1");
        let json = serde_json::to_string(&value).unwrap();

        let failure = execute_envelope(&envelope(&json, body), now())
            .expect_err("product workspace fields are not part of preparation");

        assert_eq!(failure.code(), WorkspaceExecutorErrorCode::InvalidRequest);
    }

    #[test]
    fn refuses_a_preparation_deadline_beyond_its_declared_duration() {
        let body = b"x";
        let mut value: serde_json::Value =
            serde_json::from_str(&request_json("document", "text/plain", body, 10)).unwrap();
        value["deadlineAtUnixMs"] = serde_json::json!(NOW_MS + 30_001);
        let json = serde_json::to_string(&value).unwrap();

        let failure = execute_envelope(&envelope(&json, body), now())
            .expect_err("preparation deadline must fit its duration limit");

        assert_eq!(
            failure.code(),
            WorkspaceExecutorErrorCode::DeadlineTooFarAhead
        );
    }

    /// Four H.264 keyframes at 64x48 from ffmpeg. Real bytes: a decoder fed a
    /// hand-built container would prove nothing about pictures.
    const KEYFRAMES_H264: &[u8] = include_bytes!("../fixtures/keyframes-h264.mp4");

    #[test]
    fn decodes_h264_keyframes_to_jpeg_stills() {
        let body = KEYFRAMES_H264;
        let response = execute_envelope(
            &envelope(&request_json("video", "video/mp4", body, 0), body),
            now(),
        )
        .expect("envelope executes");

        let operation = preparation_operation(response);
        let WorkspaceExecutorInspectionOperation::AttachmentVideoFrames {
            frames,
            omitted_frames,
            selected_timestamps_ms,
            source_sha256,
            ..
        } = operation
        else {
            panic!("expected decoded frames, got {operation:?}");
        };

        assert_eq!(omitted_frames, 0);
        assert!(!frames.is_empty(), "no frames decoded");
        assert_eq!(frames.len(), selected_timestamps_ms.len().min(4));
        assert_eq!(source_sha256, digest_hex(body));

        for frame in &frames {
            assert_eq!((frame.width, frame.height), (64, 48));
            assert_eq!(frame.media_type, "image/jpeg");
            // The bytes really are a JPEG: SOI marker first, EOI last.
            let jpeg = base64_decode(&frame.jpeg_base64);
            assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
            assert_eq!(&jpeg[jpeg.len() - 2..], &[0xff, 0xd9]);
            assert_eq!(frame.sha256, digest_hex(&jpeg));
        }
    }

    #[test]
    fn decoding_is_deterministic_for_the_same_bytes() {
        let body = KEYFRAMES_H264;
        let json = request_json("video", "video/mp4", body, 0);
        let first = execute_envelope(&envelope(&json, body), now()).expect("first");
        let second = execute_envelope(&envelope(&json, body), now()).expect("second");

        let digests = |result: WorkspaceExecutorPreparationResponse| match result.operation {
            WorkspaceExecutorInspectionOperation::AttachmentVideoFrames { frames, .. } => frames
                .into_iter()
                .map(|frame| frame.sha256)
                .collect::<Vec<_>>(),
            other => panic!("expected frames, got {other:?}"),
        };

        assert_eq!(digests(first), digests(second));
    }

    #[test]
    fn a_video_the_decoder_cannot_read_states_the_limit() {
        // A valid envelope whose bytes are not a container at all.
        let body = b"not a video";
        let response = execute_envelope(
            &envelope(&request_json("video", "video/mp4", body, 0), body),
            now(),
        )
        .expect("envelope executes");

        match preparation_operation(response) {
            WorkspaceExecutorInspectionOperation::AttachmentNotInspectable { reason, .. } => {
                assert_eq!(reason, AttachmentInspectionLimit::FormatUnreadable);
            }
            other => panic!("expected a stated limit, got {other:?}"),
        }
    }

    fn base64_decode(text: &str) -> Vec<u8> {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let value = |c: u8| TABLE.iter().position(|t| *t == c).unwrap_or(0) as u32;
        let mut out = Vec::new();
        let bytes: Vec<u8> = text.bytes().filter(|b| *b != b'=').collect();

        for chunk in bytes.chunks(4) {
            let mut triple = 0u32;
            for (i, b) in chunk.iter().enumerate() {
                triple |= value(*b) << (18 - 6 * i);
            }
            out.push((triple >> 16) as u8);
            if chunk.len() > 2 {
                out.push((triple >> 8) as u8);
            }
            if chunk.len() > 3 {
                out.push(triple as u8);
            }
        }

        out
    }

    #[test]
    fn refuses_the_json_entry_point_for_attachment_inspection() {
        let body = b"x";
        let json = request_json("document", "text/plain", body, 10);

        // Bytes cannot arrive through the JSON path, so asking there is an
        // error rather than an empty inspection.
        let failure = execute_json(json.as_bytes(), now())
            .expect_err("json entry point refuses attachment inspection");

        assert_eq!(failure.code(), WorkspaceExecutorErrorCode::InvalidRequest);
    }

    fn preparation_operation(
        response: WorkspaceExecutorPreparationResponse,
    ) -> WorkspaceExecutorInspectionOperation {
        response.operation
    }
}
