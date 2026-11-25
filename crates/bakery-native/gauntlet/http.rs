//! Minimal loopback HTTP/1.1 + base64 client for `robosim_gauntlet.proxy`.
//!
//! Uses only `std::net::TcpStream` and `serde_json` so `Cargo.lock` stays
//! untouched and the controller runs completely out of process with zero
//! privileged simulator access.

use anyhow::{Context, Result, bail, ensure};
use bakery_native::closed_loop::{ClosedLoopPlant, PlantMeas, PlantStep};
use serde_json::{Map, Value, json};
use std::{
    env,
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

/// Scalar measurements returned eagerly on `/begin` and `/step`.
#[derive(Clone, Debug)]
pub struct StepMeas {
    pub q: [f64; 6],
    pub gripper: f64,
    pub cam_timestamp: Option<f64>,
}

/// Result of `POST /step`: either next measurements or episode termination (HTTP 409).
#[derive(Clone, Debug)]
pub enum StepReply {
    Meas(StepMeas),
    EpisodeOver,
}

pub struct GauntletClient {
    addr: String,
    cam_key: Option<String>,
}

impl GauntletClient {
    pub fn from_env(cam_key: Option<String>) -> Result<Self> {
        let url = env::var("GAUNTLET_URL").context("Missing GAUNTLET_URL environment variable")?;
        let stripped = url
            .trim()
            .trim_end_matches('/')
            .strip_prefix("http://")
            .with_context(|| format!("Unsupported GAUNTLET_URL: {url}"))?;
        Ok(Self {
            addr: stripped.to_owned(),
            cam_key,
        })
    }

    pub fn begin(&self) -> Result<StepMeas> {
        let (code, doc) = self.call("POST", "/begin", Some(&json!({})))?;
        ensure!(code == 200, "/begin returned HTTP {code}: {doc}");
        self.parse_step_meas(&doc)
    }

    pub fn step(&self, arm_ctrl: &[f64; 6], jaw_ctrl: f64) -> Result<StepReply> {
        let mut body = Map::with_capacity(7);
        for (i, &v) in arm_ctrl.iter().enumerate() {
            body.insert(
                format!("goal_position/j{}", i + 1),
                encode_f32_scalar(v as f32),
            );
        }
        body.insert(
            "goal_position/gripper".into(),
            encode_f32_scalar(jaw_ctrl as f32),
        );
        let (code, doc) = self.call("POST", "/step", Some(&Value::Object(body)))?;
        if code == 409 {
            return Ok(StepReply::EpisodeOver);
        }
        ensure!(code == 200, "/step returned HTTP {code}: {doc}");
        Ok(StepReply::Meas(self.parse_step_meas(&doc)?))
    }

    pub fn read_rgb(&self, key: &str) -> Result<(usize, usize, Vec<u8>)> {
        let path = format!("/read?key={key}");
        let (code, doc) = self.call("GET", &path, None)?;
        ensure!(code == 200, "{path} returned HTTP {code}: {doc}");
        let (dtype, shape, raw) = decode_array(&doc)?;
        ensure!(
            dtype == "|u1" && shape.len() == 3 && shape[2] == 3,
            "Expected uint8 HxWx3 RGB array for {key}, got {dtype} {shape:?}"
        );
        ensure!(
            raw.len() == shape[0] * shape[1] * 3,
            "RGB byte length mismatch"
        );
        Ok((shape[0], shape[1], raw))
    }

    pub fn read_depth(&self, key: &str) -> Result<(usize, usize, Vec<f32>)> {
        let path = format!("/read?key={key}");
        let (code, doc) = self.call("GET", &path, None)?;
        ensure!(code == 200, "{path} returned HTTP {code}: {doc}");
        let (dtype, shape, raw) = decode_array(&doc)?;
        ensure!(
            (dtype == "<f4" || dtype == "f4") && shape.len() == 2,
            "Expected float32 HxW depth array for {key}, got {dtype} {shape:?}"
        );
        let count = shape[0] * shape[1];
        ensure!(raw.len() == count * 4, "Depth byte length mismatch");
        let mut out = Vec::with_capacity(count);
        for chunk in raw.chunks_exact(4) {
            out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok((shape[0], shape[1], out))
    }

    pub fn end(&self) -> Result<()> {
        let _ = self.call("POST", "/end", Some(&json!({})));
        Ok(())
    }

    fn parse_step_meas(&self, doc: &Value) -> Result<StepMeas> {
        let obj = doc.as_object().context("Step reply is not a JSON object")?;
        let mut q = [0.0; 6];
        for (i, slot) in q.iter_mut().enumerate() {
            let key = format!("joint_position/j{}", i + 1);
            *slot = decode_f64_scalar(
                obj.get(&key)
                    .with_context(|| format!("Missing key {key}"))?,
            )?;
        }
        let gripper = decode_f64_scalar(
            obj.get("joint_position/gripper")
                .context("Missing key joint_position/gripper")?,
        )?;
        let cam_timestamp = match &self.cam_key {
            Some(cam) => {
                let ts_key = format!("{cam}_timestamp");
                match obj.get(&ts_key) {
                    Some(v) => Some(decode_f64_scalar(v)?),
                    None => None,
                }
            }
            None => None,
        };
        Ok(StepMeas {
            q,
            gripper,
            cam_timestamp,
        })
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value)> {
        let payload = match body {
            Some(v) => serde_json::to_vec(v)?,
            None => Vec::new(),
        };
        let mut stream = TcpStream::connect(&self.addr)
            .with_context(|| format!("Connect to GAUNTLET_URL at {}", self.addr))?;
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(Duration::from_secs(120)))?;
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;

        let header = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.addr,
            payload.len()
        );
        stream.write_all(header.as_bytes())?;
        if !payload.is_empty() {
            stream.write_all(&payload)?;
        }
        stream.flush()?;

        let mut response = Vec::with_capacity(4096);
        stream.read_to_end(&mut response)?;
        let split = response
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .context("Malformed HTTP response from GAUNTLET_URL")?;
        let head = std::str::from_utf8(&response[..split]).context("Non-UTF8 HTTP header")?;
        let status_line = head.lines().next().context("Empty HTTP status line")?;
        let code: u16 = status_line
            .split_whitespace()
            .nth(1)
            .context("Missing HTTP status code")?
            .parse()
            .context("Invalid HTTP status code")?;
        let body_bytes = &response[split + 4..];
        let doc = if body_bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(body_bytes).context("Invalid JSON in HTTP body")?
        };
        Ok((code, doc))
    }
}

