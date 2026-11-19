//! The Satyr shop gateway (Plan 85): a small program on a computer in the shop.
//!
//! It enrolls once with a one-time code, then dials out and holds one socket to
//! the Platform. The shop opens no port, and the Platform never calls it. Only
//! Plan 24's operations cross the socket: health, samples, a pause and its
//! answer. The protocol has no shell, no file transfer and no raw motion
//! command. `packages/control-api/src/device-gateway.ts` owns the protocol.
//!
//! Plan 24 adds a typed adapter for each physical device. Today `--simulate`
//! reads devices from a file, so that the whole path runs before any hardware.

use std::fs;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread::sleep;
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
const READ_TICK: Duration = Duration::from_millis(500);
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
    /// A JPEG file that a simulated camera sends when Satyr asks for a snapshot.
    snapshot_file: Option<PathBuf>,
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
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("enroll") => enroll(&args[1..]),
        Some("run") => run(&args[1..]),
        Some("version") => {
            println!("{VERSION}");
            Ok(())
        }
        _ => Err(
            "usage: shop-gateway enroll --url U --organisation O --gateway G --code C | run [--simulate FILE] | version"
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

fn home() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PANTRY_GATEWAY_HOME") {
        return Ok(PathBuf::from(path));
    }
    std::env::var("HOME")
        .map(|home| Path::new(&home).join(".satyr-gateway"))
        .map_err(|_| "HOME is not set".to_string())
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
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
            "Seams Pantry refused this code. It works one time and ends in 15 minutes.".to_string()
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

fn run(args: &[String]) -> Result<(), String> {
    let folder = home()?;
    let credential = fs::read_to_string(folder.join("credential"))
        .map_err(|_| "This gateway is not enrolled. Run the install command.".to_string())?;
    let url = fs::read_to_string(folder.join("url")).map_err(|error| error.to_string())?;
    let simulation = match option(args, "--simulate") {
        Some(path) => {
            let text = fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
            serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))?
        }
        None => Simulation::default(),
    };
    let mut wait = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match connect_and_serve(url.trim(), credential.trim(), &simulation) {
            RunEnd::Revoked => {
                println!("Seams Pantry ended this gateway's access. It will not connect again.");
                return Ok(());
            }
            RunEnd::Dropped(reason) => eprintln!("The connection ended: {reason}"),
        }
        // A connection that lasted resets the wait. A failing one backs off.
        if started.elapsed() > LONGEST_RETRY {
            wait = Duration::from_secs(1);
        }
        sleep(wait);
        wait = (wait * 2).min(LONGEST_RETRY);
    }
}

fn socket_url(url: &str) -> String {
    let base = url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    format!("{base}/v1/device-gateways/socket")
}

fn connect_and_serve(url: &str, credential: &str, simulation: &Simulation) -> RunEnd {
    let mut request = match socket_url(url).into_client_request() {
        Ok(request) => request,
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    let value = match HeaderValue::from_str(&format!("Bearer {credential}")) {
        Ok(value) => value,
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    request.headers_mut().insert(AUTHORIZATION, value);
    let mut socket = match tungstenite::connect(request) {
        Ok((socket, _)) => socket,
        Err(tungstenite::Error::Http(response)) if response.status() == 401 => {
            return RunEnd::Revoked;
        }
        Err(error) => return RunEnd::Dropped(error.to_string()),
    };
    if let Err(error) = set_read_tick(&mut socket) {
        return RunEnd::Dropped(error);
    }
    println!("Connected to Seams Pantry.");
    serve(&mut socket, simulation, url, credential)
}

fn set_read_tick(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), String> {
    let stream: &TcpStream = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::Rustls(stream) => stream.get_ref(),
        _ => return Err("This TLS stream is not supported.".to_string()),
    };
    stream
        .set_read_timeout(Some(READ_TICK))
        .map_err(|error| error.to_string())
}

fn send(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, message: &Value) -> Result<(), String> {
    socket
        .send(Message::text(message.to_string()))
        .map_err(|error| error.to_string())
}

fn serve(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    simulation: &Simulation,
    url: &str,
    credential: &str,
) -> RunEnd {
    let heartbeat = simulation
        .heartbeat_seconds
        .map_or(HEARTBEAT, Duration::from_secs);
    let sample_every = simulation
        .sample_seconds
        .map_or(SAMPLE_EVERY, Duration::from_secs);
    let hello = json!({
        "type": "hello",
        "serviceVersion": VERSION,
        "devices": simulation.devices,
        "health": simulation.health,
    });
    if let Err(error) = send(socket, &hello) {
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
            if let Err(error) = send(socket, &json!({ "type": "heartbeat" })) {
                return RunEnd::Dropped(error);
            }
            last_heartbeat = Instant::now();
        }
        if welcomed
            && !simulation.samples.is_empty()
            && last_sample.is_none_or(|at| at.elapsed() >= sample_every)
        {
            let message = json!({ "type": "samples", "samples": simulation.samples });
            if let Err(error) = send(socket, &message) {
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
                if let Err(error) = send(socket, &message) {
                    return RunEnd::Dropped(error);
                }
                sent_events[index] = true;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => match answer(socket, text.as_str(), simulation, url, credential) {
                Ok(welcome) => welcomed = welcomed || welcome,
                Err(error) => return RunEnd::Dropped(error),
            },
            Ok(Message::Close(frame)) => {
                let code = frame.as_ref().map(|close| close.code);
                if code == Some(CloseCode::from(REVOKED_CODE)) {
                    return RunEnd::Revoked;
                }
                return RunEnd::Dropped(format!("closed with {code:?}"));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(error) => return RunEnd::Dropped(error.to_string()),
        }
    }
}

/// A pause stops work at the adapter. A simulated device only answers. Returns
/// true when this message is the Platform's welcome.
fn answer(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    text: &str,
    simulation: &Simulation,
    url: &str,
    credential: &str,
) -> Result<bool, String> {
    let message: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    match message.get("type").and_then(Value::as_str) {
        Some("welcome") => Ok(true),
        Some("pause" | "resume") => {
            let request = message.get("requestId").cloned().unwrap_or(Value::Null);
            println!("Seams Pantry sent {text}");
            send(
                socket,
                &json!({ "type": "ack", "requestId": request, "outcome": "done" }),
            )?;
            Ok(false)
        }
        Some("snapshot") => {
            let request = message.get("requestId").and_then(Value::as_str).unwrap_or("");
            let outcome = match send_snapshot(request, simulation, url, credential) {
                Ok(()) => "done",
                Err(error) => {
                    eprintln!("The snapshot failed: {error}");
                    "refused"
                }
            };
            send(
                socket,
                &json!({ "type": "ack", "requestId": request, "outcome": outcome }),
            )?;
            Ok(false)
        }
        Some("refused") => {
            eprintln!("Seams Pantry refused a report: {text}");
            Ok(false)
        }
        _ => Ok(false),
    }
}

/// Sends one still image. The gateway keeps no copy and no video.
fn send_snapshot(
    request: &str,
    simulation: &Simulation,
    url: &str,
    credential: &str,
) -> Result<(), String> {
    let path = simulation
        .snapshot_file
        .as_ref()
        .ok_or("This gateway has no camera adapter.")?;
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let snapshot = request.split(':').next().unwrap_or("");
    ureq::post(&format!("{url}/v1/device-gateways/snapshots/{snapshot}"))
        .set("authorization", &format!("Bearer {credential}"))
        .set("content-type", "image/jpeg")
        .send_bytes(&bytes)
        .map_err(|error| error.to_string())?;
    Ok(())
}
