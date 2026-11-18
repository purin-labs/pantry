use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    str::FromStr,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::{
    Client, Url,
    header::{ACCEPT_ENCODING, CONTENT_ENCODING, HeaderMap, HeaderName},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use url::Host;

/// The HTTP request envelope is deliberately tiny. It contains no headers,
/// cookies, credentials, or provider context.
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_DEADLINE: Duration = Duration::from_secs(10);
pub const MAX_CONCURRENT_FETCHES: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchRequestWire {
    url: String,
    address: String,
    deadline_at_unix_ms: u64,
    max_bytes: u64,
}

/// A request that has passed every boundary check. The original URL remains
/// intact so reqwest uses its hostname for Host, TLS SNI, and certificate
/// verification while the resolver override pins the connection address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    url: Url,
    address: IpAddr,
    max_bytes: usize,
    deadline: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    InvalidRequest,
    DestinationNotPublic,
    AddressMismatch,
    DeadlineExpired,
    DeadlineTooFarAhead,
    RequestTooLarge,
    ResponseTooLarge,
    UnsupportedContentEncoding,
    UpstreamStatus,
    RequestFailed,
}

/// The successful fetch response. Header values are intentionally reduced to
/// the two fields the caller needs; no upstream header map crosses this seam.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub location: Option<String>,
    pub body_base64: String,
}

/// Parse and validate the concrete JSON protocol at the service boundary.
pub fn parse_request(body: &[u8], now: SystemTime) -> Result<FetchRequest, FetchError> {
    let wire: FetchRequestWire =
        serde_json::from_slice(body).map_err(|_| FetchError::InvalidRequest)?;
    let url = parse_url(&wire.url)?;
    let address = IpAddr::from_str(&wire.address).map_err(|_| FetchError::InvalidRequest)?;

    if !is_globally_public(address) {
        return Err(FetchError::DestinationNotPublic);
    }

    match url.host().ok_or(FetchError::InvalidRequest)? {
        Host::Ipv4(literal) if IpAddr::V4(literal) != address => {
            return Err(FetchError::AddressMismatch);
        }
        Host::Ipv6(literal) if IpAddr::V6(literal) != address => {
            return Err(FetchError::AddressMismatch);
        }
        Host::Domain(host) if is_blocked_hostname(host) => {
            return Err(FetchError::DestinationNotPublic);
        }
        Host::Ipv4(_) | Host::Ipv6(_) | Host::Domain(_) => {}
    }

    let max_bytes = usize::try_from(wire.max_bytes).map_err(|_| FetchError::InvalidRequest)?;

    if max_bytes > MAX_RESPONSE_BYTES {
        return Err(FetchError::InvalidRequest);
    }

    let now_instant = Instant::now();
    let deadline = deadline_from_unix_ms(wire.deadline_at_unix_ms, now, now_instant)?;

    Ok(FetchRequest {
        url,
        address,
        max_bytes,
        deadline,
    })
}

/// Fetch one validated target under its absolute deadline.
pub async fn execute_fetch(request: FetchRequest) -> Result<FetchResponse, FetchError> {
    let remaining = remaining_until(request.deadline)?;
    tokio::time::timeout(remaining, perform_fetch(request))
        .await
        .map_err(|_| FetchError::DeadlineExpired)?
}

async fn perform_fetch(request: FetchRequest) -> Result<FetchResponse, FetchError> {
    let remaining = remaining_until(request.deadline)?;
    let client = build_pinned_client(&request.url, request.address, remaining)?;
    let response = client
        .get(request.url)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| FetchError::RequestFailed)?;

    let status = response.status();

    if !(200..=599).contains(&status.as_u16()) {
        return Err(FetchError::UpstreamStatus);
    }

    let status = status.as_u16();
    let content_type = optional_header(response.headers(), HeaderName::from_static("content-type"));
    let location = optional_header(response.headers(), HeaderName::from_static("location"));

    // Preserve upstream status and redirect metadata for the trusted Worker,
    // while keeping error bodies out of the protocol.
    if status >= 300 {
        return Ok(FetchResponse {
            status,
            content_type,
            location,
            body_base64: String::new(),
        });
    }

    if has_non_identity_encoding(response.headers()) {
        return Err(FetchError::UnsupportedContentEncoding);
    }

    let body = read_response_body(response, request.max_bytes).await?;

    Ok(FetchResponse {
        status,
        content_type,
        location,
        body_base64: BASE64.encode(body),
    })
}

