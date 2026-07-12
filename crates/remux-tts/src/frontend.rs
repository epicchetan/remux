use misaki_rs::{G2P, Language, MToken};
use num2words::{Currency, Num2Words};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

const MAX_PHONEMES: usize = 510;

#[derive(Debug, Clone)]
pub struct FrontendChunk {
    pub tokens: Vec<MToken>,
}

pub struct EnglishFrontend {
    g2p: G2P,
}

impl EnglishFrontend {
    pub fn new() -> Self {
        let mut g2p = G2P::new(Language::EnglishUS);
        // Match the existing Python configuration: fallback=None, unk="".
        g2p.unk.clear();
        Self { g2p }
    }

    pub fn chunks(&self, text: &str) -> Result<Vec<FrontendChunk>, String> {
        let normalized = normalize_for_g2p(text);
        let (_, mut tokens) = self
            .g2p
            .g2p(&normalized)
            .map_err(|error| format!("English G2P failed: {error}"))?;
        repair_whitespace(&normalized, &mut tokens);
        self.repair_tokens(&mut tokens)?;
        let mut chunks = Vec::new();
        let mut pending = Vec::new();
        let mut count = 0;
        for token in tokens {
            let length = token
                .phonemes
                .as_deref()
                .map(str::chars)
                .map(Iterator::count)
                .unwrap_or(0)
                + usize::from(!token.whitespace.is_empty());
            if count + length > MAX_PHONEMES && !pending.is_empty() {
                chunks.push(make_chunk(std::mem::take(&mut pending))?);
                count = 0;
            }
            count += length;
            pending.push(token);
        }
        if !pending.is_empty() {
            chunks.push(make_chunk(pending)?);
        }
        if chunks.is_empty() {
            return Err("English G2P produced no phonemes".to_string());
        }
        Ok(chunks)
    }

    fn repair_tokens(&self, tokens: &mut [MToken]) -> Result<(), String> {
        for token in tokens.iter_mut() {
            if matches!(
                token.text.as_str(),
                ";" | ":" | "," | "." | "!" | "?" | "—" | "…"
            ) {
                token.phonemes = Some(token.text.clone());
            }
        }
        for index in 0..tokens.len() {
            let raw = tokens[index].text.replace(',', "");
            if index > 0 && tokens[index - 1].text == "$" {
                let Ok(value) = raw.parse::<f64>() else {
                    continue;
                };
                let spoken = Num2Words::new(value)
                    .currency(Currency::DOLLAR)
                    .to_words()
                    .map_err(|error| format!("failed to normalize currency: {error}"))?;
                tokens[index - 1].phonemes = Some(String::new());
                tokens[index].phonemes = Some(self.phonemize_phrase(&spoken)?);
            } else if raw.len() == 4
                && raw.chars().all(|character| character.is_ascii_digit())
                && let Ok(value) = raw.parse::<i64>()
                && (1000..=2999).contains(&value)
            {
                let spoken = Num2Words::new(value)
                    .year()
                    .to_words()
                    .map_err(|error| format!("failed to normalize year: {error}"))?;
                tokens[index].phonemes = Some(self.phonemize_phrase(&spoken)?);
            }
        }
        Ok(())
    }

    fn phonemize_phrase(&self, value: &str) -> Result<String, String> {
        self.g2p
            .g2p(value)
            .map(|(phonemes, _)| phonemes.trim().to_string())
            .map_err(|error| format!("English G2P failed: {error}"))
    }
}

fn normalize_for_g2p(value: &str) -> String {
    value
        .replace(['’', '‘'], "'")
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .collect()
}

fn make_chunk(tokens: Vec<MToken>) -> Result<FrontendChunk, String> {
    let phonemes = tokens
        .iter()
        .map(|token| {
            let mut value = token.phonemes.clone().unwrap_or_default();
            if !token.whitespace.is_empty() {
                value.push(' ');
            }
            value
        })
        .collect::<String>()
        .trim()
        .to_string();
    if phonemes.is_empty() || phonemes.chars().count() > MAX_PHONEMES {
        return Err("English G2P produced an invalid phoneme chunk".to_string());
    }
    Ok(FrontendChunk { tokens })
}

fn repair_whitespace(text: &str, tokens: &mut [MToken]) {
    let mut cursor = 0;
    for token in tokens {
        let Some(relative) = text[cursor..].find(token.text.trim()) else {
            token.whitespace.clear();
            continue;
        };
        let end = cursor + relative + token.text.trim().len();
        let whitespace = text[end..].chars().next().is_some_and(char::is_whitespace);
        token.whitespace = if whitespace {
            " ".to_string()
        } else {
            String::new()
        };
        cursor = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_is_bounded_and_preserves_words() {
        let chunks = EnglishFrontend::new()
            .chunks("Hello, world. This is a narration test.")
            .unwrap();
        assert!(!chunks.is_empty());
        assert!(
            chunks
                .iter()
                .flat_map(|chunk| &chunk.tokens)
                .any(|token| token.text.contains("Hello"))
        );
    }

    #[test]
    fn frontend_repairs_common_python_misaki_semantics() {
        let frontend = EnglishFrontend::new();
        let chunks = frontend.chunks("Café — it’s $12.50 in 2026.").unwrap();
        let tokens = chunks
            .iter()
            .flat_map(|chunk| &chunk.tokens)
            .collect::<Vec<_>>();
        assert!(tokens.iter().any(|token| token.text == "Cafe"));
        assert!(tokens.iter().any(|token| token.text == "it's"));
        assert_eq!(
            tokens
                .iter()
                .find(|token| token.text == "—")
                .and_then(|token| token.phonemes.as_deref()),
            Some("—")
        );
        assert_eq!(
            tokens
                .iter()
                .find(|token| token.text == ".")
                .and_then(|token| token.phonemes.as_deref()),
            Some(".")
        );
        let currency = tokens
            .iter()
            .find(|token| token.text == "12.50")
            .and_then(|token| token.phonemes.as_deref())
            .unwrap();
        assert_eq!(
            currency,
            frontend
                .phonemize_phrase("twelve dollars and fifty cents")
                .unwrap()
        );
        let year = tokens
            .iter()
            .find(|token| token.text == "2026")
            .and_then(|token| token.phonemes.as_deref())
            .unwrap();
        assert_eq!(
            year,
            frontend.phonemize_phrase("twenty twenty-six").unwrap()
        );
    }
}
