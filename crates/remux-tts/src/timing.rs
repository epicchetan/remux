use std::io::Write;

use misaki_rs::MToken;

const SAMPLE_RATE: usize = 24_000;

pub(crate) fn join_timestamps(tokens: &mut [MToken], duration: &[i64]) {
    if tokens.is_empty() || duration.len() < 3 {
        return;
    }
    let mut left = 2 * (duration[0] - 3).max(0);
    let mut right = left;
    let mut index = 1;
    for token in tokens {
        if index >= duration.len() - 1 {
            break;
        }
        let phoneme_count = token
            .phonemes
            .as_deref()
            .map(str::chars)
            .map(Iterator::count)
            .unwrap_or(0);
        if phoneme_count == 0 {
            if !token.whitespace.is_empty() && index + 1 < duration.len() {
                index += 1;
                left = right + duration[index];
                right = left + duration[index];
                index += 1;
            }
            continue;
        }
        let end = index + phoneme_count;
        if end >= duration.len() {
            break;
        }
        token.start_ts = Some(left as f64 / 80.0);
        let token_duration = duration[index..end].iter().sum::<i64>();
        let space_duration = if token.whitespace.is_empty() {
            0
        } else {
            duration[end]
        };
        left = right + 2 * token_duration + space_duration;
        token.end_ts = Some(left as f64 / 80.0);
        right = left + space_duration;
        index = end + usize::from(!token.whitespace.is_empty());
    }
}

pub(crate) fn write_wav_bytes(audio: &[f32]) -> Result<Vec<u8>, String> {
    let data_size = audio
        .len()
        .checked_mul(2)
        .and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| "narration WAV is too large".to_string())?;
    let mut file = Vec::with_capacity(data_size as usize + 44);
    file.write_all(b"RIFF")
        .and_then(|_| file.write_all(&(36 + data_size).to_le_bytes()))
        .and_then(|_| file.write_all(b"WAVEfmt "))
        .and_then(|_| file.write_all(&16_u32.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&(SAMPLE_RATE as u32).to_le_bytes()))
        .and_then(|_| file.write_all(&((SAMPLE_RATE * 2) as u32).to_le_bytes()))
        .and_then(|_| file.write_all(&2_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&16_u16.to_le_bytes()))
        .and_then(|_| file.write_all(b"data"))
        .and_then(|_| file.write_all(&data_size.to_le_bytes()))
        .map_err(|error| format!("failed to encode narration WAV header: {error}"))?;
    for sample in audio {
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        file.write_all(&pcm.to_le_bytes())
            .map_err(|error| format!("failed to encode narration WAV samples: {error}"))?;
    }
    Ok(file)
}

pub(crate) fn seconds(samples: usize) -> f64 {
    samples as f64 / SAMPLE_RATE as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_duration_join_is_monotonic_and_accounts_for_spaces() {
        let mut first = MToken::new("hello".to_string(), String::new(), " ".to_string());
        first.phonemes = Some("abc".to_string());
        let mut second = MToken::new("world".to_string(), String::new(), String::new());
        second.phonemes = Some("de".to_string());
        let mut tokens = vec![first, second];
        join_timestamps(&mut tokens, &[4, 1, 2, 3, 1, 4, 5, 2]);
        assert_eq!(tokens[0].start_ts, Some(0.025));
        assert_eq!(tokens[0].end_ts, Some(0.1875));
        assert_eq!(tokens[1].start_ts, Some(0.1875));
        assert_eq!(tokens[1].end_ts, Some(0.425));
    }

    #[test]
    fn wav_header_matches_pcm_payload() {
        let wav = write_wav_bytes(&[0.0, 1.0, -1.0]).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(wav.len(), 50);
    }
}
