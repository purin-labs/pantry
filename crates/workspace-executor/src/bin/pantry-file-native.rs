use std::{
    env,
    io::{self, Write},
    path::Path,
    process::ExitCode,
};

use serde::Serialize;
use workspace_executor::contracts::WorkspaceRevision;
use workspace_executor::file_native::ProductFolderV1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductFolderInspection<'a> {
    semantic_hash: String,
    workspace: &'a ProductFolderV1,
    catalog_product: workspace_executor::file_native::ProductDocumentV1,
}

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Vec<String>) -> Result<(), String> {
    match arguments.as_slice() {
        [command, folder] if command == "inspect" => inspect(Path::new(folder)),
        [command, source, destination] if command == "normalize" => {
            normalize(Path::new(source), Path::new(destination))
        }
        [command, before, after] if command == "diff" => {
            diff(Path::new(before), Path::new(after))
        }
        [command, base_revision, before, after] if command == "changeset" => changeset(
            base_revision,
            Path::new(before),
            Path::new(after),
        ),
        [command, base_revision, before, after, claimed] if command == "validate-candidate" => {
            validate_candidate(
                base_revision,
                Path::new(before),
                Path::new(after),
                Path::new(claimed),
            )
        }
        _ => Err(
            "usage: satyr-file-native inspect <folder> | normalize <source> <destination> | diff <before> <after> | changeset <base-revision> <before> <after> | validate-candidate <base-revision> <before> <after> <claimed-json>"
                .to_string(),
        ),
    }
}

fn inspect(folder: &Path) -> Result<(), String> {
    let workspace = parse(folder)?;
    write_json(&ProductFolderInspection {
        semantic_hash: workspace.semantic_hash().map_err(debug_error)?,
        catalog_product: workspace.to_catalog_product(),
        workspace: &workspace,
    })
}

fn normalize(source: &Path, destination: &Path) -> Result<(), String> {
    let workspace = parse(source)?;
    workspace.render(destination).map_err(debug_error)?;
    inspect(destination)
}

fn diff(before: &Path, after: &Path) -> Result<(), String> {
    let before = parse(before)?;
    let after = parse(after)?;
    write_json(&before.semantic_diff(&after).map_err(debug_error)?)
}

fn changeset(base_revision: &str, before: &Path, after: &Path) -> Result<(), String> {
    let base_revision = WorkspaceRevision::parse(base_revision).map_err(debug_error)?;
    let before = parse(before)?;
    let after = parse(after)?;
    write_json(
        &before
            .validated_changeset(&after, base_revision)
            .map_err(debug_error)?,
    )
}

fn validate_candidate(
    base_revision: &str,
    before: &Path,
    after: &Path,
    claimed_path: &Path,
) -> Result<(), String> {
    const MAX_CANDIDATE_BYTES: u64 = 64 * 1024;
    let metadata = std::fs::metadata(claimed_path).map_err(debug_error)?;
    if !metadata.is_file() || metadata.len() > MAX_CANDIDATE_BYTES {
        return Err("invalid changeset candidate file".to_string());
    }
    let claimed_bytes = std::fs::read(claimed_path).map_err(debug_error)?;
    let claimed = serde_json::from_slice(&claimed_bytes).map_err(debug_error)?;
    let base_revision = WorkspaceRevision::parse(base_revision).map_err(debug_error)?;
    let before = parse(before)?;
    let after = parse(after)?;
    let validated = before
        .validate_changeset_candidate(&after, base_revision, &claimed)
        .map_err(debug_error)?;
    write_json(&validated)
}

fn parse(folder: &Path) -> Result<ProductFolderV1, String> {
    ProductFolderV1::parse(folder).map_err(debug_error)
}

fn write_json(value: &impl Serialize) -> Result<(), String> {
    let output = serde_json::to_vec_pretty(value).map_err(debug_error)?;
    io::stdout().write_all(&output).map_err(debug_error)?;
    io::stdout().write_all(b"\n").map_err(debug_error)
}

fn debug_error(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}
