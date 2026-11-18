use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    str::FromStr,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::{
    Client, Method, Url,
    header::{
        ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE, HeaderMap,
        HeaderName, HeaderValue, USER_AGENT,
    },
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use url::Host;

pub const MAX_REQUEST_BYTES: usize = 96 * 1024;
pub const MAX_JSON_BODY_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_CREDENTIAL_BYTES: usize = 8 * 1024;
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 256;
pub const MAX_DEADLINE: Duration = Duration::from_secs(15);
pub const MAX_CONCURRENT_FETCHES: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchRequestWire {
    address: String,
    authentication: AuthenticationWire,
    operation: OperationWire,
    timeout_ms: u64,
    max_wire_bytes: u64,
    max_decoded_bytes: u64,
    /// A provider idempotency key for a reviewed REST write.
    #[serde(default)]
    idempotency: Option<IdempotencyWire>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdempotencyWire {
    header: String,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AuthenticationWire {
    Bearer { value: String },
    BasicApiKey { value: String },
    Header { name: String, value: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OperationWire {
    Get {
        url: String,
    },
    PostJson {
        url: String,
        #[serde(rename = "bodyBase64")]
        body_base64: String,
    },
    McpPost {
        url: String,
        #[serde(rename = "bodyBase64")]
        body_base64: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
    McpDelete {
        url: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Authentication {
    Bearer { value: String },
    BasicApiKey { value: String },
    Header { name: HeaderName, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Operation {
    Get,
    PostJson {
        body: Vec<u8>,
    },
    Mcp {
        method: Method,
        body: Vec<u8>,
        headers: HeaderMap,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    url: Url,
    address: IpAddr,
    authentication: Authentication,
    operation: Operation,
    idempotency: Option<(HeaderName, HeaderValue)>,
    max_wire_bytes: usize,
    max_decoded_bytes: usize,
    deadline: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    InvalidRequest,
    DestinationNotPublic,
    AddressMismatch,
    AuthenticationInvalid,
    DeadlineExpired,
    DeadlineTooFarAhead,
    RequestTooLarge,
    ResponseTooLarge,
    UnsupportedContentEncoding,
    RedirectDenied,
    CredentialExposed,
    RequestFailed,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

pub fn parse_request(body: &[u8]) -> Result<FetchRequest, FetchError> {
    let wire: FetchRequestWire =
        serde_json::from_slice(body).map_err(|_| FetchError::InvalidRequest)?;
    let (url, operation) = parse_operation(wire.operation)?;
    let address = IpAddr::from_str(&wire.address).map_err(|_| FetchError::InvalidRequest)?;

    validate_destination(&url, address)?;

    let authentication = parse_authentication(wire.authentication)?;
    let idempotency = wire
        .idempotency
        .map(|idempotency| parse_idempotency(idempotency, &operation, &authentication))
        .transpose()?;
    let max_wire_bytes = parse_response_limit(wire.max_wire_bytes)?;
    let max_decoded_bytes = parse_response_limit(wire.max_decoded_bytes)?;
    let deadline = deadline_from_timeout_ms(wire.timeout_ms, Instant::now())?;

    Ok(FetchRequest {
        url,
        address,
        authentication,
        operation,
        idempotency,
        max_wire_bytes,
        max_decoded_bytes,
        deadline,
    })
}

pub async fn execute_fetch(request: FetchRequest) -> Result<FetchResponse, FetchError> {
    let remaining = remaining_until(request.deadline)?;
    tokio::time::timeout(remaining, perform_fetch(request))
        .await
        .map_err(|_| FetchError::DeadlineExpired)?
}

async fn perform_fetch(request: FetchRequest) -> Result<FetchResponse, FetchError> {
    let remaining = remaining_until(request.deadline)?;
    let client = build_pinned_client(&request.url, request.address, remaining)?;
    let mut outgoing = match &request.operation {
        Operation::Get => client.request(Method::GET, request.url.clone()),
        Operation::PostJson { body } => client
            .request(Method::POST, request.url.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(body.clone()),
        Operation::Mcp {
            method,
            body,
            headers,
        } => client
            .request(method.clone(), request.url.clone())
            .header(CONTENT_TYPE, "application/json")
            .headers(headers.clone())
            .body(body.clone()),
    };

    outgoing = outgoing
        .header(
            ACCEPT,
            if matches!(request.operation, Operation::Mcp { .. }) {
                "application/json, text/event-stream"
            } else {
                "application/json"
            },
        )
        .header(ACCEPT_ENCODING, "identity")
        .header(USER_AGENT, "Satyr-Custom-Connector-Transport/1")
        .header(
            authentication_header_name(&request.authentication),
            authentication_header_value(&request.authentication)?,
        );
    if let Some((name, value)) = &request.idempotency {
        outgoing = outgoing.header(name.clone(), value.clone());
    }

    let response = match outgoing.send().await {
        Ok(response) => response,
        Err(_) if remaining_until(request.deadline).is_err() => {
            return Err(FetchError::DeadlineExpired);
        }
        Err(_) => return Err(FetchError::RequestFailed),
    };
    let status = response.status().as_u16();

    if (300..400).contains(&status) {
        return Err(FetchError::RedirectDenied);
    }

    if !(200..=599).contains(&status) {
        return Err(FetchError::RequestFailed);
    }

    let content_type = optional_header(response.headers(), CONTENT_TYPE)?;
    let session_id = if matches!(request.operation, Operation::Mcp { .. }) {
        optional_header(
            response.headers(),
            HeaderName::from_static("mcp-session-id"),
        )?
    } else {
        None
    };

    if status >= 300 {
        return Ok(FetchResponse {
            status,
            content_type,
            body_base64: String::new(),
            session_id,
        });
    }

    if has_non_identity_encoding(response.headers()) {
        return Err(FetchError::UnsupportedContentEncoding);
    }

    let body =
        read_response_body(response, request.max_wire_bytes, request.max_decoded_bytes).await?;

    if response_contains_authentication(&body, &request.authentication)? {
        return Err(FetchError::CredentialExposed);
    }

    Ok(FetchResponse {
        status,
        content_type,
        body_base64: BASE64.encode(body),
        session_id,
    })
}

fn parse_operation(wire: OperationWire) -> Result<(Url, Operation), FetchError> {
    match wire {
        OperationWire::Get { url } => Ok((parse_url(&url)?, Operation::Get)),
        OperationWire::PostJson { url, body_base64 } => {
            let body = decode_canonical_base64(&body_base64)?;

            if body.len() > MAX_JSON_BODY_BYTES
                || serde_json::from_slice::<serde_json::Value>(&body).is_err()
            {
                return Err(FetchError::InvalidRequest);
            }

            Ok((parse_url(&url)?, Operation::PostJson { body }))
        }
        OperationWire::McpPost {
            url,
            body_base64,
            protocol_version,
            session_id,
        } => {
            let body = decode_canonical_base64(&body_base64)?;
            if body.len() > MAX_JSON_BODY_BYTES
                || serde_json::from_slice::<serde_json::Value>(&body).is_err()
            {
                return Err(FetchError::InvalidRequest);
            }
            Ok((
                parse_url(&url)?,
                Operation::Mcp {
                    method: Method::POST,
                    body,
                    headers: mcp_headers(protocol_version, session_id)?,
                },
            ))
        }
        OperationWire::McpDelete {
            url,
            protocol_version,
            session_id,
        } => Ok((
            parse_url(&url)?,
            Operation::Mcp {
                method: Method::DELETE,
                body: Vec::new(),
                headers: mcp_headers(protocol_version, session_id)?,
            },
        )),
    }
}

fn mcp_headers(
    protocol_version: Option<String>,
    session_id: Option<String>,
) -> Result<HeaderMap, FetchError> {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("mcp-protocol-version", protocol_version),
        ("mcp-session-id", session_id),
    ] {
        if let Some(value) = value {
            if value.is_empty()
                || value.len() > 1024
                || !value.bytes().all(|byte| (33..=126).contains(&byte))
            {
                return Err(FetchError::InvalidRequest);
            }
            headers.insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(&value).map_err(|_| FetchError::InvalidRequest)?,
            );
        }
    }
    Ok(headers)
}

fn parse_authentication(wire: AuthenticationWire) -> Result<Authentication, FetchError> {
    match wire {
        AuthenticationWire::BasicApiKey { value } => {
            validate_credential(&value)?;
            if !value
                .bytes()
                .all(|byte| (33..=126).contains(&byte) && byte != b':')
            {
                return Err(FetchError::AuthenticationInvalid);
            }
            Ok(Authentication::BasicApiKey { value })
        }
        AuthenticationWire::Bearer { value } => {
            validate_credential(&value)?;
            Ok(Authentication::Bearer { value })
        }
        AuthenticationWire::Header { name, value } => {
            validate_credential(&value)?;
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| FetchError::AuthenticationInvalid)?;

            if is_forbidden_authentication_header(&name) {
                return Err(FetchError::AuthenticationInvalid);
            }

            Ok(Authentication::Header { name, value })
        }
    }
}

/// The key travels in its own reviewed header of a REST request. It never
/// replaces a header that carries the credential or controls the transport.
fn parse_idempotency(
    wire: IdempotencyWire,
    operation: &Operation,
    authentication: &Authentication,
) -> Result<(HeaderName, HeaderValue), FetchError> {
    if matches!(operation, Operation::Mcp { .. }) {
        return Err(FetchError::InvalidRequest);
    }
    let name =
        HeaderName::from_bytes(wire.header.as_bytes()).map_err(|_| FetchError::InvalidRequest)?;
    if is_forbidden_authentication_header(&name)
        || name == authentication_header_name(authentication)
        || name.as_str().starts_with("proxy-")
        || name.as_str().starts_with("x-forwarded-")
        || name.as_str().starts_with("cf-")
    {
        return Err(FetchError::InvalidRequest);
    }
    if wire.key.is_empty()
        || wire.key.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || !wire.key.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(FetchError::InvalidRequest);
    }
    let value = HeaderValue::from_str(&wire.key).map_err(|_| FetchError::InvalidRequest)?;
    Ok((name, value))
}

fn validate_credential(value: &str) -> Result<(), FetchError> {
    if value.is_empty()
        || value.len() > MAX_CREDENTIAL_BYTES
        || value.contains(['\r', '\n'])
        || HeaderValue::from_str(value).is_err()
    {
        return Err(FetchError::AuthenticationInvalid);
    }

    Ok(())
}

fn is_forbidden_authentication_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "accept"
            | "accept-encoding"
            | "authorization"
            | "connection"
            | "content-length"
            | "content-type"
            | "cookie"
            | "forwarded"
            | "host"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "user-agent"
            | "via"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
    )
}

fn authentication_header_name(authentication: &Authentication) -> HeaderName {
    match authentication {
        Authentication::Bearer { .. } | Authentication::BasicApiKey { .. } => AUTHORIZATION,
        Authentication::Header { name, .. } => name.clone(),
    }
}

fn authentication_header_value(authentication: &Authentication) -> Result<HeaderValue, FetchError> {
    let value = match authentication {
        Authentication::Bearer { value } => format!("Bearer {value}"),
        Authentication::BasicApiKey { value } => {
            format!("Basic {}", BASE64.encode(format!("{value}:")))
        }
        Authentication::Header { value, .. } => value.clone(),
    };

    HeaderValue::from_str(&value).map_err(|_| FetchError::AuthenticationInvalid)
}

fn credential_value(authentication: &Authentication) -> &str {
    match authentication {
        Authentication::Bearer { value }
        | Authentication::BasicApiKey { value }
        | Authentication::Header { value, .. } => value,
    }
}

fn response_contains_authentication(
    body: &[u8],
    authentication: &Authentication,
) -> Result<bool, FetchError> {
    if response_contains_credential(body, credential_value(authentication).as_bytes())
        || response_contains_credential(
            body,
            authentication_header_value(authentication)?.as_bytes(),
        )
    {
        return Ok(true);
    }
    Ok(match authentication {
        Authentication::BasicApiKey { value } => {
            response_contains_credential(body, format!("{value}:").as_bytes())
        }
        Authentication::Bearer { .. } | Authentication::Header { .. } => false,
    })
}

fn parse_url(raw: &str) -> Result<Url, FetchError> {
    if has_malformed_percent_encoding(raw) || has_forbidden_encoded_path(raw_path(raw)) {
        return Err(FetchError::InvalidRequest);
    }

    let url = Url::parse(raw).map_err(|_| FetchError::InvalidRequest)?;

    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port_or_known_default() != Some(443)
        || url.fragment().is_some()
    {
        return Err(FetchError::InvalidRequest);
    }

    Ok(url)
}

fn raw_path(raw: &str) -> &str {
    let Some(authority_start) = raw.find("://").map(|index| index + 3) else {
        return raw;
    };
    let authority_and_path = &raw[authority_start..];
    let Some(path_start) = authority_and_path.find('/') else {
        return "";
    };
    let path_and_suffix = &authority_and_path[path_start..];
    let path_end = path_and_suffix
        .find(['?', '#'])
        .unwrap_or(path_and_suffix.len());

    &path_and_suffix[..path_end]
}

fn has_malformed_percent_encoding(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return true;
            }
            index += 3;
        } else {
            index += 1;
        }
    }

    false
}

fn has_forbidden_encoded_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    ["%00", "%0a", "%0d", "%2e", "%2f", "%5c"]
        .iter()
        .any(|needle| lowered.contains(needle))
}

fn validate_destination(url: &Url, address: IpAddr) -> Result<(), FetchError> {
    if !is_globally_public(address) {
        return Err(FetchError::DestinationNotPublic);
    }

    match url.host().ok_or(FetchError::InvalidRequest)? {
        Host::Ipv4(literal) if IpAddr::V4(literal) != address => Err(FetchError::AddressMismatch),
        Host::Ipv6(literal) if IpAddr::V6(literal) != address => Err(FetchError::AddressMismatch),
        Host::Domain(host) if is_blocked_hostname(host) => Err(FetchError::DestinationNotPublic),
        Host::Ipv4(_) | Host::Ipv6(_) | Host::Domain(_) => Ok(()),
    }
}

fn parse_response_limit(raw: u64) -> Result<usize, FetchError> {
    let value = usize::try_from(raw).map_err(|_| FetchError::InvalidRequest)?;

    if value == 0 || value > MAX_RESPONSE_BYTES {
        return Err(FetchError::InvalidRequest);
    }

    Ok(value)
}

fn decode_canonical_base64(value: &str) -> Result<Vec<u8>, FetchError> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| FetchError::InvalidRequest)?;

    if BASE64.encode(&decoded) != value {
        return Err(FetchError::InvalidRequest);
    }

    Ok(decoded)
}

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
        .resolve(host, SocketAddr::new(address, 0))
        .build()
        .map_err(|_| FetchError::RequestFailed)
}