impl ClosedLoopPlant for GauntletClient {
    fn begin(&mut self) -> Result<PlantMeas> {
        let m = GauntletClient::begin(self)?;
        Ok(PlantMeas {
            q: m.q,
            gripper: m.gripper,
            cam_timestamp: m.cam_timestamp,
        })
    }

    fn step(&mut self, arm_ctrl: &[f64; 6], jaw_ctrl: f64) -> Result<PlantStep> {
        match GauntletClient::step(self, arm_ctrl, jaw_ctrl)? {
            StepReply::Meas(m) => Ok(PlantStep::Meas(PlantMeas {
                q: m.q,
                gripper: m.gripper,
                cam_timestamp: m.cam_timestamp,
            })),
            StepReply::EpisodeOver => Ok(PlantStep::EpisodeOver),
        }
    }

    fn read_rgb(&mut self) -> Result<(usize, usize, Vec<u8>)> {
        let Some(key) = self.cam_key.as_deref() else {
            return Ok((0, 0, Vec::new()));
        };
        GauntletClient::read_rgb(self, key)
    }

    fn read_depth(&mut self) -> Result<(usize, usize, Vec<f32>)> {
        let Some(cam) = self.cam_key.as_deref() else {
            return Ok((0, 0, Vec::new()));
        };
        let key = format!("{cam}_depth");
        GauntletClient::read_depth(self, &key)
    }

    fn end(&mut self) -> Result<()> {
        GauntletClient::end(self)
    }
}

fn encode_f32_scalar(val: f32) -> Value {
    json!({
        "dtype": "<f4",
        "shape": [],
        "b64": base64_encode(&val.to_le_bytes()),
    })
}

fn decode_f64_scalar(val: &Value) -> Result<f64> {
    let (dtype, _shape, raw) = decode_array(val)?;
    match dtype.as_str() {
        "<f4" | "f4" => {
            ensure!(raw.len() == 4, "Expected 4 bytes for f32");
            Ok(f64::from(f32::from_le_bytes([
                raw[0], raw[1], raw[2], raw[3],
            ])))
        }
        "<f8" | "f8" => {
            ensure!(raw.len() == 8, "Expected 8 bytes for f64");
            Ok(f64::from_le_bytes([
                raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
            ]))
        }
        other => bail!("Unsupported scalar dtype {other}"),
    }
}

fn decode_array(val: &Value) -> Result<(String, Vec<usize>, Vec<u8>)> {
    let obj = val.as_object().context("Encoded array is not an object")?;
    let dtype = obj
        .get("dtype")
        .and_then(Value::as_str)
        .context("Missing dtype")?
        .to_owned();
    let shape: Vec<usize> = obj
        .get("shape")
        .and_then(Value::as_array)
        .context("Missing shape")?
        .iter()
        .map(|v| {
            v.as_u64()
                .map(|n| n as usize)
                .context("Invalid shape element")
        })
        .collect::<Result<_>>()?;
    let b64 = obj
        .get("b64")
        .and_then(Value::as_str)
        .context("Missing b64")?;
    let raw = base64_decode(b64)?;
    Ok((dtype, shape, raw))
}

const B64_ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = if chunk.len() > 1 {
            u32::from(chunk[1])
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            u32::from(chunk[2])
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHA[((triple >> 18) & 0x3f) as usize] as char);
        out.push(B64_ALPHA[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHA[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHA[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(input: &str) -> Result<Vec<u8>> {
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    ensure!(bytes.len().is_multiple_of(4), "Invalid base64 length");
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    for chunk in bytes.chunks_exact(4) {
        let v0 = base64_val(chunk[0]).context("Invalid base64 byte")?;
        let v1 = base64_val(chunk[1]).context("Invalid base64 byte")?;
        out.push((v0 << 2) | (v1 >> 4));
        if chunk[2] != b'=' {
            let v2 = base64_val(chunk[2]).context("Invalid base64 byte")?;
            out.push((v1 << 4) | (v2 >> 2));
            if chunk[3] != b'=' {
                let v3 = base64_val(chunk[3]).context("Invalid base64 byte")?;
                out.push((v2 << 6) | v3);
            }
        }
    }
    Ok(out)
}
