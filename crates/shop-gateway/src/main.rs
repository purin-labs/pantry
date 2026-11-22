//! The Pantry shop gateway (Plan 85): a small program on a computer in the shop.
//!
//! It enrolls once with a one-time code, then dials out and holds one socket to
//! the Platform. The shop opens no port, and the Platform never calls it. Only
//! Plan 24's operations cross the socket: health, samples, a pause and its
//! answer, and named cobot tasks. The protocol has no shell, no file transfer
//! and no raw motion command. `packages/control-api/src/device-gateway.ts` owns
//! the protocol.
//!
//! `--simulate` reads devices from a file, so that the whole path runs before
//! any hardware. Plan 90 adds a LAN payment terminal (`terminal`) and a receipt
//! printer with its cash drawer (`printer`). Plan 24 adds the cobot task
//! adapter (`cobot`) for the cobot and oven controllers.
//!
//! `relay` runs the same session as `run` with standard input and output in
//! place of the socket, so that a journey can carry the messages.

mod cobot;
mod journal;
mod printer;
mod terminal;

use std::fs;
use std::io::{BufRead, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::{AUTHORIZATION, HeaderValue};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HEARTBEAT: Duration = Duration::from_secs(30);
const SAMPLE_EVERY: Duration = Duration::from_secs(60);
/// The session reads the Platform and the device adapters this often.
const READ_TICK: Duration = Duration::from_millis(100);
const LONGEST_RETRY: Duration = Duration::from_secs(60);
/// The socket close code that says this gateway's access has ended.
const REVOKED_CODE: u16 = 4403;

/// Devices for a run with no hardware. Each entry holds the protocol's own shape.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Simulation {
    #[serde(default)]
    devices: Vec<Value>,
    #[serde(default)]
    health: Vec<Value>,
    #[serde(default)]
    samples: Vec<Value>,
    /// Health reports to send, each after this many seconds on the connection.
    #[serde(default)]
    events: Vec<ScheduledHealth>,
    /// Seconds between heartbeats and between samples, for a short journey.
    heartbeat_seconds: Option<u64>,
    sample_seconds: Option<u64>,
    /// A JPEG file that a simulated camera sends when Pantry asks for a snapshot.
    snapshot_file: Option<PathBuf>,
    /// Simulated LAN payment terminal outcomes (Plan 90 Phase 4A).
    #[serde(default)]
    terminal_outcomes: Vec<terminal::SimulatedTerminalRule>,
    /// Simulated receipt printers (Plan 90 Phase 5).
    #[serde(default)]
    printers: Vec<printer::SimulatedPrinter>,
    /// Cobot and oven controllers, in the shape of `cobots.json` (Plan 24).
    #[serde(default)]
    cobots: Vec<cobot::ControllerAddress>,
}

/// The adapters whose tasks keep a local journal across socket drops.
struct Adapters {
    terminals: terminal::TerminalJournal,
    printers: printer::Printers,
    cobots: cobot::Cobots,
}

impl Adapters {
    fn load(folder: &Path, simulation: &Simulation) -> Result<Self, String> {
        Ok(Self {
            terminals: terminal::TerminalJournal::load(folder)?,
            printers: printer::Printers::load(folder, simulation.printers.clone())?,
            cobots: cobot::Cobots::load(folder, simulation.cobots.clone())?,
        })
    }
}

/// What a gateway does after a task message.
enum TaskReply {
    Send(Vec<Value>),
    /// The simulation drops the socket after the journal holds the outcome.
    Drop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledHealth {
    after_seconds: u64,
    reports: Vec<Value>,
}

enum RunEnd {
    /// The Platform ended this gateway's access. It must not connect again.
    Revoked,
    Dropped(String),
    /// The relay's input says the Platform side connected again.
    Reconnected,
    /// The relay's input ended.
    InputClosed,
}

/// Where the session reads the Platform's messages and sends its own.
trait Platform {
    fn send(&mut self, message: &Value) -> Result<(), String>;
    /// One message, or None after a quiet tick.
    fn receive(&mut self) -> Result<Option<String>, RunEnd>;
    /// The Platform's address and this gateway's credential, for an upload.
    fn uploads(&self) -> Option<(&str, &str)>;
}

/// The real socket to the Platform.
struct Socket<'a> {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    url: &'a str,
    credential: &'a str,
}

