"""The check of a voice grant, with no call to the Platform.

The Platform's surfaces/voice/server/grant.ts signs `vg1.<payload>.<signature>`.
"""
import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Grant:
    user_id: str
    device_id: str


def decode_base64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def check_grant(token: str, grant_key: str, organisation_id: str, mac_id: str) -> Grant | None:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "vg1":
        return None
    try:
        signature = decode_base64url(parts[2])
        expected = hmac.new(decode_base64url(grant_key), f"vg1.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return None
        claims = json.loads(decode_base64url(parts[1]))
    except ValueError:
        return None
    if (claims.get("version") != 1 or claims.get("organisationId") != organisation_id
            or claims.get("macId") != mac_id or not isinstance(claims.get("expiresAt"), int)
            or claims["expiresAt"] <= time.time() * 1000
            or not isinstance(claims.get("userId"), str) or not isinstance(claims.get("deviceId"), str)):
        return None
    return Grant(user_id=claims["userId"], device_id=claims["deviceId"])
