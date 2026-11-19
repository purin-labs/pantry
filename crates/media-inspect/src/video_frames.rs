//! Deterministic video frame sampling.
//!
//! Sampling has two halves. Choosing *which* frames to take is arithmetic over
//! the container's own timing, and is fully deterministic for a given content
//! digest and policy revision. Getting the pixels for a chosen frame is codec
//! work, and only some codecs allow it without a decoder.
//!
//! This module implements both halves for the codecs that store each frame as a
//! complete image — Motion JPEG in an ISO base media container — and reports a
//! typed limitation naming the codec for everything else. H.264, VP9, and AV1
//! need a real decoder, which is a container-side capability; when one arrives
//! it plugs in behind this same selection, so the timestamps a video yields do
//! not change when the decoder does.
//!
//! No audio track is read, and no frame is interpreted. The output is images
//! and the timestamps they came from.

use serde::Serialize;
use sha2::{Digest, Sha256};

/// The sampling policy. Its revision is part of every result, so a change in
/// selection is visible rather than silent.
pub const FRAME_SAMPLING_POLICY_REVISION: &str = "plan37.frames.v1";
pub const MAX_SAMPLED_FRAMES: usize = 12;

/// A digest computed from media bytes. External callers cannot supply raw text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct FrameDigest(String);

impl FrameDigest {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampledFrame {
    pub timestamp_ms: u64,
    /// Where the frame sits in the source file, so a caller can slice it out
    /// without re-walking the sample table.
    pub byte_offset: u64,
    pub byte_length: u64,
    pub sha256: FrameDigest,
    /// The exact media type of the extracted still.
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FrameSamplingOutcome {
    Sampled {
        policy_revision: String,
        /// The timestamps selection asked for, whether or not each yielded a
        /// frame. Reported so a caller can see what was attempted.
        selected_timestamps_ms: Vec<u64>,
        frames: Vec<SampledFrame>,
    },
    /// The frames exist but cannot be read here. The codec is named so the
    /// limitation is specific rather than a shrug.
    DecoderRequired {
        codec: String,
    },
    NoVideoTrack,
    /// The container held a video track this parser could not walk.
    ContainerUnreadable,
}

/// Chooses sample timestamps across a duration.
///
/// Frames are spaced evenly across the interior of the clip, avoiding the very
/// first and last instants where many encoders place black or partial frames.
/// The result depends only on duration and the frame budget, so the same video
/// always yields the same timestamps.
pub fn select_frame_timestamps(duration_ms: u64, max_frames: usize) -> Vec<u64> {
    let budget = max_frames.min(MAX_SAMPLED_FRAMES);

    if duration_ms == 0 || budget == 0 {
        return Vec::new();
    }

    if budget == 1 {
        return vec![duration_ms / 2];
    }

    (1..=budget)
        .map(|index| duration_ms.saturating_mul(index as u64) / (budget as u64 + 1))
        .collect()
}

/// A frame set is content-addressed by what it contains, so two samplings of
/// the same bytes under the same policy are provably identical.
pub fn frame_set_digest(frames: &[SampledFrame], policy_revision: &str) -> FrameDigest {
    let mut hasher = Sha256::new();

    hasher.update(policy_revision.as_bytes());

    for frame in frames {
        hasher.update([0x1e]);
        hasher.update(frame.timestamp_ms.to_string().as_bytes());
        hasher.update([0x1f]);
        hasher.update(frame.sha256.as_str().as_bytes());
    }

    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);

    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }

    FrameDigest(hex)
}