impl Platform for Socket<'_> {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        self.socket
            .send(Message::text(message.to_string()))
            .map_err(|error| error.to_string())
    }

    fn receive(&mut self) -> Result<Option<String>, RunEnd> {
        match self.socket.read() {
            Ok(Message::Text(text)) => Ok(Some(text.as_str().to_string())),
            Ok(Message::Close(frame)) => {
                let code = frame.as_ref().map(|close| close.code);
                if code == Some(CloseCode::from(REVOKED_CODE)) {
                    return Err(RunEnd::Revoked);
                }
                Err(RunEnd::Dropped(format!("closed with {code:?}")))
            }
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                Ok(None)
            }
            Err(error) => Err(RunEnd::Dropped(error.to_string())),
        }
    }

    fn uploads(&self) -> Option<(&str, &str)> {
        Some((self.url, self.credential))
    }
}

/// Standard input and output in place of the socket: each input line is one
/// Platform message, or a local `{"relay":"connected"}` or
/// `{"relay":"disconnected"}`. Each output line is one gateway message.
struct Relay {
    lines: Receiver<String>,
    connected: bool,
}

impl Relay {
    fn local(line: &str) -> Option<String> {
        serde_json::from_str::<Value>(line)
            .ok()?
            .get("relay")?
            .as_str()
            .map(str::to_string)
    }

    /// Waits for `{"relay":"connected"}`. The Platform's messages in between
    /// are lost, as they are on a dropped socket.
    fn wait_for_connect(&mut self) -> bool {
        loop {
            match self.lines.recv() {
                Ok(line) if Relay::local(&line).as_deref() == Some("connected") => {
                    self.connected = true;
                    return true;
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    }
}

impl Platform for Relay {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{message}")
            .and_then(|()| out.flush())
            .map_err(|error| error.to_string())
    }

    fn receive(&mut self) -> Result<Option<String>, RunEnd> {
        match self.lines.recv_timeout(READ_TICK) {
            Ok(line) => match Relay::local(&line).as_deref() {
                Some("connected") => Err(RunEnd::Reconnected),
                Some("disconnected") => {
                    self.connected = false;
                    Err(RunEnd::Dropped("relay disconnected".into()))
                }
                _ => Ok(Some(line)),
            },
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(RunEnd::InputClosed),
        }
    }

    fn uploads(&self) -> Option<(&str, &str)> {
        None
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("enroll") => enroll(&args[1..]),
        Some("run") => run(&args[1..]),
        Some("relay") => relay(&args[1..]),
        Some("answer") => answer_once(&args[1..]),
        Some("version") => {
            println!("{VERSION}");
            Ok(())
        }
        _ => Err(
            "usage: shop-gateway enroll --url U --organisation O --gateway G --code C | run [--simulate FILE] | relay [--simulate FILE] | answer [--simulate FILE] | version"
                .to_string(),
        ),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn required(args: &[String], name: &str) -> Result<String, String> {
    option(args, name).ok_or_else(|| format!("{name} is required"))
}

/// A text field of a message.
fn str_field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name}"))
}

fn home() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PANTRY_GATEWAY_HOME") {
        return Ok(PathBuf::from(path));
    }
    std::env::var("HOME")
        .map(|home| Path::new(&home).join(".pantry-gateway"))
        .map_err(|_| "HOME is not set".to_string())
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// The code works one time. The credential stays in a file only this user reads.
fn enroll(args: &[String]) -> Result<(), String> {
    let url = required(args, "--url")?;
    let organisation = required(args, "--organisation")?;
    let gateway = required(args, "--gateway")?;
    let code = required(args, "--code")?;
    let folder = home()?;
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let response = ureq::post(&format!(
        "{}/v1/device-gateways/enroll",
        url.trim_end_matches('/')
    ))
    .send_json(json!({
        "organisationId": organisation,
        "gatewayId": gateway,
        "code": code,
    }))
    .map_err(|error| match error {
        ureq::Error::Status(401, _) => {
            "Purin Pantry refused this code. It works one time and ends in 15 minutes.".to_string()
        }
        other => format!("The enrollment failed: {other}"),
    })?;
    let body: Value = response.into_json().map_err(|error| error.to_string())?;
    let credential = body
        .get("credential")
        .and_then(Value::as_str)
        .ok_or("The answer holds no credential.")?;
    write_private(&folder.join("credential"), credential)?;
    write_private(&folder.join("url"), url.trim_end_matches('/'))?;
    println!("This gateway is enrolled.");
    Ok(())
}

fn read_simulation(args: &[String]) -> Result<Simulation, String> {
    match option(args, "--simulate") {
        Some(path) => {
            let text = fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
            serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))
        }
        None => Ok(Simulation::default()),
    }
}

