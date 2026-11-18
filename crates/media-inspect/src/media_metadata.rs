//! Deterministic technical metadata for audio and video containers.
//!
//! Every fact here comes from parsing container headers. Nothing is decoded,
//! nothing is transcribed, and no claim is made about what a file depicts or
//! says. Audio in particular yields container, codec, channel, and duration
//! facts and nothing more — speech transcription and semantic speech claims are
//! outside this crate and outside the plan.
//!
//! Parsing is bounded and header-only, so the caller reads a small prefix of the
//! object rather than moving the whole file. A fact that is not present in that
//! prefix is reported absent rather than guessed: an MP4 whose `moov` box sits
//! after the media data yields its container and nothing else, which is the
//! honest answer for the bytes that were read.

use serde::Serialize;

/// Bytes a caller should read for header inspection to be worthwhile.
pub const MEDIA_METADATA_HEADER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaContainer {
    IsoBaseMedia,
    Matroska,
    Riff,
    Ogg,
    Flac,
    Mpeg,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTrackMetadata {
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackMetadata {
    pub codec: Option<String>,
    pub channels: Option<u32>,
    pub sample_rate_hz: Option<u32>,
}

/// What the container header said, with every uncertain field absent rather
/// than defaulted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub container: MediaContainer,
    pub duration_ms: Option<u64>,
    pub video: Option<VideoTrackMetadata>,
    pub audio: Option<AudioTrackMetadata>,
    /// True when the header prefix did not contain the metadata box, so the
    /// absent fields mean "not in the bytes read", not "not in the file".
    pub header_incomplete: bool,
}

impl MediaMetadata {
    fn container_only(container: MediaContainer, header_incomplete: bool) -> Self {
        Self {
            container,
            duration_ms: None,
            video: None,
            audio: None,
            header_incomplete,
        }
    }
}

/// Inspects a bounded header prefix.
pub fn inspect_media_metadata(header: &[u8]) -> MediaMetadata {
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        return inspect_iso_base_media(header);
    }

    if header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        // Matroska is EBML-encoded; its container is identifiable from the magic
        // alone, and the track facts need a full EBML walk this parser does not
        // attempt. Reporting the container honestly beats guessing.
        return MediaMetadata::container_only(MediaContainer::Matroska, true);
    }

    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WAVE" {
        return inspect_wave(header);
    }

    if header.starts_with(b"fLaC") {
        return inspect_flac(header);
    }

    if header.starts_with(b"OggS") {
        return inspect_ogg(header);
    }

    if header.starts_with(b"ID3") || matches!(header, [0xff, second, ..] if second & 0xe0 == 0xe0) {
        return inspect_mpeg_audio(header);
    }

    MediaMetadata::container_only(MediaContainer::Unknown, false)
}

// ---------------------------------------------------------------------------
// ISO base media (MP4, M4A, MOV)
// ---------------------------------------------------------------------------

fn inspect_iso_base_media(header: &[u8]) -> MediaMetadata {
    let Some(moov) = find_box(header, b"moov") else {
        // `moov` commonly trails the media data in a non-faststart file.
        return MediaMetadata::container_only(MediaContainer::IsoBaseMedia, true);
    };

    let duration_ms = find_box(moov, b"mvhd").and_then(read_mvhd_duration_ms);
    let mut video: Option<VideoTrackMetadata> = None;
    let mut audio: Option<AudioTrackMetadata> = None;

    for track in child_boxes(moov, b"trak") {
        let handler = find_box(track, b"hdlr").and_then(read_hdlr_type);
        let sample_entry = find_box(track, b"stsd").and_then(read_stsd_entry);

        match handler.as_deref() {
            Some("vide") => {
                let dimensions = find_box(track, b"tkhd").and_then(read_tkhd_dimensions);
                video = Some(VideoTrackMetadata {
                    codec: sample_entry.map(|entry| entry.format),
                    width: dimensions.map(|(width, _)| width),
                    height: dimensions.map(|(_, height)| height),
                });
            }
            Some("soun") => {
                audio = Some(AudioTrackMetadata {
                    codec: sample_entry.as_ref().map(|entry| entry.format.clone()),
                    channels: sample_entry.as_ref().and_then(|entry| entry.channels),
                    sample_rate_hz: sample_entry.as_ref().and_then(|entry| entry.sample_rate_hz),
                });
            }
            _ => {}
        }
    }

    MediaMetadata {
        container: MediaContainer::IsoBaseMedia,
        duration_ms,
        video,
        audio,
        header_incomplete: false,
    }
}

