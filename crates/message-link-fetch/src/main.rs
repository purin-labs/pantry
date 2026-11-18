use std::{convert::Infallible, net::SocketAddr, sync::Arc};

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
use message_link_fetch::{
    FetchError, MAX_CONCURRENT_FETCHES, MAX_DEADLINE, MAX_REQUEST_BYTES, execute_fetch,
    parse_request,
};
use serde::Serialize;
use tokio::{net::TcpListener, sync::Semaphore};

const LISTEN_ADDRESS: &str = "0.0.0.0:8080";

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address: SocketAddr = LISTEN_ADDRESS.parse()?;
    let listener = TcpListener::bind(address).await?;
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_FETCHES));

    loop {
        let (stream, _) = listener.accept().await?;
        let permits = Arc::clone(&permits);
        let io = TokioIo::new(stream);

        tokio::task::spawn(async move {
            let service = service_fn(move |request| handle_request(request, Arc::clone(&permits)));

            if http1::Builder::new()
                .serve_connection(io, service)
                .await
                .is_err()
            {
                // Keep operational logs free of request URLs and upstream
                // error details. The platform only needs the health endpoint
                // and the generic HTTP failure status.
                eprintln!("message link fetch connection failed");
            }
        });
    }
}

async fn handle_request(
    request: Request<Incoming>,
    permits: Arc<Semaphore>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let response = match (request.method(), request.uri().path()) {
        (&Method::GET, "/health") => json_response(StatusCode::OK, br#"{"status":"ok"}"#.to_vec()),
        (&Method::POST, "/v1/fetch") => fetch_request(request, permits).await,
        _ => empty_response(StatusCode::NOT_FOUND),
    };

    Ok(response)
}

async fn fetch_request(
    request: Request<Incoming>,
    permits: Arc<Semaphore>,
) -> Response<Full<Bytes>> {
    let _permit = match permits.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "busy"),
    };

    if request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/json")
    {
        return error_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_request");
    }

    if let Some(length) = request.headers().get(CONTENT_LENGTH) {
        let Ok(length) = length.to_str().unwrap_or_default().parse::<usize>() else {
            return error_response(StatusCode::BAD_REQUEST, "invalid_request");
        };

        if length > MAX_REQUEST_BYTES {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large");
        }
    }

    let body = match tokio::time::timeout(MAX_DEADLINE, read_bounded_body(request.into_body()))
        .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(FetchError::RequestTooLarge)) => {
            return error_response(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large");
        }
        Ok(Err(_)) | Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid_request"),
    };

    let request = match parse_request(&body, std::time::SystemTime::now()) {
        Ok(request) => request,
        Err(error) => return error_response(error_status(&error), error_key(&error)),
    };

    match execute_fetch(request).await {
        Ok(result) => match serde_json::to_vec(&result) {
            Ok(body) => json_response(StatusCode::OK, body),
            Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed"),
        },
        Err(error) => error_response(error_status(&error), error_key(&error)),
    }
}

async fn read_bounded_body(mut body: Incoming) -> Result<Vec<u8>, FetchError> {
    let mut output = Vec::new();

    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| FetchError::InvalidRequest)?;

        if let Some(data) = frame.data_ref() {
            if output.len().saturating_add(data.len()) > MAX_REQUEST_BYTES {
                return Err(FetchError::RequestTooLarge);
            }
            output.extend_from_slice(data);
        }
    }

    Ok(output)
}

fn error_status(error: &FetchError) -> StatusCode {
    match error {
        FetchError::InvalidRequest
        | FetchError::AddressMismatch
        | FetchError::DestinationNotPublic => StatusCode::BAD_REQUEST,
        FetchError::DeadlineExpired => StatusCode::REQUEST_TIMEOUT,
        FetchError::DeadlineTooFarAhead => StatusCode::BAD_REQUEST,
        FetchError::RequestTooLarge | FetchError::ResponseTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        FetchError::UnsupportedContentEncoding
        | FetchError::UpstreamStatus
        | FetchError::RequestFailed => StatusCode::BAD_GATEWAY,
    }
}

fn error_key(error: &FetchError) -> &'static str {
    match error {
        FetchError::InvalidRequest | FetchError::AddressMismatch => "invalid_request",
        FetchError::DestinationNotPublic => "destination_not_public",
        FetchError::DeadlineExpired => "deadline_expired",
        FetchError::DeadlineTooFarAhead => "deadline_too_far_ahead",
        FetchError::RequestTooLarge => "request_too_large",
        FetchError::ResponseTooLarge => "response_too_large",
        FetchError::UnsupportedContentEncoding
        | FetchError::UpstreamStatus
        | FetchError::RequestFailed => "fetch_failed",
    }
}

fn error_response(status: StatusCode, error: &'static str) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(&ErrorBody { error })
        .unwrap_or_else(|_| br#"{"error":"fetch_failed"}"#.to_vec());
    json_response(status, body)
}

fn json_response(status: StatusCode, body: Vec<u8>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .expect("static JSON response is valid")
}

fn empty_response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .expect("static empty response is valid")
}
