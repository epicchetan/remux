use misaki_rs::{G2P, Language};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnglishG2pToken {
    pub text: String,
    pub tag: String,
    pub phonemes: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnglishG2pOutput {
    pub phonemes: String,
    pub tokens: Vec<EnglishG2pToken>,
}

pub struct EnglishG2p {
    g2p: G2P,
}

impl EnglishG2p {
    pub fn new() -> Self {
        Self {
            g2p: G2P::new(Language::EnglishUS),
        }
    }

    pub fn phonemize(&self, text: &str) -> Result<EnglishG2pOutput, String> {
        let normalized = normalize_for_g2p(text);
        let (phonemes, tokens) = self
            .g2p
            .g2p(&normalized)
            .map_err(|error| format!("English G2P failed: {error}"))?;
        let tokens = tokens
            .into_iter()
            .filter_map(|token| {
                let phonemes = normalize_phonemes(token.phonemes.as_deref().unwrap_or_default());
                (!phonemes.is_empty()).then_some(EnglishG2pToken {
                    text: token.text,
                    tag: token.tag,
                    phonemes,
                })
            })
            .collect::<Vec<_>>();
        if tokens.iter().any(|token| {
            token.text.chars().any(char::is_alphanumeric) && token.phonemes.contains('❓')
        }) {
            return Err("English G2P left an unresolved word".to_string());
        }
        let phonemes = normalize_phonemes(&phonemes)
            .replace('❓', "")
            .trim()
            .to_string();
        if phonemes.is_empty() || tokens.is_empty() {
            return Err("English G2P produced no phonemes".to_string());
        }
        Ok(EnglishG2pOutput { phonemes, tokens })
    }
}

impl Default for EnglishG2p {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_for_g2p(value: &str) -> String {
    value
        .replace(['’', '‘'], "'")
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .collect()
}

fn normalize_phonemes(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            !matches!(
                *character,
                '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}'
            )
        })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexical(output: &EnglishG2pOutput) -> Vec<&EnglishG2pToken> {
        output
            .tokens
            .iter()
            .filter(|token| token.text.chars().any(char::is_alphanumeric))
            .collect()
    }

    #[test]
    fn contextual_words_keep_pos_and_order_for_risk_detection() {
        let frontend = EnglishG2p::new();
        let output = frontend
            .phonemize(
                "Record the record, then close the close handler. I read it and had read it.",
            )
            .unwrap();
        let tokens = lexical(&output);
        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.text.eq_ignore_ascii_case("record"))
                .count(),
            2
        );
        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.text.eq_ignore_ascii_case("close"))
                .count(),
            2
        );
        assert!(
            tokens
                .iter()
                .filter(|token| matches!(
                    token.text.to_ascii_lowercase().as_str(),
                    "record" | "close" | "read"
                ))
                .all(|token| !token.tag.is_empty() && !token.phonemes.is_empty())
        );
    }

    #[test]
    fn local_rules_phonemize_oov_words_without_unknown_markers() {
        let output = EnglishG2p::new().phonemize("xyzqwop").unwrap();
        assert!(!output.phonemes.contains('❓'));
        assert!(!output.phonemes.trim().is_empty());
    }
}