/// Samples frames from a complete ISO base media file.
///
/// The whole file is required: frame bytes live throughout it, not in the
/// header. Callers bound the file size before reaching here.
pub fn sample_video_frames(file: &[u8], max_frames: usize) -> FrameSamplingOutcome {
    let Some(moov) = find_box(file, b"moov") else {
        return FrameSamplingOutcome::ContainerUnreadable;
    };

    let Some(track) = video_track(moov) else {
        return FrameSamplingOutcome::NoVideoTrack;
    };

    let Some(table) = read_sample_table(&track) else {
        return FrameSamplingOutcome::ContainerUnreadable;
    };

    if !is_still_image_codec(&table.codec) {
        // Every other codec stores inter-frame deltas; reconstructing a still
        // from them is decoding, not parsing.
        return FrameSamplingOutcome::DecoderRequired {
            codec: table.codec.clone(),
        };
    }

    let duration_ms = table.duration_ms();
    let selected = select_frame_timestamps(duration_ms, max_frames);
    let mut frames = Vec::new();

    for timestamp_ms in &selected {
        let Some(index) = table.sample_at(*timestamp_ms) else {
            continue;
        };
        let Some((offset, length)) = table.sample_range(index) else {
            continue;
        };
        let Some(bytes) = file.get(offset..offset.saturating_add(length)) else {
            continue;
        };

        if bytes.is_empty() {
            continue;
        }

        frames.push(SampledFrame {
            timestamp_ms: *timestamp_ms,
            byte_offset: offset as u64,
            byte_length: bytes.len() as u64,
            sha256: digest_bytes(bytes),
            media_type: "image/jpeg".to_string(),
        });
    }

    FrameSamplingOutcome::Sampled {
        policy_revision: FRAME_SAMPLING_POLICY_REVISION.to_string(),
        selected_timestamps_ms: selected,
        frames,
    }
}

// ---------------------------------------------------------------------------
// H.264 decode planning
// ---------------------------------------------------------------------------

/// One keyframe as a self-contained Annex B packet.
///
/// The sequence and picture parameter sets are prepended, so a decoder can take
/// each packet on its own without state from an earlier one. That is what lets
/// frame selection stay deterministic here while decoding happens elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct H264KeyframePacket {
    pub timestamp_ms: u64,
    pub annex_b: Vec<u8>,
}

/// What a decoder needs in order to produce the stills selection asked for.
///
/// Planning is parsing: it reads the container, picks keyframes, and rewrites
/// length-prefixed NAL units into the Annex B form decoders consume. No pixel is
/// touched. The decode itself runs in the executor container, which is the only
/// place a codec library belongs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum H264DecodePlan {
    Ready {
        policy_revision: String,
        #[serde(skip)]
        packets: Vec<H264KeyframePacket>,
        selected_timestamps_ms: Vec<u64>,
    },
    /// The track is not H.264, so this planner has nothing to say about it.
    NotH264 {
        codec: String,
    },
    /// An H.264 track with no `avcC`, so no parameter sets and nothing a
    /// decoder could initialise from.
    ParameterSetsMissing,
    NoVideoTrack,
    ContainerUnreadable,
}

/// Plans the decode of up to `max_frames` keyframes spread across the clip.
///
/// Each selected timestamp resolves to the nearest preceding sync sample, so a
/// clip with long GOPs yields the keyframe that actually covers that moment.
/// Two timestamps that land on the same keyframe produce it once.
pub fn plan_h264_decode(file: &[u8], max_frames: usize) -> H264DecodePlan {
    let Some(moov) = find_box(file, b"moov") else {
        return H264DecodePlan::ContainerUnreadable;
    };

    let Some(track) = video_track(moov) else {
        return H264DecodePlan::NoVideoTrack;
    };

    let Some(table) = read_sample_table(&track) else {
        return H264DecodePlan::ContainerUnreadable;
    };

    if !matches!(table.codec.as_str(), "avc1" | "avc3") {
        return H264DecodePlan::NotH264 {
            codec: table.codec.clone(),
        };
    }

    let Some(stsd) = find_box(&track, b"stsd") else {
        return H264DecodePlan::ContainerUnreadable;
    };

    let Some(parameters) = read_avcc(stsd) else {
        return H264DecodePlan::ParameterSetsMissing;
    };

    let sync_samples = find_box(&track, b"stss").and_then(read_sync_samples);
    let duration_ms = table.duration_ms();
    let selected = select_frame_timestamps(duration_ms, max_frames);
    let mut packets = Vec::new();
    let mut emitted = Vec::new();

    for timestamp_ms in &selected {
        let Some(index) = table.sample_at(*timestamp_ms) else {
            continue;
        };
        let keyframe = nearest_sync_sample(index, sync_samples.as_deref());

        if emitted.contains(&keyframe) {
            continue;
        }

        let Some((offset, length)) = table.sample_range(keyframe) else {
            continue;
        };
        let Some(sample) = file.get(offset..offset.saturating_add(length)) else {
            continue;
        };
        let Some(nal_units) = length_prefixed_to_annex_b(sample, parameters.nal_length_size) else {
            continue;
        };

        let mut annex_b = parameters.annex_b_header.clone();

        annex_b.extend_from_slice(&nal_units);
        emitted.push(keyframe);
        packets.push(H264KeyframePacket {
            timestamp_ms: *timestamp_ms,
            annex_b,
        });
    }

    H264DecodePlan::Ready {
        policy_revision: FRAME_SAMPLING_POLICY_REVISION.to_string(),
        packets,
        selected_timestamps_ms: selected,
    }
}

