//! Receipt printer and cash drawer adapter (Plan 90 Phase 5).
//!
//! Pantry sends a typed receipt layout. This module encodes it as StarPRNT for
//! a Star mC-Print3 (`MCP31LB`, 80 mm paper, 72 mm and 48 columns of print) and
//! sends it over the shop LAN. The drawer (`mJ-Drawer`) hangs on the printer's
//! DK port. The printer's LAN address stays in this computer's
//! `printers.json`; Pantry knows only the printer's source key.
//!
//! Each request has a `requestId`. The journal records the request before the
//! first byte goes to the printer, and records the outcome after. A request
//! that comes again, for example after a socket drop, gets the recorded
//! outcome: the printer never prints the same receipt twice and the drawer
//! never opens twice. A request that stopped between the two records answers
//! `result_unknown`, because nobody knows if the paper came out.
//!
//! Every byte command below comes from Star's "StarPRNT Command
//! Specifications" Rev. 4.20 (Star Micronics, 2023), whose "Applicable Models"
//! list names MCP31LB as mC-Print3 (1st Gen.):
//! <https://www.starasia.com/Download/Manual/starprnt_cm_en.pdf>. Rev. 2.25 at
//! <https://www.starmicronics.com/support/Mannualfolder/StarPRNT_cm_en.pdf>
//! shows the same commands. Section 5 "Command list for each model" marks each
//! one as supported on mC-Print3 (1st Gen.).

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::journal::{self, now_seconds};
use crate::str_field;

/// Characters on one line of 72 mm print in the standard font.
pub const COLUMNS: usize = 48;

/// The print port of a Star LAN printer. Rev. 4.20 §2.1 "Explanation of
/// Terms" (NSB) names it "the print port (TCP#9100)", and the mC-Print3 online
/// manual lists "TCP#9100/9101":
/// <https://star-m.jp/products/s_print/mcprint3/manual/en/settings/DNSsettings.htm>.
pub const STAR_PRINT_PORT: u16 = 9100;

/// ESC @ "Command initialization", Rev. 4.20 p. 103.
const INITIALIZE: &[u8] = &[0x1B, 0x40];
/// ESC GS ) U fn=48 m=1 "Select UTF Code": UTF-8 valid, Rev. 4.20 p. 127.
const UTF8_ON: &[u8] = &[0x1B, 0x1D, 0x29, 0x55, 0x02, 0x00, 0x30, 0x01];
/// ESC GS ) U fn=65 "Set the UTF-8 CJK Unified Ideograph font": Japanese
/// first, Rev. 4.20 p. 129. Kanji and kana print only with this font.
const JAPANESE_FONT_FIRST: &[u8] = &[
    0x1B, 0x1D, 0x29, 0x55, 0x05, 0x00, 0x41, 0x01, 0x00, 0x00, 0x00,
];
/// ESC E "Select emphasized printing", Rev. 4.20 p. 39.
const EMPHASIS_ON: &[u8] = &[0x1B, 0x45];
/// ESC F "Cancel emphasized printing", Rev. 4.20 p. 39.
const EMPHASIS_OFF: &[u8] = &[0x1B, 0x46];
/// ESC i n1 n2 "Set/cancel the double wide/high": n1 = 1 and n2 = 1 is twice
/// high and twice wide, 0 and 0 cancels, Rev. 4.20 p. 36.
const DOUBLE_ON: &[u8] = &[0x1B, 0x69, 0x01, 0x01];
const DOUBLE_OFF: &[u8] = &[0x1B, 0x69, 0x00, 0x00];
/// LF "Line feed", Rev. 4.20 §2.3.5 p. 46.
const LINE_FEED: u8 = 0x0A;
/// ESC d n "Auto-cutter" with n = 3: feed to the cut position, then partial
/// cut, Rev. 4.20 p. 52.
const FEED_AND_PARTIAL_CUT: &[u8] = &[0x1B, 0x64, 0x03];
/// BEL "External device 1 drive instruction": drives the DK port with the
/// pulse width that ESC BEL sets (default 200 ms), Rev. 4.20 p. 136-137.
const DRIVE_DRAWER: &[u8] = &[0x07];
/// ESC ACK SOH "Real-time printer status (ASB status)", Rev. 4.20 p. 106.
const REQUEST_STATUS: &[u8] = &[0x1B, 0x06, 0x01];