async fn read_response_body(
    mut response: reqwest::Response,
    max_wire_bytes: usize,
    max_decoded_bytes: usize,
) -> Result<Vec<u8>, FetchError> {
    let effective_limit = max_wire_bytes.min(max_decoded_bytes);

    if response
        .content_length()
        .is_some_and(|length| length > effective_limit as u64)
    {
        return Err(FetchError::ResponseTooLarge);
    }

    let mut body = Vec::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| FetchError::RequestFailed)?
    {
        let next_length = body
            .len()
            .checked_add(chunk.len())
            .ok_or(FetchError::ResponseTooLarge)?;

        if next_length > max_wire_bytes || next_length > max_decoded_bytes {
            return Err(FetchError::ResponseTooLarge);
        }

        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

fn response_contains_credential(body: &[u8], credential: &[u8]) -> bool {
    if contains_bytes(body, credential) {
        return true;
    }

    let standard = BASE64.encode(credential);
    let url_safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(credential);

    contains_bytes(body, standard.as_bytes()) || contains_bytes(body, url_safe.as_bytes())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn optional_header(headers: &HeaderMap, name: HeaderName) -> Result<Option<String>, FetchError> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| FetchError::RequestFailed)?;

    if value.len() > 8 * 1024 || value.contains(['\r', '\n']) {
        return Err(FetchError::RequestFailed);
    }

    Ok(Some(value.to_owned()))
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

    if s0 & 0xe000 != 0x2000 {
        return false;
    }
    if s0 == 0x2002 || (s0 == 0x2001 && s1 == 0) {
        return false;
    }
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

fn deadline_from_timeout_ms(timeout_ms: u64, now: Instant) -> Result<Instant, FetchError> {
    if timeout_ms == 0 {
        return Err(FetchError::DeadlineExpired);
    }
    let remaining = Duration::from_millis(timeout_ms);
    if remaining > MAX_DEADLINE {
        return Err(FetchError::DeadlineTooFarAhead);
    }

    now.checked_add(remaining)
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

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{
        Request, body::Incoming, http::Response as HttpResponse, server::conn::http1,
        service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use std::{convert::Infallible, future::Future, sync::Arc};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex,
    };

    const TEST_SECRET: &str = "fixture-secret-93fa8f7821";

    #[test]
    fn basic_api_key_uses_an_empty_password_and_rejects_embedded_passwords() {
        let authentication = parse_authentication(AuthenticationWire::BasicApiKey {
            value: TEST_SECRET.to_owned(),
        })
        .expect("valid API key");
        assert_eq!(authentication_header_name(&authentication), AUTHORIZATION);
        assert_eq!(
            authentication_header_value(&authentication).unwrap(),
            format!("Basic {}", BASE64.encode(format!("{TEST_SECRET}:")))
        );
        assert_eq!(
            parse_authentication(AuthenticationWire::BasicApiKey {
                value: "user:password".to_owned(),
            }),
            Err(FetchError::AuthenticationInvalid)
        );
    }

    #[tokio::test]
    async fn basic_api_key_rejects_raw_and_authorization_echoes() {
        for body in [
            TEST_SECRET.to_owned(),
            BASE64.encode(format!("{TEST_SECRET}:")),
            format!("Basic {}", BASE64.encode(format!("{TEST_SECRET}:"))),
        ] {
            let (url, address, server) = start_http_fixture(move |_| {
                let body = body.clone();
                async move { HttpResponse::new(Full::new(Bytes::from(body))) }
            })
            .await;
            let mut request =
                fixture_request(url, address, Operation::Get, TEST_SECRET, 1024, 1024);
            request.authentication = Authentication::BasicApiKey {
                value: TEST_SECRET.to_owned(),
            };
            assert_eq!(
                perform_fetch(request).await,
                Err(FetchError::CredentialExposed)
            );
            server.await.expect("fixture task succeeds");
        }
    }

    #[test]
    fn rejects_private_special_and_transition_addresses() {
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

        for raw in addresses {
            let address = raw.parse::<IpAddr>().expect("fixture address parses");
            assert!(!is_globally_public(address), "{raw} must be denied");
        }
    }

    #[test]
    fn rejects_invalid_destination_authentication_and_json_shapes() {
        let mut valid = request_json("https://api.example.net/v1/items", "1.1.1.1");

        assert!(parse_request(&serde_json::to_vec(&valid).unwrap()).is_ok());

        valid["address"] = serde_json::json!("127.0.0.1");
        assert_eq!(
            parse_request(&serde_json::to_vec(&valid).unwrap()),
            Err(FetchError::DestinationNotPublic)
        );

        let mut invalid_header = request_json("https://api.example.net/v1/items", "1.1.1.1");
        invalid_header["authentication"] = serde_json::json!({
            "kind": "header",
            "name": "Host",
            "value": TEST_SECRET,
        });
        assert_eq!(
            parse_request(&serde_json::to_vec(&invalid_header).unwrap()),
            Err(FetchError::AuthenticationInvalid)
        );

        let mut invalid_path = request_json("https://api.example.net/%2e%2e/admin", "1.1.1.1");
        assert_eq!(
            parse_request(&serde_json::to_vec(&invalid_path).unwrap()),
            Err(FetchError::InvalidRequest)
        );
        invalid_path["operation"]["url"] = serde_json::json!("https://api.example.net/%zz");
        assert_eq!(
            parse_request(&serde_json::to_vec(&invalid_path).unwrap()),
            Err(FetchError::InvalidRequest)
        );
    }

    #[test]
    fn rejects_expired_and_excessive_deadlines_and_limits() {
        let mut request = request_json("https://api.example.net/v1/items", "1.1.1.1");
        request["timeoutMs"] = serde_json::json!(0);
        assert_eq!(
            parse_request(&serde_json::to_vec(&request).unwrap()),
            Err(FetchError::DeadlineExpired)
        );

        request["timeoutMs"] = serde_json::json!(MAX_DEADLINE.as_millis() + 1);
        assert_eq!(
            parse_request(&serde_json::to_vec(&request).unwrap()),
            Err(FetchError::DeadlineTooFarAhead)
        );

        request = request_json("https://api.example.net/v1/items", "1.1.1.1");
        request["maxWireBytes"] = serde_json::json!(MAX_RESPONSE_BYTES + 1);
        assert_eq!(
            parse_request(&serde_json::to_vec(&request).unwrap()),
            Err(FetchError::InvalidRequest)
        );
    }

    #[tokio::test]
    async fn pins_the_reviewed_host_to_the_selected_address() {
        let observed_host = Arc::new(Mutex::new(None));
        let observed_credential = Arc::new(Mutex::new(None));
        let host_observer = Arc::clone(&observed_host);
        let credential_observer = Arc::clone(&observed_credential);
        let (url, address, server) = start_http_fixture(move |request| {
            let host = request
                .headers()
                .get("host")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let credential = request
                .headers()
                .get("x-satyr-probe-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let host_observer = Arc::clone(&host_observer);
            let credential_observer = Arc::clone(&credential_observer);

            async move {
                *host_observer.lock().await = host;
                *credential_observer.lock().await = credential;
                HttpResponse::new(Full::new(Bytes::from_static(br#"{"ok":true}"#)))
            }
        })
        .await;
        let request = fixture_request(
            url.clone(),
            address,
            Operation::Get,
            TEST_SECRET,
            1024,
            1024,
        );
        let response = perform_fetch(request)
            .await
            .expect("pinned fixture succeeds");
        let expected_host = format!("reviewed-host.invalid:{}", url.port().unwrap());

        assert_eq!(response.status, 200);
        assert_eq!(
            observed_host.lock().await.as_deref(),
            Some(expected_host.as_str())
        );
        assert_eq!(
            observed_credential.lock().await.as_deref(),
            Some(TEST_SECRET)
        );
        server.await.expect("fixture task succeeds");
    }

    #[tokio::test]
    async fn sends_a_reviewed_idempotency_key_and_refuses_it_in_a_credential_header() {
        let observed_key = Arc::new(Mutex::new(None));
        let key_observer = Arc::clone(&observed_key);
        let (url, address, server) = start_http_fixture(move |request| {
            let key = request
                .headers()
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let key_observer = Arc::clone(&key_observer);

            async move {
                *key_observer.lock().await = key;
                HttpResponse::new(Full::new(Bytes::from_static(br#"{"ok":true}"#)))
            }
        })
        .await;
        let mut wire = request_json("https://api.example.net/v1/items", "1.1.1.1");
        wire["operation"] = serde_json::json!({
            "kind": "post_json",
            "url": "https://api.example.net/v1/items",
            "bodyBase64": BASE64.encode(br#"{"name":"tart"}"#),
        });
        wire["idempotency"] =
            serde_json::json!({ "header": "Idempotency-Key", "key": "satyr-effect-1" });
        let parsed = parse_request(&serde_json::to_vec(&wire).unwrap()).expect("key is valid");
        let mut request = fixture_request(
            url,
            address,
            parsed.operation.clone(),
            TEST_SECRET,
            1024,
            1024,
        );
        request.idempotency = parsed.idempotency.clone();

        let response = perform_fetch(request).await.expect("fixture succeeds");

        assert_eq!(response.status, 200);
        assert_eq!(observed_key.lock().await.as_deref(), Some("satyr-effect-1"));
        server.await.expect("fixture task succeeds");

        wire["idempotency"] =
            serde_json::json!({ "header": "authorization", "key": "satyr-effect-1" });
        assert_eq!(
            parse_request(&serde_json::to_vec(&wire).unwrap()),
            Err(FetchError::InvalidRequest)
        );
        wire["idempotency"] =
            serde_json::json!({ "header": "idempotency-key", "key": "two words" });
        assert_eq!(
            parse_request(&serde_json::to_vec(&wire).unwrap()),
            Err(FetchError::InvalidRequest)
        );
    }

    #[tokio::test]
    async fn rejects_redirects_without_following_them() {
        let (url, address, server) = start_http_fixture(|_| async {
            HttpResponse::builder()
                .status(302)
                .header("location", "http://127.0.0.1/private")
                .body(Full::new(Bytes::new()))
                .expect("redirect fixture is valid")
        })
        .await;
        let request = fixture_request(url, address, Operation::Get, TEST_SECRET, 1024, 1024);

        assert_eq!(
            perform_fetch(request).await,
            Err(FetchError::RedirectDenied)
        );
        server.await.expect("fixture task succeeds");
    }

    #[tokio::test]
    async fn enforces_streamed_wire_and_decoded_limits() {
        let (url, address, server) = start_raw_http_fixture(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\naaaaa\r\n4\r\naaaa\r\n0\r\n\r\n",
        )
        .await;
        let request = fixture_request(url, address, Operation::Get, TEST_SECRET, 8, 64);
        assert_eq!(
            perform_fetch(request).await,
            Err(FetchError::ResponseTooLarge)
        );
        server.await.expect("fixture task succeeds");

        let (url, address, server) = start_raw_http_fixture(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\naaaaa\r\n4\r\naaaa\r\n0\r\n\r\n",
        )
        .await;
        let request = fixture_request(url, address, Operation::Get, TEST_SECRET, 64, 8);
        assert_eq!(
            perform_fetch(request).await,
            Err(FetchError::ResponseTooLarge)
        );
        server.await.expect("fixture task succeeds");
    }

    #[tokio::test]
    async fn rejects_content_decoding_and_cancels_at_the_monotonic_deadline() {
        let (url, address, server) = start_raw_http_fixture(
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\ntest",
        )
        .await;
        let request = fixture_request(url, address, Operation::Get, TEST_SECRET, 64, 64);
        assert_eq!(
            perform_fetch(request).await,
            Err(FetchError::UnsupportedContentEncoding)
        );
        server.await.expect("fixture task succeeds");

        let (url, address, server) = start_http_fixture(|_| async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            HttpResponse::new(Full::new(Bytes::from_static(br#"{"ok":true}"#)))
        })
        .await;
        let mut request = fixture_request(url, address, Operation::Get, TEST_SECRET, 1024, 1024);
        request.deadline = Instant::now() + Duration::from_millis(20);

        assert_eq!(
            execute_fetch(request).await,
            Err(FetchError::DeadlineExpired)
        );
        server.abort();
    }

    #[tokio::test]
    async fn rejects_direct_and_encoded_credential_echoes() {
        for body in [
            TEST_SECRET.as_bytes().to_vec(),
            BASE64.encode(TEST_SECRET).into_bytes(),
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(TEST_SECRET)
                .into_bytes(),
        ] {
            let (url, address, server) = start_http_fixture(move |_| {
                let body = body.clone();
                async move { HttpResponse::new(Full::new(Bytes::from(body))) }
            })
            .await;
            let request = fixture_request(url, address, Operation::Get, TEST_SECRET, 1024, 1024);
            assert_eq!(
                perform_fetch(request).await,
                Err(FetchError::CredentialExposed)
            );
            server.await.expect("fixture task succeeds");
        }
    }

    #[tokio::test]
    async fn private_fixture_is_denied_before_any_connection() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("fixture binds");
        let request = request_json("https://127.0.0.1/", "127.0.0.1");

        assert_eq!(
            parse_request(&serde_json::to_vec(&request).unwrap()),
            Err(FetchError::DestinationNotPublic)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "live production-transport evidence; run explicitly"]
    async fn live_approved_api_uses_pinned_tls() {
        let addresses = tokio::net::lookup_host(("api.github.com", 443))
            .await
            .expect("approved API resolves")
            .map(|socket| socket.ip())
            .collect::<Vec<_>>();
        assert!(!addresses.is_empty());
        assert!(addresses.iter().all(|address| is_globally_public(*address)));
        let address = addresses
            .iter()
            .copied()
            .find(IpAddr::is_ipv4)
            .unwrap_or(addresses[0]);
        let request = fixture_request(
            Url::parse("https://api.github.com/rate_limit").unwrap(),
            address,
            Operation::Get,
            TEST_SECRET,
            MAX_RESPONSE_BYTES,
            MAX_RESPONSE_BYTES,
        );
        let response = execute_fetch(request)
            .await
            .expect("approved API request succeeds");

        assert_eq!(response.status, 200);
        assert!(!response.body_base64.contains(TEST_SECRET));

        let mismatch = fixture_request(
            Url::parse("https://certificate-mismatch.invalid/rate_limit").unwrap(),
            address,
            Operation::Get,
            TEST_SECRET,
            MAX_RESPONSE_BYTES,
            MAX_RESPONSE_BYTES,
        );
        assert_eq!(
            execute_fetch(mismatch).await,
            Err(FetchError::RequestFailed)
        );
    }

    fn request_json(url: &str, address: &str) -> serde_json::Value {
        serde_json::json!({
            "address": address,
            "authentication": { "kind": "bearer", "value": TEST_SECRET },
            "operation": { "kind": "get", "url": url },
            "timeoutMs": 2_000,
            "maxWireBytes": 1024,
            "maxDecodedBytes": 1024,
        })
    }

    fn fixture_request(
        url: Url,
        address: IpAddr,
        operation: Operation,
        secret: &str,
        max_wire_bytes: usize,
        max_decoded_bytes: usize,
    ) -> FetchRequest {
        FetchRequest {
            url,
            address,
            authentication: Authentication::Header {
                name: HeaderName::from_static("x-satyr-probe-key"),
                value: secret.to_owned(),
            },
            operation,
            idempotency: None,
            max_wire_bytes,
            max_decoded_bytes,
            deadline: Instant::now() + Duration::from_secs(5),
        }
    }

    async fn start_http_fixture<F, Fut>(handler: F) -> (Url, IpAddr, tokio::task::JoinHandle<()>)
    where
        F: Fn(Request<Incoming>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = HttpResponse<Full<Bytes>>> + Send + 'static,
    {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("fixture binds");
        let address = listener.local_addr().expect("fixture address exists");
        let handler = Arc::new(handler);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("fixture accepts");
            let handler = Arc::clone(&handler);
            let service = service_fn(move |request| {
                let handler = Arc::clone(&handler);
                async move { Ok::<_, Infallible>(handler(request).await) }
            });
            http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
                .expect("fixture serves request");
        });
        let url = Url::parse(&format!(
            "http://reviewed-host.invalid:{}/v1/test",
            address.port()
        ))
        .expect("fixture URL parses");

        (url, address.ip(), server)
    }

    async fn start_raw_http_fixture(
        response: &'static [u8],
    ) -> (Url, IpAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("fixture binds");
        let address = listener.local_addr().expect("fixture address exists");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("fixture accepts");
            let mut request = [0_u8; 4096];
            let _ = stream
                .read(&mut request)
                .await
                .expect("fixture reads request");
            stream
                .write_all(response)
                .await
                .expect("fixture writes response");
            stream.shutdown().await.expect("fixture closes response");
        });
        let url = Url::parse(&format!(
            "http://reviewed-host.invalid:{}/v1/test",
            address.port()
        ))
        .expect("fixture URL parses");

        (url, address.ip(), server)
    }
}