/// Finds the first box with `name` anywhere in the tree rooted at `data`.
fn find_box<'a>(data: &'a [u8], name: &[u8; 4]) -> Option<&'a [u8]> {
    for (box_name, body) in top_level_boxes(data) {
        if &box_name == name {
            return Some(body);
        }

        // Container boxes nest; recurse only into the ones that can.
        if is_container_box(&box_name) {
            if let Some(found) = find_box(body, name) {
                return Some(found);
            }
        }
    }

    None
}

fn child_boxes<'a>(data: &'a [u8], name: &[u8; 4]) -> Vec<&'a [u8]> {
    top_level_boxes(data)
        .into_iter()
        .filter_map(|(box_name, body)| (&box_name == name).then_some(body))
        .collect()
}

fn is_container_box(name: &[u8; 4]) -> bool {
    matches!(
        name,
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"edts"
    )
}

fn top_level_boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut boxes = Vec::new();
    let mut offset = 0usize;

    while offset + 8 <= data.len() {
        let size = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        let mut name = [0u8; 4];
        name.copy_from_slice(&data[offset + 4..offset + 8]);

        // Size 0 means "to end of file"; size 1 means a 64-bit size follows.
        let body_start = if size == 1 { offset + 16 } else { offset + 8 };
        let body_end = if size == 0 || size == 1 {
            data.len()
        } else {
            offset.saturating_add(size).min(data.len())
        };

        if body_start > body_end || body_start > data.len() {
            break;
        }

        boxes.push((name, &data[body_start..body_end]));

        if size <= 8 {
            break;
        }

        offset += size;
    }

    boxes
}

fn read_mvhd_duration_ms(body: &[u8]) -> Option<u64> {
    let version = *body.first()?;
    let (timescale, duration) = if version == 1 {
        (
            u32::from_be_bytes(body.get(20..24)?.try_into().ok()?) as u64,
            u64::from_be_bytes(body.get(24..32)?.try_into().ok()?),
        )
    } else {
        (
            u32::from_be_bytes(body.get(12..16)?.try_into().ok()?) as u64,
            u32::from_be_bytes(body.get(16..20)?.try_into().ok()?) as u64,
        )
    };

    if timescale == 0 {
        return None;
    }

    Some(duration.saturating_mul(1_000) / timescale)
}

fn read_tkhd_dimensions(body: &[u8]) -> Option<(u32, u32)> {
    let version = *body.first()?;
    let offset = if version == 1 { 88 } else { 76 };
    // Width and height are 16.16 fixed point.
    let width = u32::from_be_bytes(body.get(offset..offset + 4)?.try_into().ok()?) >> 16;
    let height = u32::from_be_bytes(body.get(offset + 4..offset + 8)?.try_into().ok()?) >> 16;

    Some((width, height))
}

fn read_hdlr_type(body: &[u8]) -> Option<String> {
    let handler = body.get(8..12)?;

    std::str::from_utf8(handler).ok().map(str::to_string)
}

struct SampleEntry {
    format: String,
    channels: Option<u32>,
    sample_rate_hz: Option<u32>,
}

fn read_stsd_entry(body: &[u8]) -> Option<SampleEntry> {
    // version(1) flags(3) entry_count(4), then the first entry.
    let entry = body.get(8..)?;
    let format = std::str::from_utf8(entry.get(4..8)?)
        .ok()?
        .trim()
        .to_string();
    // Audio sample entries carry channel count and sample rate after the
    // 8-byte header plus a 20-byte reserved region.
    let channels = entry
        .get(24..26)
        .and_then(|slice| slice.try_into().ok())
        .map(|bytes| u16::from_be_bytes(bytes) as u32);
    let sample_rate_hz = entry
        .get(32..34)
        .and_then(|slice| slice.try_into().ok())
        .map(|bytes| u16::from_be_bytes(bytes) as u32);

    Some(SampleEntry {
        format,
        channels: channels.filter(|value| *value > 0 && *value <= 64),
        sample_rate_hz: sample_rate_hz.filter(|value| *value >= 8_000),
    })
}

// ---------------------------------------------------------------------------
// RIFF / WAVE
// ---------------------------------------------------------------------------