struct AvcParameters {
    nal_length_size: usize,
    /// SPS and PPS already in Annex B form, ready to prepend to any keyframe.
    annex_b_header: Vec<u8>,
}

/// Reads the `avcC` box out of the first sample entry.
///
/// `stsd` is a full box (4 bytes version/flags, 4 bytes entry count) followed
/// by sample entries. A visual sample entry carries 8 bytes of box header and
/// 78 bytes of fixed fields before its own child boxes begin.
fn read_avcc(stsd: &[u8]) -> Option<AvcParameters> {
    const ENTRY_START: usize = 8;
    const VISUAL_SAMPLE_ENTRY_FIELDS: usize = 8 + 78;
    let children = stsd.get(ENTRY_START + VISUAL_SAMPLE_ENTRY_FIELDS..)?;
    let avcc = find_box(children, b"avcC")?;

    // Configuration version, profile, compatibility, level.
    if *avcc.first()? != 1 {
        return None;
    }

    let nal_length_size = (avcc.get(4)? & 0x03) as usize + 1;
    let sps_count = (avcc.get(5)? & 0x1f) as usize;
    let mut cursor = 6usize;
    let mut annex_b_header = Vec::new();

    for _ in 0..sps_count {
        cursor = append_parameter_set(avcc, cursor, &mut annex_b_header)?;
    }

    let pps_count = *avcc.get(cursor)? as usize;

    cursor += 1;

    for _ in 0..pps_count {
        cursor = append_parameter_set(avcc, cursor, &mut annex_b_header)?;
    }

    if annex_b_header.is_empty() {
        return None;
    }

    Some(AvcParameters {
        nal_length_size,
        annex_b_header,
    })
}

fn append_parameter_set(avcc: &[u8], cursor: usize, target: &mut Vec<u8>) -> Option<usize> {
    let length = u16::from_be_bytes(avcc.get(cursor..cursor + 2)?.try_into().ok()?) as usize;
    let body = avcc.get(cursor + 2..cursor + 2 + length)?;

    target.extend_from_slice(&[0, 0, 0, 1]);
    target.extend_from_slice(body);

    Some(cursor + 2 + length)
}

/// Sync sample numbers from `stss`, converted to zero-based indices.
fn read_sync_samples(body: &[u8]) -> Option<Vec<usize>> {
    let count = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as usize;
    let mut samples = Vec::with_capacity(count.min(65_536));

    for index in 0..count.min(65_536) {
        let at = 8 + index * 4;
        let number = u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as usize;

        samples.push(number.checked_sub(1)?);
    }

    Some(samples)
}

/// The keyframe covering a sample: the nearest sync sample at or before it, or
/// the first one after it when the clip opens on a non-keyframe. No `stss`
/// means every sample is a sync sample.
fn nearest_sync_sample(sample_index: usize, sync_samples: Option<&[usize]>) -> usize {
    let Some(sync_samples) = sync_samples else {
        return sample_index;
    };

    sync_samples
        .iter()
        .copied()
        .filter(|sync| *sync <= sample_index)
        .max()
        .or_else(|| sync_samples.iter().copied().min())
        .unwrap_or(sample_index)
}

/// Rewrites a sample's length-prefixed NAL units as Annex B start codes.
fn length_prefixed_to_annex_b(sample: &[u8], nal_length_size: usize) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(sample.len() + 8);
    let mut cursor = 0usize;

    while cursor < sample.len() {
        let prefix = sample.get(cursor..cursor + nal_length_size)?;
        let mut length = 0usize;

        for byte in prefix {
            length = (length << 8) | *byte as usize;
        }

        cursor += nal_length_size;

        let unit = sample.get(cursor..cursor.checked_add(length)?)?;

        if unit.is_empty() {
            return None;
        }

        output.extend_from_slice(&[0, 0, 0, 1]);
        output.extend_from_slice(unit);
        cursor += length;
    }

    (!output.is_empty()).then_some(output)
}

