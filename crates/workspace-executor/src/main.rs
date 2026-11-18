use std::{convert::Infallible, net::SocketAddr, time::SystemTime};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    Method, Request, Response, StatusCode,
    body::Incoming,
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::net::TcpListener;
use workspace_executor::{
    ENVELOPE_HEADER_BYTES, MAX_ATTACHMENT_BYTES, MAX_REQUEST_BYTES, WorkspaceExecutorErrorCode,
    execute_envelope,
};

const LISTEN_ADDRESS: &str = "0.0.0.0:8080";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetail {
    code: WorkspaceExecutorErrorCode,
    message: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address: SocketAddr = LISTEN_ADDRESS.parse()?;
    let listener = TcpListener::bind(address).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        tokio::task::spawn(async move {
            if let Err(error) = http1::Builder::new()
                .serve_connection(io, service_fn(handle_request))
                .await
            {
                eprintln!("workspace executor connection failed: {error}");
            }
        });
    }
}

async fn handle_request(request: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let response = match (request.method(), request.uri().path()) {
        (&Method::GET, "/health") => json_response(StatusCode::OK, br#"{"status":"ok"}"#.to_vec()),
        (&Method::POST, "/v1/execute-envelope") => execute_envelope_request(request).await,
        _ => empty_response(StatusCode::NOT_FOUND),
    };
    Ok(response)
}

/// The binary path: an 8-byte JSON length, the JSON request, then raw bytes.
///
/// Bytes stay out of the JSON deliberately. Base64 inside a document inflates
/// by a third and forces both ends to hold the whole thing as a string, which
/// is what keeps attachment inspection off the JSON entry point entirely.
async fn execute_envelope_request(request: Request<Incoming>) -> Response<Full<Bytes>> {
    if request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/octet-stream")
    {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            WorkspaceExecutorErrorCode::InvalidRequest,
            "content type must be application/octet-stream",
        );
    }

    let limit = ENVELOPE_HEADER_BYTES + MAX_REQUEST_BYTES + MAX_ATTACHMENT_BYTES;

    if content_length_exceeds(&request, limit) {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            WorkspaceExecutorErrorCode::InputTooLarge,
            "workspace executor envelope exceeds the byte limit",
        );
    }

    let body = match read_body_bounded_to(request.into_body(), limit).await {
        Ok(body) => body,
        Err(code) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                code,
                "workspace executor envelope exceeds the byte limit",
            );
        }
    };

    match execute_envelope(&body, SystemTime::now()) {
        Ok(result) => match serde_json::to_vec(&result) {
            Ok(body) => json_response(StatusCode::OK, body),
            Err(_) => error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                WorkspaceExecutorErrorCode::InternalFailure,
                "workspace executor failed internally",
            ),
        },
        Err(error) => error_response(error_status(error.code()), error.code(), error.message()),
    }
}

fn content_length_exceeds(request: &Request<Incoming>, limit: usize) -> bool {
    request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|value| value > limit)
}

async fn read_body_bounded_to(
    mut body: Incoming,
    limit: usize,
) -> Result<Vec<u8>, WorkspaceExecutorErrorCode> {
    let mut output = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| WorkspaceExecutorErrorCode::InvalidRequest)?;
        if let Some(data) = frame.data_ref() {
            if output.len().saturating_add(data.len()) > limit {
                return Err(WorkspaceExecutorErrorCode::InputTooLarge);
            }
            output.extend_from_slice(data);
        }
    }
    Ok(output)
}

fn error_status(code: WorkspaceExecutorErrorCode) -> StatusCode {
    match code {
        WorkspaceExecutorErrorCode::InputTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        WorkspaceExecutorErrorCode::DeadlineExpired => StatusCode::REQUEST_TIMEOUT,
        WorkspaceExecutorErrorCode::InternalFailure => StatusCode::INTERNAL_SERVER_ERROR,
        WorkspaceExecutorErrorCode::AttachmentDigestMismatch
        | WorkspaceExecutorErrorCode::InvalidRequest
        | WorkspaceExecutorErrorCode::DeadlineTooFarAhead => StatusCode::BAD_REQUEST,
    }
}

fn error_response(
    status: StatusCode,
    code: WorkspaceExecutorErrorCode,
    message: &'static str,
) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(&ErrorBody {
        error: ErrorDetail { code, message },
    })
    .unwrap_or_else(|_| {
        br#"{"error":{"code":"internal_failure","message":"workspace executor failed internally"}}"#
            .to_vec()
    });
    json_response(status, body)
}

fn json_response(status: StatusCode, body: Vec<u8>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .expect("static workspace executor response is valid")
}

fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .expect("static workspace executor response is valid")
}