/// ESC GS a n "Specify position alignment", Rev. 4.20 p. 45.
fn alignment(align: Align) -> [u8; 4] {
    let n = match align {
        Align::Left => 0,
        Align::Center => 1,
        Align::Right => 2,
    };
    [0x1B, 0x1D, 0x61, n]
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Size {
    Normal,
    Double,
}

/// One line of the layout that `packages/control-api` defines.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReceiptLine {
    Text {
        text: String,
        align: Align,
        emphasis: bool,
        size: Size,
    },
    Columns {
        left: String,
        right: String,
        emphasis: bool,
    },
    Rule,
    Feed {
        lines: u8,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptLayout {
    pub columns: usize,
    pub lines: Vec<ReceiptLine>,
}

/// The StarPRNT bytes of one receipt, ending with a partial cut.
pub fn encode_receipt(layout: &ReceiptLayout) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(INITIALIZE);
    bytes.extend_from_slice(UTF8_ON);
    bytes.extend_from_slice(JAPANESE_FONT_FIRST);
    for line in &layout.lines {
        match line {
            ReceiptLine::Text {
                text,
                align,
                emphasis,
                size,
            } => {
                bytes.extend_from_slice(&alignment(*align));
                if *emphasis {
                    bytes.extend_from_slice(EMPHASIS_ON);
                }
                if *size == Size::Double {
                    bytes.extend_from_slice(DOUBLE_ON);
                }
                let limit = match size {
                    Size::Normal => COLUMNS,
                    Size::Double => COLUMNS / 2,
                };
                bytes.extend_from_slice(fit(text, limit).as_bytes());
                if *size == Size::Double {
                    bytes.extend_from_slice(DOUBLE_OFF);
                }
                if *emphasis {
                    bytes.extend_from_slice(EMPHASIS_OFF);
                }
                bytes.push(LINE_FEED);
            }
            ReceiptLine::Columns {
                left,
                right,
                emphasis,
            } => {
                bytes.extend_from_slice(&alignment(Align::Left));
                if *emphasis {
                    bytes.extend_from_slice(EMPHASIS_ON);
                }
                bytes.extend_from_slice(two_columns(left, right).as_bytes());
                if *emphasis {
                    bytes.extend_from_slice(EMPHASIS_OFF);
                }
                bytes.push(LINE_FEED);
            }
            ReceiptLine::Rule => {
                bytes.extend_from_slice(&alignment(Align::Left));
                bytes.extend_from_slice("-".repeat(COLUMNS).as_bytes());
                bytes.push(LINE_FEED);
            }
            ReceiptLine::Feed { lines } => {
                bytes.extend(std::iter::repeat_n(LINE_FEED, (*lines).clamp(1, 5).into()));
            }
        }
    }
    bytes.extend_from_slice(FEED_AND_PARTIAL_CUT);
    bytes
}

/// What the paper shows, as plain text of 48 columns. Text in double size
/// takes two columns for each column of its width.
pub fn render_receipt(layout: &ReceiptLayout) -> String {
    let mut out = String::new();
    for line in &layout.lines {
        match line {
            ReceiptLine::Text {
                text, align, size, ..
            } => {
                let (text, scale) = match size {
                    Size::Normal => (fit(text, COLUMNS), 1),
                    Size::Double => (fit(text, COLUMNS / 2), 2),
                };
                let free = COLUMNS.saturating_sub(width(&text) * scale);
                let pad = match align {
                    Align::Left => 0,
                    Align::Center => free / 2,
                    Align::Right => free,
                };
                let shown = if scale == 2 { spaced(&text) } else { text };
                out.push_str(&" ".repeat(pad));
                out.push_str(shown.trim_end());
            }
            ReceiptLine::Columns { left, right, .. } => {
                out.push_str(two_columns(left, right).trim_end())
            }
            ReceiptLine::Rule => out.push_str(&"-".repeat(COLUMNS)),
            ReceiptLine::Feed { lines } => {
                for _ in 1..(*lines).clamp(1, 5) {
                    out.push('\n');
                }
            }
        }
        out.push('\n');
    }
    out.push_str(&centered("- - - - cut - - - -"));
    out
}

fn centered(text: &str) -> String {
    format!(
        "{}{text}\n",
        " ".repeat(COLUMNS.saturating_sub(width(text)) / 2)
    )
}

/// A double-size letter fills two columns, so the text shows it with a space.
fn spaced(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        out.push(c);
        if char_width(c) == 1 {
            out.push(' ');
        }
    }
    out
}

/// A left and a right text on one line. The right text stays whole; the left
/// text loses its end when the two do not fit.
fn two_columns(left: &str, right: &str) -> String {
    let right = fit(right, COLUMNS);
    let room = COLUMNS.saturating_sub(width(&right) + 1);
    let left = fit(left, room);
    let gap = COLUMNS - width(&left) - width(&right);
    format!("{left}{}{right}", " ".repeat(gap))
}