fn is_still_image_codec(codec: &str) -> bool {
    // Motion JPEG stores every frame as a complete JPEG, so a sample is already
    // an image and needs no reconstruction.
    matches!(codec, "jpeg" | "mjpa" | "mjpb" | "MJPG")
}

fn digest_bytes(bytes: &[u8]) -> FrameDigest {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);

    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }

    FrameDigest(hex)
}

// ---------------------------------------------------------------------------
// Sample table
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct SampleTable {
    codec: String,
    timescale: u64,
    /// (sample count, duration in timescale units) runs.
    timing: Vec<(u64, u64)>,
    sizes: Vec<u64>,
    /// (first chunk, samples per chunk) runs.
    chunk_runs: Vec<(u64, u64)>,
    chunk_offsets: Vec<u64>,
}

impl SampleTable {
    fn duration_ms(&self) -> u64 {
        if self.timescale == 0 {
            return 0;
        }

        let units: u64 = self
            .timing
            .iter()
            .map(|(count, delta)| count.saturating_mul(*delta))
            .sum();

        units.saturating_mul(1_000) / self.timescale
    }

    /// The sample covering a timestamp, walking the time-to-sample runs.
    fn sample_at(&self, timestamp_ms: u64) -> Option<usize> {
        if self.timescale == 0 {
            return None;
        }

        let target_units = timestamp_ms.saturating_mul(self.timescale) / 1_000;
        let mut elapsed = 0u64;
        let mut index = 0usize;

        for (count, delta) in &self.timing {
            for _ in 0..*count {
                if elapsed.saturating_add(*delta) > target_units {
                    return Some(index);
                }

                elapsed = elapsed.saturating_add(*delta);
                index += 1;
            }
        }

        index.checked_sub(1)
    }

    /// The byte range of a sample, resolved through the chunk map.
    fn sample_range(&self, sample_index: usize) -> Option<(usize, usize)> {
        let size = *self.sizes.get(sample_index)? as usize;
        let mut samples_before = 0usize;

        for (run_index, (first_chunk, per_chunk)) in self.chunk_runs.iter().enumerate() {
            let next_first = self
                .chunk_runs
                .get(run_index + 1)
                .map(|(first, _)| *first)
                .unwrap_or(self.chunk_offsets.len() as u64 + 1);
            let chunks_in_run = next_first.saturating_sub(*first_chunk);

            for chunk in 0..chunks_in_run {
                let per_chunk = *per_chunk as usize;

                if sample_index < samples_before + per_chunk {
                    let chunk_number = (*first_chunk + chunk) as usize;
                    let chunk_offset =
                        *self.chunk_offsets.get(chunk_number.checked_sub(1)?)? as usize;
                    let within = sample_index - samples_before;
                    let mut offset = chunk_offset;

                    for earlier in 0..within {
                        offset = offset
                            .saturating_add(*self.sizes.get(samples_before + earlier)? as usize);
                    }

                    return Some((offset, size));
                }

                samples_before += per_chunk;
            }
        }

        None
    }
}

fn video_track(moov: &[u8]) -> Option<Vec<u8>> {
    for track in child_boxes(moov, b"trak") {
        let handler = find_box(track, b"hdlr")
            .and_then(|body| body.get(8..12))
            .and_then(|slice| std::str::from_utf8(slice).ok());

        if handler == Some("vide") {
            return Some(track.to_vec());
        }
    }

    None
}

fn read_sample_table(track: &[u8]) -> Option<SampleTable> {
    let timescale = find_box(track, b"mdhd").and_then(read_mdhd_timescale)?;
    let stsd = find_box(track, b"stsd")?;
    let codec = std::str::from_utf8(stsd.get(12..16)?)
        .ok()?
        .trim()
        .to_string();

    Some(SampleTable {
        codec,
        timescale,
        timing: read_pairs(find_box(track, b"stts")?)?,
        sizes: read_stsz(find_box(track, b"stsz")?)?,
        chunk_runs: read_stsc(find_box(track, b"stsc")?)?,
        chunk_offsets: read_offsets(find_box(track, b"stco")?)?,
    })
}

fn read_mdhd_timescale(body: &[u8]) -> Option<u64> {
    let version = *body.first()?;
    let offset = if version == 1 { 20 } else { 12 };

    Some(u32::from_be_bytes(body.get(offset..offset + 4)?.try_into().ok()?) as u64)
}

