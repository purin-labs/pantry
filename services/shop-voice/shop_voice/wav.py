"""A command is a RIFF WAV file with 16-bit PCM, 16 kHz and one channel."""
import struct

SAMPLE_RATE = 16_000
AUDIO_SECONDS_LIMIT = 15
BYTES_PER_SECOND = SAMPLE_RATE * 2
# Room for a header with a few extra chunks around the longest command.
BODY_BYTE_LIMIT = AUDIO_SECONDS_LIMIT * BYTES_PER_SECOND + 1024


class AudioInvalid(Exception):
    pass


class AudioTooLong(Exception):
    pass


def read_pcm(body: bytes) -> bytes:
    """The PCM bytes of the same files that the Platform's fallback route takes."""
    if len(body) < 44 or body[:4] != b"RIFF" or body[8:12] != b"WAVE":
        raise AudioInvalid
    has_format = False
    at = 12
    while at + 8 <= len(body):
        name = body[at:at + 4]
        size = struct.unpack_from("<I", body, at + 4)[0]
        if name == b"fmt ":
            if size < 16 or at + 24 > len(body):
                raise AudioInvalid
            encoding, channels, rate = struct.unpack_from("<HHI", body, at + 8)
            bits = struct.unpack_from("<H", body, at + 22)[0]
            if encoding != 1 or channels != 1 or rate != SAMPLE_RATE or bits != 16:
                raise AudioInvalid
            has_format = True
        if name == b"data":
            if not has_format or size == 0 or at + 8 + size > len(body):
                raise AudioInvalid
            if size > AUDIO_SECONDS_LIMIT * BYTES_PER_SECOND:
                raise AudioTooLong
            return body[at + 8:at + 8 + size]
        at += 8 + size + size % 2
    raise AudioInvalid