/// The text cut to at most `limit` columns.
fn fit(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars().filter(|c| !c.is_control()) {
        let w = char_width(c);
        if used + w > limit {
            break;
        }
        used += w;
        out.push(c);
    }
    out
}

fn width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

/// Kanji, kana and full-width forms take two columns of the standard font.
fn char_width(c: char) -> usize {
    match c as u32 {
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 => 2,
        _ => 1,
    }
}

/// The StarPRNT bytes that open the drawer on the DK port.
pub fn encode_drawer_kick() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(INITIALIZE);
    bytes.extend_from_slice(DRIVE_DRAWER);
    bytes
}

/// What a printer reports before a task, or what the task did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Offline,
    PaperOut,
    CoverOpen,
    NoDrawer,
    UnknownDevice,
    ResultUnknown,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Done => "done",
            Outcome::Offline => "offline",
            Outcome::PaperOut => "paper_out",
            Outcome::CoverOpen => "cover_open",
            Outcome::NoDrawer => "no_drawer",
            Outcome::UnknownDevice => "unknown_device",
            Outcome::ResultUnknown => "result_unknown",
        }
    }

    fn parse(text: &str) -> Outcome {
        match text {
            "done" => Outcome::Done,
            "offline" => Outcome::Offline,
            "paper_out" => Outcome::PaperOut,
            "cover_open" => Outcome::CoverOpen,
            "no_drawer" => Outcome::NoDrawer,
            "unknown_device" => Outcome::UnknownDevice,
            _ => Outcome::ResultUnknown,
        }
    }

    /// The health that the Devices page shows after this outcome.
    fn health(self) -> Option<(&'static str, Option<&'static str>, Option<&'static str>)> {
        match self {
            Outcome::Done => Some(("ok", None, None)),
            Outcome::Offline => Some((
                "fault",
                Some("OFFLINE"),
                Some("The printer does not answer on the shop network."),
            )),
            Outcome::PaperOut => Some((
                "fault",
                Some("PAPER_OUT"),
                Some("The printer has no paper."),
            )),
            Outcome::CoverOpen => Some((
                "fault",
                Some("COVER_OPEN"),
                Some("The printer cover is open."),
            )),
            _ => None,
        }
    }
}

/// A printer that this computer reaches on the shop LAN. `printers.json` in
/// the gateway's folder holds a list of them.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanPrinter {
    pub source_key: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// An `mJ-Drawer` hangs on this printer's DK port.
    #[serde(default)]
    pub drawer: bool,
    #[serde(default)]
    pub name: Option<String>,
}

fn default_port() -> u16 {
    STAR_PRINT_PORT
}

/// A printer for a run with no hardware. It appends the bytes and the plain
/// text of each task to two files in `outputDir`, and it can answer as a
/// printer with no paper, an open cover or no connection.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulatedPrinter {
    pub source_key: String,
    #[serde(default)]
    pub drawer: bool,
    /// "ready", "offline", "paper_out" or "cover_open".
    #[serde(default = "ready")]
    pub status: String,
    pub output_dir: PathBuf,
}

fn ready() -> String {
    "ready".to_string()
}

enum Target<'a> {
    Lan(&'a LanPrinter),
    Simulated(&'a SimulatedPrinter),
}

impl Target<'_> {
    fn drawer(&self) -> bool {
        match self {
            Target::Lan(printer) => printer.drawer,
            Target::Simulated(printer) => printer.drawer,
        }
    }
}

enum Task {
    Print(Box<ReceiptLayout>),
    Kick,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    task: String,
    source_key: String,
    /// "dispatching" until the printer answered, then the outcome.
    outcome: String,
    at_seconds: u64,
}

pub struct Printers {
    lan: Vec<LanPrinter>,
    simulated: Vec<SimulatedPrinter>,
    journal_path: PathBuf,
    journal: BTreeMap<String, JournalEntry>,
    /// The health last reported for each printer, so an unchanged one is quiet.
    reported: BTreeMap<String, &'static str>,
}

impl Printers {
    pub fn load(folder: &Path, simulated: Vec<SimulatedPrinter>) -> Result<Self, String> {
        let lan = journal::load(&folder.join("printers.json"))?;
        let journal_path = folder.join("printer-journal.json");
        let mut journal: BTreeMap<String, JournalEntry> = journal::load(&journal_path)?;
        let oldest = journal::oldest_kept();
        journal.retain(|_, entry| entry.at_seconds >= oldest);
        Ok(Self {
            lan,
            simulated,
            journal_path,
            journal,
            reported: BTreeMap::new(),
        })
    }