fn inspect_wave(header: &[u8]) -> MediaMetadata {
    let mut offset = 12usize;
    let mut channels = None;
    let mut sample_rate_hz = None;
    let mut byte_rate = None;
    let mut data_bytes = None;

    while offset + 8 <= header.len() {
        let chunk_id = &header[offset..offset + 4];
        let size = u32::from_le_bytes([
            header[offset + 4],
            header[offset + 5],
            header[offset + 6],
            header[offset + 7],
        ]) as usize;
        let body = header.get(offset + 8..(offset + 8 + size).min(header.len()));

        if chunk_id == b"fmt " {
            if let Some(body) = body {
                channels = body
                    .get(2..4)
                    .and_then(|slice| slice.try_into().ok())
                    .map(|bytes| u16::from_le_bytes(bytes) as u32);
                sample_rate_hz = body
                    .get(4..8)
                    .and_then(|slice| slice.try_into().ok())
                    .map(u32::from_le_bytes);
                byte_rate = body
                    .get(8..12)
                    .and_then(|slice| slice.try_into().ok())
                    .map(u32::from_le_bytes);
            }
        }

        if chunk_id == b"data" {
            data_bytes = Some(size as u64);
            break;
        }

        // Chunks are word-aligned.
        offset += 8 + size + (size % 2);
    }

    let duration_ms = match (data_bytes, byte_rate) {
        (Some(bytes), Some(rate)) if rate > 0 => Some(bytes.saturating_mul(1_000) / rate as u64),
        _ => None,
    };

    MediaMetadata {
        container: MediaContainer::Riff,
        duration_ms,
        video: None,
        audio: Some(AudioTrackMetadata {
            codec: Some("pcm".to_string()),
            channels,
            sample_rate_hz,
        }),
        header_incomplete: false,
    }
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

fn inspect_flac(header: &[u8]) -> MediaMetadata {
    // STREAMINFO is always the first metadata block, at a fixed offset.
    let Some(info) = header.get(8..26) else {
        return MediaMetadata::container_only(MediaContainer::Flac, true);
    };

    let sample_rate_hz =
        (u32::from(info[10]) << 12) | (u32::from(info[11]) << 4) | (u32::from(info[12]) >> 4);
    let channels = ((info[12] >> 1) & 0x07) as u32 + 1;
    let total_samples = ((u64::from(info[13]) & 0x0f) << 32)
        | (u64::from(info[14]) << 24)
        | (u64::from(info[15]) << 16)
        | (u64::from(info[16]) << 8)
        | u64::from(info[17]);

    MediaMetadata {
        container: MediaContainer::Flac,
        duration_ms: (sample_rate_hz > 0 && total_samples > 0)
            .then(|| total_samples.saturating_mul(1_000) / u64::from(sample_rate_hz)),
        video: None,
        audio: Some(AudioTrackMetadata {
            codec: Some("flac".to_string()),
            channels: Some(channels),
            sample_rate_hz: (sample_rate_hz > 0).then_some(sample_rate_hz),
        }),
        header_incomplete: false,
    }
}

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

fn inspect_ogg(header: &[u8]) -> MediaMetadata {
    let codec = if contains(header, b"OpusHead") {
        Some("opus")
    } else if contains(header, b"vorbis") {
        Some("vorbis")
    } else if contains(header, b"FLAC") {
        Some("flac")
    } else {
        None
    };

    // Opus states its channel count and input sample rate in OpusHead.
    let audio = match find_offset(header, b"OpusHead") {
        Some(offset) => AudioTrackMetadata {
            codec: codec.map(str::to_string),
            channels: header.get(offset + 9).map(|value| u32::from(*value)),
            sample_rate_hz: header
                .get(offset + 12..offset + 16)
                .and_then(|slice| slice.try_into().ok())
                .map(u32::from_le_bytes),
        },
        None => AudioTrackMetadata {
            codec: codec.map(str::to_string),
            channels: None,
            sample_rate_hz: None,
        },
    };

    MediaMetadata {
        container: MediaContainer::Ogg,
        // Ogg duration needs the final page's granule position, which is at the
        // end of the file rather than in a header prefix.
        duration_ms: None,
        video: None,
        audio: Some(audio),
        header_incomplete: true,
    }
}

// ---------------------------------------------------------------------------
// MPEG audio
// ---------------------------------------------------------------------------

const MPEG1_LAYER3_BITRATES: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG1_SAMPLE_RATES: [u32; 4] = [44_100, 48_000, 32_000, 0];

fn inspect_mpeg_audio(header: &[u8]) -> MediaMetadata {
    let start = if header.starts_with(b"ID3") {
        // ID3v2 stores its size as four sync-safe bytes.
        match header.get(6..10) {
            Some(size) => {
                10 + (((u32::from(size[0]) & 0x7f) << 21)
                    | ((u32::from(size[1]) & 0x7f) << 14)
                    | ((u32::from(size[2]) & 0x7f) << 7)
                    | (u32::from(size[3]) & 0x7f)) as usize
            }
            None => return MediaMetadata::container_only(MediaContainer::Mpeg, true),
        }
    } else {
        0
    };

    let Some(frame) = header.get(start..start + 4) else {
        return MediaMetadata::container_only(MediaContainer::Mpeg, true);
    };

    if frame[0] != 0xff || frame[1] & 0xe0 != 0xe0 {
        return MediaMetadata::container_only(MediaContainer::Mpeg, true);
    }

    let sample_rate_hz = MPEG1_SAMPLE_RATES[((frame[2] >> 2) & 0x03) as usize];
    let channel_mode = (frame[3] >> 6) & 0x03;
    let channels = if channel_mode == 3 { 1 } else { 2 };
    let bitrate_kbps = MPEG1_LAYER3_BITRATES[((frame[2] >> 4) & 0x0f) as usize];

    MediaMetadata {
        container: MediaContainer::Mpeg,
        // A constant-bitrate duration needs the total byte length, which the
        // caller has but this parser is not given.
        duration_ms: None,
        video: None,
        audio: Some(AudioTrackMetadata {
            codec: Some(if bitrate_kbps > 0 {
                format!("mp3@{bitrate_kbps}kbps")
            } else {
                "mp3".to_string()
            }),
            channels: Some(channels),
            sample_rate_hz: (sample_rate_hz > 0).then_some(sample_rate_hz),
        }),
        header_incomplete: true,
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_offset(haystack, needle).is_some()
}

fn find_offset(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }

    (0..=haystack.len() - needle.len())
        .find(|index| &haystack[*index..*index + needle.len()] == needle)
}

#[cfg_attr(
    all(target_arch = "wasm32", feature = "wasm-bindings"),
    wasm_bindgen::prelude::wasm_bindgen(js_name = inspectMediaMetadata)
)]
pub fn inspect_media_metadata_wasm(header: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&inspect_media_metadata(header)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso_box(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(name);
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn an_mp4_header_yields_duration_and_dimensions() {
        // mvhd v0: version+flags, ctime, mtime, timescale, duration.
        let mut mvhd = vec![0u8; 20];
        mvhd[12..16].copy_from_slice(&1_000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&5_500u32.to_be_bytes());

        let mut tkhd = vec![0u8; 84];
        tkhd[76..80].copy_from_slice(&(1_920u32 << 16).to_be_bytes());
        tkhd[80..84].copy_from_slice(&(1_080u32 << 16).to_be_bytes());

        let mut hdlr = vec![0u8; 12];
        hdlr[8..12].copy_from_slice(b"vide");

        let mut stsd = vec![0u8; 8];
        stsd.extend_from_slice(&[0, 0, 0, 0]);
        stsd.extend_from_slice(b"avc1");

        let mut trak = iso_box(b"tkhd", &tkhd);
        trak.extend(iso_box(b"hdlr", &hdlr));
        trak.extend(iso_box(b"stbl", &iso_box(b"stsd", &stsd)));

        let mut moov = iso_box(b"mvhd", &mvhd);
        moov.extend(iso_box(b"trak", &trak));

        let mut file = iso_box(b"ftyp", b"isom\0\0\0\0isom");
        file.extend(iso_box(b"moov", &moov));

        let metadata = inspect_media_metadata(&file);

        assert_eq!(metadata.container, MediaContainer::IsoBaseMedia);
        assert_eq!(metadata.duration_ms, Some(5_500));
        assert_eq!(
            metadata.video,
            Some(VideoTrackMetadata {
                codec: Some("avc1".to_string()),
                width: Some(1_920),
                height: Some(1_080)
            })
        );
        assert!(!metadata.header_incomplete);
    }

    #[test]
    fn an_mp4_without_a_leading_moov_says_so_rather_than_guessing() {
        let file = iso_box(b"ftyp", b"isom\0\0\0\0isom");
        let metadata = inspect_media_metadata(&file);

        assert_eq!(metadata.container, MediaContainer::IsoBaseMedia);
        assert_eq!(metadata.duration_ms, None);
        assert!(metadata.header_incomplete);
    }

    #[test]
    fn a_wave_header_yields_channels_rate_and_duration() {
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&0u32.to_le_bytes());
        file.extend_from_slice(b"WAVE");
        file.extend_from_slice(b"fmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&44_100u32.to_le_bytes());
        file.extend_from_slice(&176_400u32.to_le_bytes());
        file.extend_from_slice(&4u16.to_le_bytes());
        file.extend_from_slice(&16u16.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&352_800u32.to_le_bytes());

        let metadata = inspect_media_metadata(&file);

        assert_eq!(metadata.container, MediaContainer::Riff);
        assert_eq!(metadata.duration_ms, Some(2_000));
        assert_eq!(
            metadata.audio,
            Some(AudioTrackMetadata {
                codec: Some("pcm".to_string()),
                channels: Some(2),
                sample_rate_hz: Some(44_100)
            })
        );
    }

    #[test]
    fn a_flac_streaminfo_yields_rate_channels_and_duration() {
        let mut file = b"fLaC".to_vec();
        file.extend_from_slice(&[0x00, 0x00, 0x00, 0x22]);

        let mut info = vec![0u8; 18];
        // 44100 Hz across 20 bits, 2 channels, 88200 total samples.
        info[10] = 0x0a;
        info[11] = 0xc4;
        info[12] = 0x42;
        info[13] = 0x00;
        info[14] = 0x00;
        info[15] = 0x01;
        info[16] = 0x58;
        info[17] = 0x88;
        file.extend_from_slice(&info);

        let metadata = inspect_media_metadata(&file);
        let audio = metadata.audio.expect("audio track");

        assert_eq!(metadata.container, MediaContainer::Flac);
        assert_eq!(audio.sample_rate_hz, Some(44_100));
        assert_eq!(audio.channels, Some(2));
        assert_eq!(metadata.duration_ms, Some(2_000));
    }

    #[test]
    fn an_opus_stream_reports_its_channels_without_decoding() {
        let mut file = b"OggS".to_vec();
        file.extend_from_slice(&[0u8; 22]);
        file.extend_from_slice(b"OpusHead");
        file.push(1);
        file.push(2);
        file.extend_from_slice(&0u16.to_le_bytes());
        file.extend_from_slice(&48_000u32.to_le_bytes());

        let metadata = inspect_media_metadata(&file);
        let audio = metadata.audio.expect("audio track");

        assert_eq!(metadata.container, MediaContainer::Ogg);
        assert_eq!(audio.codec.as_deref(), Some("opus"));
        assert_eq!(audio.channels, Some(2));
        assert_eq!(audio.sample_rate_hz, Some(48_000));
        // Ogg duration lives in the final page, not the header.
        assert!(metadata.header_incomplete);
    }

    #[test]
    fn an_mp3_frame_yields_rate_and_channel_mode() {
        // MPEG1 Layer3, 128 kbps, 44.1 kHz, joint stereo.
        let file = [0xff, 0xfb, 0x90, 0x44, 0x00, 0x00];
        let metadata = inspect_media_metadata(&file);
        let audio = metadata.audio.expect("audio track");

        assert_eq!(metadata.container, MediaContainer::Mpeg);
        assert_eq!(audio.sample_rate_hz, Some(44_100));
        assert_eq!(audio.channels, Some(2));
        assert_eq!(audio.codec.as_deref(), Some("mp3@128kbps"));
    }

    #[test]
    fn matroska_is_named_without_pretending_to_read_its_tracks() {
        let metadata = inspect_media_metadata(&[0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

        assert_eq!(metadata.container, MediaContainer::Matroska);
        assert_eq!(metadata.video, None);
        assert!(metadata.header_incomplete);
    }

    #[test]
    fn unrecognized_bytes_claim_nothing() {
        let metadata = inspect_media_metadata(b"not a media file at all");

        assert_eq!(metadata.container, MediaContainer::Unknown);
        assert_eq!(metadata.duration_ms, None);
        assert_eq!(metadata.audio, None);
        assert_eq!(metadata.video, None);
    }

    #[test]
    fn a_truncated_or_hostile_header_never_panics() {
        for length in 0..64usize {
            let truncated = vec![0xffu8; length];
            let _ = inspect_media_metadata(&truncated);
        }

        // A box claiming a huge size must not read past the buffer.
        let mut hostile = u32::MAX.to_be_bytes().to_vec();
        hostile.extend_from_slice(b"ftyp");
        hostile.extend_from_slice(&[0u8; 8]);
        let _ = inspect_media_metadata(&hostile);

        // A zero-size box must terminate rather than loop.
        let mut zero = 0u32.to_be_bytes().to_vec();
        zero.extend_from_slice(b"ftypqt  ");
        let _ = inspect_media_metadata(&zero);
    }
}