/// Answers one task message from standard input, with the same journals as
/// `run`, and writes each answer on one line. A journey drives the real
/// adapters with it, and a person can check a printer without a socket.
fn answer_once(args: &[String]) -> Result<(), String> {
    let folder = home()?;
    let simulation = read_simulation(args)?;
    let mut adapters = Adapters::load(&folder, &simulation)?;
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    let message: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    match answer_task(&message, &simulation, &mut adapters) {
        Some(Ok(TaskReply::Send(answers))) => {
            for answer in answers {
                println!("{answer}");
            }
            Ok(())
        }
        Some(Ok(TaskReply::Drop)) => Ok(()),
        Some(Err(error)) => Err(error),
        None => Err("This message is not a device task.".to_string()),
    }
}

/// The answer to a task for a payment terminal, a receipt printer, a cobot or
/// the oven. None for a message of another kind.
fn answer_task(
    message: &Value,
    simulation: &Simulation,
    adapters: &mut Adapters,
) -> Option<Result<TaskReply, String>> {
    if let Some(reply) = adapters.cobots.handle(message) {
        return Some(reply.map(TaskReply::Send));
    }
    let reply = match message.get("type").and_then(Value::as_str)? {
        "terminal_collect" => adapters
            .terminals
            .handle_collect(message, &simulation.terminal_outcomes)
            .map(|action| match action {
                terminal::TerminalAction::SendResult(result) => TaskReply::Send(vec![result]),
                terminal::TerminalAction::SimulateSocketDrop => TaskReply::Drop,
            }),
        "terminal_cancel" => adapters
            .terminals
            .handle_cancel(message)
            .map(|result| TaskReply::Send(vec![result])),
        "terminal_inquire" => adapters
            .terminals
            .handle_inquire(message)
            .map(|result| TaskReply::Send(vec![result])),
        "receipt_print" | "cash_drawer_kick" => {
            adapters.printers.handle(message).map(TaskReply::Send)
        }
        _ => return None,
    };
    Some(reply)
}

/// The folder, the simulation and the adapters of a long session.
fn start(args: &[String]) -> Result<(PathBuf, Simulation, Adapters), String> {
    let folder = home()?;
    let simulation = read_simulation(args)?;
    let mut adapters = Adapters::load(&folder, &simulation)?;
    adapters.cobots.wait_for_devices();
    Ok((folder, simulation, adapters))
}

fn run(args: &[String]) -> Result<(), String> {
    let (folder, simulation, mut adapters) = start(args)?;
    let credential = fs::read_to_string(folder.join("credential"))
        .map_err(|_| "This gateway is not enrolled. Run the install command.".to_string())?;
    let url = fs::read_to_string(folder.join("url")).map_err(|error| error.to_string())?;
    let mut wait = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match connect_and_serve(url.trim(), credential.trim(), &simulation, &mut adapters) {
            RunEnd::Revoked => {
                println!("Purin Pantry ended this gateway's access. It will not connect again.");
                return Ok(());
            }
            RunEnd::Dropped(reason) => eprintln!("The connection ended: {reason}"),
            RunEnd::Reconnected | RunEnd::InputClosed => {}
        }
        // A connection that lasted resets the wait. A failing one backs off.
        if started.elapsed() > LONGEST_RETRY {
            wait = Duration::from_secs(1);
        }
        sleep(wait);
        wait = (wait * 2).min(LONGEST_RETRY);
    }
}