    /// The printers as found devices for the gateway's hello.
    pub fn found_devices(&self) -> Vec<Value> {
        let lan = self.lan.iter().map(|p| {
            (
                p.source_key.as_str(),
                p.drawer,
                p.name.as_deref(),
                "Star mC-Print3",
            )
        });
        let simulated = self
            .simulated
            .iter()
            .map(|p| (p.source_key.as_str(), p.drawer, None, "Simulated mC-Print3"));
        lan.chain(simulated)
            .map(|(source_key, drawer, name, model)| {
                let mut capabilities =
                    vec![json!({ "id": "print_receipt", "label": "Print a receipt", "revision": 1 })];
                if drawer {
                    capabilities.push(
                        json!({ "id": "cash_drawer", "label": "Open the cash drawer", "revision": 1 }),
                    );
                }
                json!({
                    "sourceKey": source_key,
                    "kind": "receipt_printer",
                    "suggestedName": name.unwrap_or("Receipt printer"),
                    "model": model,
                    "serial": Value::Null,
                    "firmwareVersion": Value::Null,
                    "capabilities": capabilities,
                })
            })
            .collect()
    }

    fn target(&self, source_key: &str) -> Option<Target<'_>> {
        self.lan
            .iter()
            .find(|p| p.source_key == source_key)
            .map(Target::Lan)
            .or_else(|| {
                self.simulated
                    .iter()
                    .find(|p| p.source_key == source_key)
                    .map(Target::Simulated)
            })
    }

    fn persist(&self) -> Result<(), String> {
        journal::save(&self.journal_path, &self.journal)
    }

    /// Answers one `receipt_print` or `cash_drawer_kick` message. The answer is
    /// one `printer_result`, and a `health` report when the printer's health
    /// changed.
    pub fn handle(&mut self, message: &Value) -> Result<Vec<Value>, String> {
        let kind = str_field(message, "type")?.to_string();
        let request_id = str_field(message, "requestId")?.to_string();
        let source_key = str_field(message, "sourceKey")?.to_string();
        if let Some(entry) = self.journal.get(&request_id) {
            let outcome = Outcome::parse(&entry.outcome);
            return Ok(vec![result(&request_id, &source_key, &kind, outcome, true)]);
        }
        let task = match kind.as_str() {
            "receipt_print" => {
                let receipt = message
                    .get("receipt")
                    .ok_or("receipt_print missing receipt")?;
                let layout: ReceiptLayout =
                    serde_json::from_value(receipt.clone()).map_err(|error| error.to_string())?;
                if layout.columns != COLUMNS {
                    return Err(format!("this printer prints {COLUMNS} columns"));
                }
                Task::Print(Box::new(layout))
            }
            "cash_drawer_kick" => Task::Kick,
            other => return Err(format!("{other} is not a printer task")),
        };
        let outcome = match self.target(&source_key) {
            None => Outcome::UnknownDevice,
            Some(target) if matches!(task, Task::Kick) && !target.drawer() => Outcome::NoDrawer,
            Some(_) => {
                self.record(&request_id, &kind, &source_key, "dispatching")?;
                let target = self.target(&source_key).ok_or("the printer went away")?;
                run(&target, &task)
            }
        };
        self.record(&request_id, &kind, &source_key, outcome.as_str())?;
        let mut answers = vec![result(&request_id, &source_key, &kind, outcome, false)];
        if let Some((health, code, text)) = outcome.health()
            && self.reported.get(&source_key) != Some(&health_key(health, code))
        {
            self.reported
                .insert(source_key.clone(), health_key(health, code));
            answers.push(json!({
                "type": "health",
                "reports": [{
                    "sourceKey": source_key,
                    "health": health,
                    "faultCode": code,
                    "faultText": text,
                }],
            }));
        }
        Ok(answers)
    }

    fn record(
        &mut self,
        request_id: &str,
        task: &str,
        source_key: &str,
        outcome: &str,
    ) -> Result<(), String> {
        self.journal.insert(
            request_id.to_string(),
            JournalEntry {
                task: task.to_string(),
                source_key: source_key.to_string(),
                outcome: outcome.to_string(),
                at_seconds: now_seconds(),
            },
        );
        self.persist()
    }
}

fn health_key(health: &'static str, code: Option<&'static str>) -> &'static str {
    code.unwrap_or(health)
}

