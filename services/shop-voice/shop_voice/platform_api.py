"""The calls of the Mac to the Platform. The Platform never calls the Mac."""
import json
import urllib.error
import urllib.request

from . import VERSION

TIMEOUT_SECONDS = 20


class PlatformRefused(Exception):
    """The Platform answered with this status and error code."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code


def _call(origin: str, method: str, route: str, credential: str | None, body: dict | None) -> dict:
    headers = {"User-Agent": f"pantry-shop-voice/{VERSION}", "Content-Type": "application/json"}
    if credential is not None:
        headers["Authorization"] = f"Bearer {credential}"
    request = urllib.request.Request(f"{origin}/v1/voice-macs/{route}", method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            code = str(json.load(error).get("error", "unknown"))
        except ValueError:
            code = "unknown"
        raise PlatformRefused(error.code, code) from None


def enroll(origin: str, organisation_id: str, mac_id: str, code: str) -> dict:
    return _call(origin, "POST", "enroll", None, {"organisationId": organisation_id, "macId": mac_id, "code": code})


def heartbeat(origin: str, credential: str, address: str, model_state: str, engine: str,
              engines: list[str]) -> dict:
    """The answer names the engine that a manager chose (`engineChoice`)."""
    return _call(origin, "POST", "heartbeat", credential,
                 {"privateAddress": address, "serviceVersion": VERSION, "modelState": model_state, "engine": engine,
                  "engines": engines})


def vocabulary(origin: str, credential: str) -> list[str]:
    return _call(origin, "GET", "vocabulary", credential, None)["terms"]


def put_challenge(origin: str, credential: str, value: str) -> None:
    _call(origin, "PUT", "certificate-challenge", credential, {"value": value})


def delete_challenge(origin: str, credential: str) -> None:
    _call(origin, "DELETE", "certificate-challenge", credential, None)
