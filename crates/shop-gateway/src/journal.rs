//! The local journal files of the device adapters and their configuration
//! files. Each one is one JSON value in the gateway's folder.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// A closed request keeps its record for this long, longer than any socket drop.
pub const JOURNAL_DAYS: u64 = 7;

/// The value in `path`, or the default when the file does not exist.
pub fn load<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

/// Writes a new file and renames it, so a power cut leaves one whole journal.
pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let next = path.with_extension("json.next");
    fs::write(&next, body).map_err(|error| format!("{}: {error}", next.display()))?;
    fs::rename(&next, path).map_err(|error| format!("{}: {error}", path.display()))
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The oldest time that a closed record may have and stay.
pub fn oldest_kept() -> u64 {
    now_seconds().saturating_sub(JOURNAL_DAYS * 24 * 60 * 60)
}