fn run(target: &Target<'_>, task: &Task) -> Outcome {
    let bytes = match task {
        Task::Print(layout) => encode_receipt(layout),
        Task::Kick => encode_drawer_kick(),
    };
    match target {
        Target::Simulated(printer) => {
            let outcome = match printer.status.as_str() {
                "ready" => Outcome::Done,
                "offline" => Outcome::Offline,
                "paper_out" => Outcome::PaperOut,
                "cover_open" => Outcome::CoverOpen,
                _ => Outcome::Offline,
            };
            if outcome != Outcome::Done {
                return outcome;
            }
            let text = match task {
                Task::Print(layout) => render_receipt(layout),
                Task::Kick => centered("[ cash drawer opened ]"),
            };
            match append(printer, &bytes, &text) {
                Ok(()) => Outcome::Done,
                Err(error) => {
                    eprintln!("The simulated printer failed: {error}");
                    Outcome::ResultUnknown
                }
            }
        }
        Target::Lan(printer) => send_lan(printer, &bytes),
    }
}

fn append(printer: &SimulatedPrinter, bytes: &[u8], text: &str) -> Result<(), String> {
    fs::create_dir_all(&printer.output_dir).map_err(|error| error.to_string())?;
    let open = |name: String| {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(printer.output_dir.join(name))
            .map_err(|error| error.to_string())
    };
    open(format!("{}.starprnt", printer.source_key))?
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    open(format!("{}.txt", printer.source_key))?
        .write_all(text.as_bytes())
        .map_err(|error| error.to_string())
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const STATUS_TIMEOUT: Duration = Duration::from_millis(1500);

/// Sends one task to a printer on the LAN. The printer reports its status
/// first, so a printer with no paper or an open cover prints nothing.
fn send_lan(printer: &LanPrinter, bytes: &[u8]) -> Outcome {
    let Some(address) = resolve(&printer.host, printer.port) else {
        return Outcome::Offline;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return Outcome::Offline;
    };
    if stream.set_read_timeout(Some(STATUS_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(CONNECT_TIMEOUT)).is_err()
    {
        return Outcome::Offline;
    }
    if stream.write_all(REQUEST_STATUS).is_err() {
        return Outcome::Offline;
    }
    if let Some(status) = read_status(&mut stream)
        && status != Outcome::Done
    {
        return status;
    }
    // Bytes may have reached the printer before an error, so it is unknown.
    match stream.write_all(bytes).and_then(|()| stream.flush()) {
        Ok(()) => Outcome::Done,
        Err(_) => Outcome::ResultUnknown,
    }
}

fn resolve(host: &str, port: u16) -> Option<SocketAddr> {
    (host, port).to_socket_addrs().ok()?.next()
}

/// Reads one automatic status block (Rev. 4.20 Appendix 2 §4.2.1). None when
/// the printer sends no status in time; the task then goes ahead.
fn read_status(stream: &mut TcpStream) -> Option<Outcome> {
    let mut head = [0u8; 1];
    loop {
        stream.read_exact(&mut head).ok()?;
        // Header-1 has bit 0 = 1 and bit 4 = 0 (Appendix 2, "Status
        // Identification Method"). Other bytes before it are skipped.
        if head[0] & 0x01 == 1 && head[0] & 0x10 == 0 {
            break;
        }
    }
    // Header-1 bits 5 and 1 to 3 give the byte count with Header-1, 7 to 15
    // (Appendix 2, "Actual transmission byte count and header-1 table").
    let count = (((head[0] >> 5) & 1) * 8 + ((head[0] >> 1) & 7)) as usize;
    if count < 7 {
        return None;
    }
    let mut rest = vec![0u8; count - 1];
    stream.read_exact(&mut rest).ok()?;
    // Over Ethernet, bit 7 of the second byte says that a 2-byte length and
    // that many bytes of status data follow (§4.2.2). They are read and left.
    if rest[0] & 0x80 != 0 {
        let mut length = [0u8; 2];
        if stream.read_exact(&mut length).is_ok() {
            let mut data = vec![0u8; u16::from_be_bytes(length) as usize];
            let _ = stream.read_exact(&mut data);
        }
    }
    let status_1 = rest[1]; // Third byte: printer status 1.
    let status_4 = rest[4]; // Sixth byte: printer status 4, sensor information.
    Some(if status_1 & 0x20 != 0 {
        Outcome::CoverOpen // Bit 5: cover open.
    } else if status_4 & 0x08 != 0 {
        Outcome::PaperOut // Bit 3: paper end.
    } else if status_1 & 0x08 != 0 {
        Outcome::Offline // Bit 3: offline.
    } else {
        Outcome::Done
    })
}

fn result(
    request_id: &str,
    source_key: &str,
    task: &str,
    outcome: Outcome,
    replayed: bool,
) -> Value {
    json!({
        "type": "printer_result",
        "requestId": request_id,
        "sourceKey": source_key,
        "task": task,
        "outcome": outcome.as_str(),
        "replayed": replayed,
    })
}