/// Build a client with no ambient network behavior. The URL passed to the
/// request is never replaced with an address literal: `resolve` only changes
/// where the socket connects, preserving Host/SNI/certificate checks.
fn build_pinned_client(
    url: &Url,
    address: IpAddr,
    timeout: Duration,
) -> Result<Client, FetchError> {
    let host = url.host_str().ok_or(FetchError::InvalidRequest)?;
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .connect_timeout(timeout)
        .timeout(timeout)
        // A zero port tells reqwest to use the URL's conventional or explicit
        // port. The request protocol is the sole source of port authority.
        .resolve(host, SocketAddr::new(address, 0))
        .build()
        .map_err(|_| FetchError::RequestFailed)
}

fn parse_url(raw: &str) -> Result<Url, FetchError> {
    let url = Url::parse(raw).map_err(|_| FetchError::InvalidRequest)?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(FetchError::InvalidRequest);
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::InvalidRequest);
    }

    if url.host_str().is_none() {
        return Err(FetchError::InvalidRequest);
    }

    match url.port_or_known_default() {
        Some(80 | 443) => Ok(url),
        _ => Err(FetchError::InvalidRequest),
    }
}

fn deadline_from_unix_ms(
    deadline_at_unix_ms: u64,
    now: SystemTime,
    now_instant: Instant,
) -> Result<Instant, FetchError> {
    let deadline = UNIX_EPOCH
        .checked_add(Duration::from_millis(deadline_at_unix_ms))
        .ok_or(FetchError::DeadlineTooFarAhead)?;
    let remaining = deadline
        .duration_since(now)
        .map_err(|_| FetchError::DeadlineExpired)?;

    if remaining.is_zero() {
        return Err(FetchError::DeadlineExpired);
    }

    if remaining > MAX_DEADLINE {
        return Err(FetchError::DeadlineTooFarAhead);
    }

    now_instant
        .checked_add(remaining)
        .ok_or(FetchError::DeadlineTooFarAhead)
}

fn remaining_until(deadline: Instant) -> Result<Duration, FetchError> {
    let remaining = deadline.saturating_duration_since(Instant::now());

    if remaining.is_zero() {
        Err(FetchError::DeadlineExpired)
    } else {
        Ok(remaining)
    }
}