fn read_pairs(body: &[u8]) -> Option<Vec<(u64, u64)>> {
    let count = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as usize;
    let mut pairs = Vec::with_capacity(count.min(4_096));

    for index in 0..count.min(4_096) {
        let at = 8 + index * 8;

        pairs.push((
            u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as u64,
            u32::from_be_bytes(body.get(at + 4..at + 8)?.try_into().ok()?) as u64,
        ));
    }

    Some(pairs)
}

fn read_stsz(body: &[u8]) -> Option<Vec<u64>> {
    let uniform = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as u64;
    let count = u32::from_be_bytes(body.get(8..12)?.try_into().ok()?) as usize;

    if uniform > 0 {
        return Some(vec![uniform; count.min(65_536)]);
    }

    let mut sizes = Vec::with_capacity(count.min(65_536));

    for index in 0..count.min(65_536) {
        let at = 12 + index * 4;

        sizes.push(u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as u64);
    }

    Some(sizes)
}

fn read_stsc(body: &[u8]) -> Option<Vec<(u64, u64)>> {
    let count = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as usize;
    let mut runs = Vec::with_capacity(count.min(4_096));

    for index in 0..count.min(4_096) {
        let at = 8 + index * 12;

        runs.push((
            u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as u64,
            u32::from_be_bytes(body.get(at + 4..at + 8)?.try_into().ok()?) as u64,
        ));
    }

    Some(runs)
}

fn read_offsets(body: &[u8]) -> Option<Vec<u64>> {
    let count = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?) as usize;
    let mut offsets = Vec::with_capacity(count.min(65_536));

    for index in 0..count.min(65_536) {
        let at = 8 + index * 4;

        offsets.push(u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as u64);
    }

    Some(offsets)
}

// ---------------------------------------------------------------------------
// Box walking
// ---------------------------------------------------------------------------

fn find_box<'a>(data: &'a [u8], name: &[u8; 4]) -> Option<&'a [u8]> {
    for (box_name, body) in boxes(data) {
        if &box_name == name {
            return Some(body);
        }

        if matches!(
            &box_name,
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"edts" | b"udta"
        ) {
            if let Some(found) = find_box(body, name) {
                return Some(found);
            }
        }
    }

    None
}

fn child_boxes<'a>(data: &'a [u8], name: &[u8; 4]) -> Vec<&'a [u8]> {
    boxes(data)
        .into_iter()
        .filter_map(|(box_name, body)| (&box_name == name).then_some(body))
        .collect()
}

fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut found = Vec::new();
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

        let body_end = if size == 0 {
            data.len()
        } else {
            offset.saturating_add(size).min(data.len())
        };

        if offset + 8 > body_end {
            break;
        }

        found.push((name, &data[offset + 8..body_end]));

        if size <= 8 {
            break;
        }

        offset += size;
    }

    found
}