/// The session of `run` on standard input and output. It starts connected.
fn relay(args: &[String]) -> Result<(), String> {
    let (_, simulation, mut adapters) = start(args)?;
    let (sender, lines) = channel();
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() && sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut relay = Relay {
        lines,
        connected: true,
    };
    loop {
        match serve(&mut relay, &simulation, &mut adapters) {
            RunEnd::Revoked | RunEnd::InputClosed => return Ok(()),
            RunEnd::Reconnected => {}
            RunEnd::Dropped(reason) => {
                eprintln!("The relay connection ended: {reason}");
                if !relay.connected && !relay.wait_for_connect() {
                    return Ok(());
                }
            }
        }
    }
}

fn socket_url(url: &str) -> String {
    let base = url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    format!("{base}/v1/device-gateways/socket")
}

fn connect_and_serve(
    url: &str,
    credential: &str,
    simulation: &Simulation,
    adapters: &mut Adapters,
) -> RunEnd {
    let mut request = match socket_url(url).into_client_request() {
        Ok(request) => request,
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    let value = match HeaderValue::from_str(&format!("Bearer {credential}")) {
        Ok(value) => value,
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    request.headers_mut().insert(AUTHORIZATION, value);
    let socket = match tungstenite::connect(request) {
        Ok((socket, _)) => socket,
        Err(tungstenite::Error::Http(response)) if response.status() == 401 => {
            return RunEnd::Revoked;
        }
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    if let Err(error) = set_read_tick(&socket) {
        return RunEnd::Dropped(error);
    }
    println!("Connected to Purin Pantry.");
    let mut platform = Socket {
        socket,
        url,
        credential,
    };
    serve(&mut platform, simulation, adapters)
}

fn set_read_tick(socket: &WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), String> {
    let stream: &TcpStream = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::Rustls(stream) => stream.get_ref(),
        _ => return Err("This TLS stream is not supported.".to_string()),
    };
    stream
        .set_read_timeout(Some(READ_TICK))
        .map_err(|error| error.to_string())
}

/// The hello: the simulated devices and each device that an adapter found.
fn hello(simulation: &Simulation, adapters: &Adapters) -> Value {
    let mut devices = simulation.devices.clone();
    let found = adapters
        .printers
        .found_devices()
        .into_iter()
        .chain(adapters.cobots.found_devices());
    for device in found {
        if !devices
            .iter()
            .any(|known| known["sourceKey"] == device["sourceKey"])
        {
            devices.push(device);
        }
    }
    json!({
        "type": "hello",
        "serviceVersion": VERSION,
        "devices": devices,
        "health": simulation.health,
    })
}

/// One connection's session: the same for the socket and for the relay.
fn serve(platform: &mut dyn Platform, simulation: &Simulation, adapters: &mut Adapters) -> RunEnd {
    let heartbeat = simulation
        .heartbeat_seconds
        .map_or(HEARTBEAT, Duration::from_secs);
    let sample_every = simulation
        .sample_seconds
        .map_or(SAMPLE_EVERY, Duration::from_secs);
    if let Err(error) = platform.send(&hello(simulation, adapters)) {
        return RunEnd::Dropped(error);
    }
    let connected = Instant::now();
    let mut last_heartbeat = Instant::now();
    let mut last_sample: Option<Instant> = None;
    let mut sent_events = vec![false; simulation.events.len()];
    // The Platform records the hello first, so a report waits for its welcome.
    let mut welcomed = false;
    loop {
        if last_heartbeat.elapsed() >= heartbeat {
            if let Err(error) = platform.send(&json!({ "type": "heartbeat" })) {
                return RunEnd::Dropped(error);
            }
            last_heartbeat = Instant::now();
        }
        if welcomed
            && !simulation.samples.is_empty()
            && last_sample.is_none_or(|at| at.elapsed() >= sample_every)
        {
            let message = json!({ "type": "samples", "samples": simulation.samples });
            if let Err(error) = platform.send(&message) {
                return RunEnd::Dropped(error);
            }
            last_sample = Some(Instant::now());
        }
        for (index, event) in simulation.events.iter().enumerate() {
            if welcomed
                && !sent_events[index]
                && connected.elapsed() >= Duration::from_secs(event.after_seconds)
            {
                let message = json!({ "type": "health", "reports": event.reports });
                if let Err(error) = platform.send(&message) {
                    return RunEnd::Dropped(error);
                }
                sent_events[index] = true;
            }
        }
        if welcomed {
            let mut messages = adapters.cobots.tick();
            // A controller that reported a new device changes the hello.
            if adapters.cobots.take_devices_changed() {
                messages.insert(0, hello(simulation, adapters));
            }
            for message in &messages {
                if let Err(error) = platform.send(message) {
                    return RunEnd::Dropped(error);
                }
            }
        }
        match platform.receive() {
            Ok(Some(text)) => match answer(platform, &text, simulation, adapters) {
                Ok(true) if !welcomed => {
                    welcomed = true;
                    // Pantry may have missed reports while it was away.
                    adapters.cobots.reopen();
                }
                Ok(_) => {}
                Err(error) => return RunEnd::Dropped(error),
            },
            Ok(None) => {}
            Err(end) => return end,
        }
    }
}

/// A pause stops work at the adapter. A simulated device only answers. Returns
/// true when this message is the Platform's welcome.
fn answer(
    platform: &mut dyn Platform,
    text: &str,
    simulation: &Simulation,
    adapters: &mut Adapters,
) -> Result<bool, String> {
    let message: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    match answer_task(&message, simulation, adapters) {
        Some(Ok(TaskReply::Send(answers))) => {
            for answer in &answers {
                platform.send(answer)?;
            }
            return Ok(false);
        }
        Some(Ok(TaskReply::Drop)) => return Err("simulated mid-flight socket drop".to_string()),
        // The connection ends, so the Platform marks the task's result unknown.
        Some(Err(error)) => return Err(format!("A device task failed: {error}")),
        None => {}
    }
    match message.get("type").and_then(Value::as_str) {
        Some("welcome") => Ok(true),
        Some("pause" | "resume" | "stop") => {
            let request = message.get("requestId").cloned().unwrap_or(Value::Null);
            eprintln!("Purin Pantry sent {text}");
            platform.send(&json!({ "type": "ack", "requestId": request, "outcome": "done" }))?;
            Ok(false)
        }
        Some("snapshot") => {
            let request = message
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let outcome = match send_snapshot(request, simulation, platform.uploads()) {
                Ok(()) => "done",
                Err(error) => {
                    eprintln!("The snapshot failed: {error}");
                    "refused"
                }
            };
            platform.send(&json!({ "type": "ack", "requestId": request, "outcome": outcome }))?;
            Ok(false)
        }
        Some("refused") => {
            eprintln!("Purin Pantry refused a report: {text}");
            Ok(false)
        }
        _ => Ok(false),
    }
}

/// Sends one still image. The gateway keeps no copy and no video.
fn send_snapshot(
    request: &str,
    simulation: &Simulation,
    uploads: Option<(&str, &str)>,
) -> Result<(), String> {
    let path = simulation
        .snapshot_file
        .as_ref()
        .ok_or("This gateway has no camera adapter.")?;
    let (url, credential) = uploads.ok_or("A relay session uploads no image.")?;
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let snapshot = request.split(':').next().unwrap_or("");
    ureq::post(&format!("{url}/v1/device-gateways/snapshots/{snapshot}"))
        .set("authorization", &format!("Bearer {credential}"))
        .set("content-type", "image/jpeg")
        .send_bytes(&bytes)
        .map_err(|error| error.to_string())?;
    Ok(())
}