async fn read_response_body(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, FetchError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(FetchError::ResponseTooLarge);
    }

    let capacity = response
        .content_length()
        .map_or(0, |length| usize::try_from(length).unwrap_or(max_bytes))
        .min(max_bytes);
    let mut body = Vec::with_capacity(capacity);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| FetchError::RequestFailed)?
    {
        let next_length = body
            .len()
            .checked_add(chunk.len())
            .ok_or(FetchError::ResponseTooLarge)?;

        if next_length > max_bytes {
            return Err(FetchError::ResponseTooLarge);
        }

        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

fn optional_header(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn has_non_identity_encoding(headers: &HeaderMap) -> bool {
    for value in headers.get_all(CONTENT_ENCODING).iter() {
        let Ok(value) = value.to_str() else {
            return true;
        };

        if value
            .split(',')
            .any(|encoding| !encoding.trim().eq_ignore_ascii_case("identity"))
        {
            return true;
        }
    }

    false
}

fn is_blocked_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();

    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
        || host == "metadata.google.internal"
        || host == "invalid"
        || host.ends_with(".invalid")
        || host == "test"
        || host.ends_with(".test")
        || host == "example"
        || host.ends_with(".example")
}

/// Return whether an address is safe to use as a public Internet destination.
/// This intentionally rejects special-use prefixes even when an operating
/// system might route them, including transition forms that can hide an IPv4
/// private address inside IPv6.
pub fn is_globally_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();

    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false;
    }

    if a == 100 && (64..=127).contains(&b) {
        return false;
    }

    if a == 169 && b == 254 {
        return false;
    }

    if a == 172 && (16..=31).contains(&b) {
        return false;
    }

    if a == 192 && (b == 0 || (b == 88 && c == 99) || b == 168) {
        return false;
    }

    if a == 198 && ((18..=19).contains(&b) || (b == 51 && c == 100)) {
        return false;
    }

    if a == 203 && b == 0 && c == 113 {
        return false;
    }

    true
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let [s0, s1, s2, _, _, _, _, _] = address.segments();

    // Only 2000::/3 is globally allocated unicast IPv6 space. Failing closed
    // here prevents future special-use ranges from becoming fetch targets.
    if s0 & 0xe000 != 0x2000 {
        return false;
    }

    // Exclude 6to4 and Teredo from the global-unicast range.
    if s0 == 0x2002 || (s0 == 0x2001 && s1 == 0) {
        return false;
    }

    // Benchmarking, ORCHID/ORCHIDv2, documentation, and 6bone prefixes.
    if (s0 == 0x2001 && s1 == 2 && s2 == 0)
        || (s0 == 0x2001 && (s1 & 0xfff0) == 0x0010)
        || (s0 == 0x2001 && (s1 & 0xfff0) == 0x0020)
        || (s0 == 0x2001 && s1 == 0x0db8)
        || (s0 & 0xfff0) == 0x3ff0
        || s0 == 0x3ffe
    {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{
        Request,
        body::Incoming,
        http::{Response as HttpResponse, header::HOST},
        server::conn::http1,
        service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use std::convert::Infallible;
    use tokio::{net::TcpListener, sync::mpsc};

    #[test]
    fn rejects_non_public_and_transition_addresses() {
        let addresses = [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b:1::1",
            "2001:db8::1",
            "fc00::1",
            "fe80::1",
            "2002:7f00:1::1",
            "4000::1",
        ];

        for address in addresses {
            let parsed = address.parse::<IpAddr>().expect("test address parses");
            assert!(!is_globally_public(parsed), "{address} must be rejected");
        }

        assert!(is_globally_public(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(is_globally_public(
            "2606:4700:4700::1111".parse().expect("public IPv6 parses")
        ));
    }

    #[test]
    fn validates_literal_address_equality_and_protocol_limits() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let deadline = now + Duration::from_secs(2);
        let valid = serde_json::json!({
            "url": "https://1.1.1.1/",
            "address": "1.1.1.1",
            "deadlineAtUnixMs": deadline.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "maxBytes": 1024,
        });

        assert!(parse_request(&serde_json::to_vec(&valid).unwrap(), now).is_ok());

        let mismatched = serde_json::json!({
            "url": "https://1.1.1.1/",
            "address": "8.8.8.8",
            "deadlineAtUnixMs": deadline.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "maxBytes": 1024,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&mismatched).unwrap(), now),
            Err(FetchError::AddressMismatch)
        );

        let mismatched_ipv6 = serde_json::json!({
            "url": "https://[2606:4700:4700::1111]/",
            "address": "8.8.8.8",
            "deadlineAtUnixMs": deadline.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "maxBytes": 1024,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&mismatched_ipv6).unwrap(), now),
            Err(FetchError::AddressMismatch)
        );

        let private = serde_json::json!({
            "url": "http://127.0.0.1/",
            "address": "127.0.0.1",
            "deadlineAtUnixMs": deadline.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "maxBytes": 1024,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&private).unwrap(), now),
            Err(FetchError::DestinationNotPublic)
        );
    }

    #[tokio::test]
    async fn enforces_deadline_and_response_body_limits() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        let expired = serde_json::json!({
            "url": "https://1.1.1.1/",
            "address": "1.1.1.1",
            "deadlineAtUnixMs": now.duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "maxBytes": 1024,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&expired).unwrap(), now),
            Err(FetchError::DeadlineExpired)
        );

        let too_far = serde_json::json!({
            "url": "https://1.1.1.1/",
            "address": "1.1.1.1",
            "deadlineAtUnixMs": (now + MAX_DEADLINE + Duration::from_millis(1))
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
            "maxBytes": 1024,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&too_far).unwrap(), now),
            Err(FetchError::DeadlineTooFarAhead)
        );

        let response = reqwest::Response::from(
            HttpResponse::builder()
                .header("content-length", "1")
                .body(vec![0_u8; 9])
                .unwrap(),
        );
        let result = read_response_body(response, 8).await;
        assert_eq!(result, Err(FetchError::ResponseTooLarge));
    }

    #[tokio::test]
    async fn pins_an_unresolvable_host_to_the_supplied_socket_address() {
        // This isolates the transport proof. The production parser rejects
        // loopback addresses before this client builder can be reached.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("local fixture binds");
        let port = listener.local_addr().expect("local address exists").port();
        let (host_sender, mut host_receiver) = mpsc::unbounded_channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("fixture accepts");
            let service = service_fn(move |request: Request<Incoming>| {
                let host = request
                    .headers()
                    .get(HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let host_sender = host_sender.clone();

                async move {
                    host_sender.send(host).expect("test receiver remains open");
                    Ok::<_, Infallible>(HttpResponse::new(Full::new(Bytes::from_static(b"pinned"))))
                }
            });
            let io = TokioIo::new(stream);
            http1::Builder::new()
                .serve_connection(io, service)
                .await
                .expect("fixture serves one request");
        });

        let url = Url::parse(&format!("http://unresolvable.invalid:{port}/path"))
            .expect("fixture URL parses");
        let client = build_pinned_client(
            &url,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            Duration::from_secs(2),
        )
        .expect("pinned client builds");
        let response = client
            .get(url)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await
            .expect("static resolver reaches fixture");

        assert_eq!(
            response.bytes().await.expect("fixture body reads"),
            "pinned"
        );
        assert_eq!(
            host_receiver.recv().await.expect("fixture reports host"),
            Some(format!("unresolvable.invalid:{port}"))
        );
        drop(client);
        server.await.expect("fixture task succeeds");
    }
}