#[cfg_attr(
    all(target_arch = "wasm32", feature = "wasm-bindings"),
    wasm_bindgen::prelude::wasm_bindgen(js_name = sampleVideoFrames)
)]
pub fn sample_video_frames_wasm(file: &[u8], max_frames: u32) -> Vec<u8> {
    serde_json::to_vec(&sample_video_frames(file, max_frames as usize)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_evenly_spaced_inside_the_clip() {
        // Never the first or last instant, where encoders place black frames.
        assert_eq!(
            select_frame_timestamps(12_000, 3),
            vec![3_000, 6_000, 9_000]
        );
        assert_eq!(select_frame_timestamps(10_000, 1), vec![5_000]);
        assert_eq!(select_frame_timestamps(0, 5), Vec::<u64>::new());
        assert_eq!(select_frame_timestamps(1_000, 0), Vec::<u64>::new());
    }

    #[test]
    fn selection_is_deterministic_and_bounded() {
        assert_eq!(
            select_frame_timestamps(60_000, 12),
            select_frame_timestamps(60_000, 12)
        );
        // The frame budget is a hard ceiling regardless of what a caller asks.
        assert_eq!(
            select_frame_timestamps(60_000, 500).len(),
            MAX_SAMPLED_FRAMES
        );
    }

    #[test]
    fn a_frame_set_digest_covers_timestamps_and_content() {
        let frame = |timestamp: u64, byte: u8| SampledFrame {
            timestamp_ms: timestamp,
            byte_offset: 0,
            byte_length: 4,
            sha256: FrameDigest(format!("{:02x}", byte).repeat(32)),
            media_type: "image/jpeg".to_string(),
        };
        let base = vec![frame(1_000, 0xaa), frame(2_000, 0xbb)];

        assert_eq!(
            frame_set_digest(&base, FRAME_SAMPLING_POLICY_REVISION),
            frame_set_digest(&base, FRAME_SAMPLING_POLICY_REVISION)
        );
        // A different policy revision is a different result, by construction.
        assert_ne!(
            frame_set_digest(&base, FRAME_SAMPLING_POLICY_REVISION),
            frame_set_digest(&base, "other")
        );
        assert_ne!(
            frame_set_digest(&base, FRAME_SAMPLING_POLICY_REVISION),
            frame_set_digest(
                &[frame(1_000, 0xaa), frame(2_000, 0xcc)],
                FRAME_SAMPLING_POLICY_REVISION
            )
        );
    }

    #[test]
    fn an_inter_frame_codec_names_the_decoder_it_needs() {
        let file = mjpeg_fixture(b"avc1", &[b"one".to_vec(), b"two".to_vec()]);

        assert_eq!(
            sample_video_frames(&file, 2),
            FrameSamplingOutcome::DecoderRequired {
                codec: "avc1".to_string()
            }
        );
    }

    #[test]
    fn motion_jpeg_frames_are_extracted_without_a_decoder() {
        let frames: Vec<Vec<u8>> = vec![
            b"FRAME-ONE".to_vec(),
            b"FRAME-TWO".to_vec(),
            b"FRAME-3".to_vec(),
        ];
        let file = mjpeg_fixture(b"jpeg", &frames);

        let outcome = sample_video_frames(&file, 2);

        let FrameSamplingOutcome::Sampled {
            policy_revision,
            selected_timestamps_ms,
            frames: sampled,
        } = outcome
        else {
            panic!("expected sampled frames, got {outcome:?}");
        };

        assert_eq!(policy_revision, FRAME_SAMPLING_POLICY_REVISION);
        // Three one-second frames: sampling two lands inside the clip.
        assert_eq!(selected_timestamps_ms, vec![1_000, 2_000]);
        assert_eq!(sampled.len(), 2);
        assert_eq!(sampled[0].media_type, "image/jpeg");
        assert_eq!(sampled[0].byte_length, "FRAME-TWO".len() as u64);
        assert_ne!(sampled[0].sha256, sampled[1].sha256);
    }

    #[test]
    fn a_file_without_a_video_track_says_so() {
        let mut hdlr = vec![0u8; 12];
        hdlr[8..12].copy_from_slice(b"soun");

        let trak = iso_box(b"hdlr", &hdlr);
        let moov = iso_box(b"trak", &trak);
        let file = [iso_box(b"ftyp", b"isom"), iso_box(b"moov", &moov)].concat();

        assert_eq!(
            sample_video_frames(&file, 4),
            FrameSamplingOutcome::NoVideoTrack
        );
    }

    #[test]
    fn a_container_without_a_moov_is_unreadable_not_empty() {
        assert_eq!(
            sample_video_frames(&iso_box(b"ftyp", b"isom"), 4),
            FrameSamplingOutcome::ContainerUnreadable
        );
    }

    #[test]
    fn hostile_tables_never_panic() {
        for length in 0..96usize {
            let _ = sample_video_frames(&vec![0xffu8; length], 4);
        }

        let mut huge = u32::MAX.to_be_bytes().to_vec();
        huge.extend_from_slice(b"moov");
        let _ = sample_video_frames(&huge, 4);
    }

    fn iso_box(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(name);
        bytes.extend_from_slice(body);
        bytes
    }

    /// One video track whose samples are laid out in a single chunk.
    /// Four H.264 keyframes at 64x48, produced by ffmpeg with `-g 1` so every
    /// sample is a sync sample. Real bytes, because a planner that only ever
    /// saw hand-built boxes would prove nothing about a container an encoder
    /// actually wrote.
    const KEYFRAMES_H264: &[u8] =
        include_bytes!("../../workspace-executor/fixtures/keyframes-h264.mp4");

    #[test]
    fn plans_standalone_annex_b_packets_from_a_real_h264_file() {
        let plan = plan_h264_decode(KEYFRAMES_H264, 2);

        let H264DecodePlan::Ready {
            packets,
            selected_timestamps_ms,
            policy_revision,
        } = plan
        else {
            panic!("expected a ready plan, got {plan:?}");
        };

        assert_eq!(policy_revision, FRAME_SAMPLING_POLICY_REVISION);
        assert_eq!(selected_timestamps_ms.len(), 2);
        assert_eq!(packets.len(), 2);

        for packet in &packets {
            // Every packet opens with an Annex B start code and carries its own
            // SPS (type 7) and PPS (type 8) before the IDR slice (type 5).
            assert_eq!(&packet.annex_b[..4], &[0, 0, 0, 1]);
            let nal_types: Vec<u8> = packet
                .annex_b
                .windows(4)
                .enumerate()
                .filter(|(_, window)| *window == [0, 0, 0, 1])
                .filter_map(|(at, _)| packet.annex_b.get(at + 4).map(|byte| byte & 0x1f))
                .collect();
            assert!(nal_types.contains(&7), "missing SPS in {nal_types:?}");
            assert!(nal_types.contains(&8), "missing PPS in {nal_types:?}");
            assert!(nal_types.contains(&5), "missing IDR slice in {nal_types:?}");
        }
    }

    #[test]
    fn plan_reports_missing_parameter_sets_rather_than_guessing() {
        // An avc1 track with no avcC: a decoder could not initialise from it.
        let file = mjpeg_fixture(b"avc1", &[b"one".to_vec(), b"two".to_vec()]);

        assert_eq!(
            plan_h264_decode(&file, 2),
            H264DecodePlan::ParameterSetsMissing
        );
    }

    #[test]
    fn plan_names_a_codec_it_does_not_handle() {
        let file = mjpeg_fixture(b"vp09", &[b"one".to_vec()]);

        assert_eq!(
            plan_h264_decode(&file, 1),
            H264DecodePlan::NotH264 {
                codec: "vp09".to_string()
            }
        );
    }

    fn mjpeg_fixture(codec: &[u8; 4], frames: &[Vec<u8>]) -> Vec<u8> {
        let mut hdlr = vec![0u8; 12];
        hdlr[8..12].copy_from_slice(b"vide");

        let mut mdhd = vec![0u8; 20];
        // Timescale 1: one second per sample.
        mdhd[12..16].copy_from_slice(&1u32.to_be_bytes());

        let mut stsd = vec![0u8; 8];
        stsd.extend_from_slice(&0u32.to_be_bytes());
        stsd.extend_from_slice(codec);

        let mut stts = vec![0u8; 4];
        stts.extend_from_slice(&1u32.to_be_bytes());
        stts.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        stts.extend_from_slice(&1u32.to_be_bytes());

        let mut stsz = vec![0u8; 4];
        stsz.extend_from_slice(&0u32.to_be_bytes());
        stsz.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        for frame in frames {
            stsz.extend_from_slice(&(frame.len() as u32).to_be_bytes());
        }

        let mut stsc = vec![0u8; 4];
        stsc.extend_from_slice(&1u32.to_be_bytes());
        stsc.extend_from_slice(&1u32.to_be_bytes());
        stsc.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        stsc.extend_from_slice(&1u32.to_be_bytes());

        // The media data box is placed first so its offset is known before the
        // header is built.
        let media: Vec<u8> = frames.concat();
        let mdat = iso_box(b"mdat", &media);
        let ftyp = iso_box(b"ftyp", b"isom");
        let chunk_offset = (ftyp.len() + 8) as u32;

        let mut stco = vec![0u8; 4];
        stco.extend_from_slice(&1u32.to_be_bytes());
        stco.extend_from_slice(&chunk_offset.to_be_bytes());

        let stbl = [
            iso_box(b"stsd", &stsd),
            iso_box(b"stts", &stts),
            iso_box(b"stsz", &stsz),
            iso_box(b"stsc", &stsc),
            iso_box(b"stco", &stco),
        ]
        .concat();
        let minf = iso_box(b"stbl", &stbl);
        let mdia = [
            iso_box(b"mdhd", &mdhd),
            iso_box(b"hdlr", &hdlr),
            iso_box(b"minf", &minf),
        ]
        .concat();
        let trak = iso_box(b"mdia", &mdia);
        let moov = iso_box(b"trak", &trak);

        [ftyp, mdat, iso_box(b"moov", &moov)].concat()
    }
}
