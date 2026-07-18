use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::batch::MAX_CHUNK_SYMBOLS;

pub const PRONUNCIATION_PLAN_SCHEMA_VERSION: u32 = 4;
pub const PRONUNCIATION_PROMPT_VERSION: u32 = 4;
pub const PRONUNCIATION_OUTPUT_SCHEMA_VERSION: u32 = 4;
pub const AUDIT_WINDOW_PLANNER_VERSION: u32 = 3;
pub const DIRECT_PHONE_ALPHABET_VERSION: u32 = 1;
pub const DIRECT_PHONE_VALIDATOR_VERSION: u32 = 1;
pub const MAX_DIRECT_PHONE_SYMBOLS: usize = MAX_CHUNK_SYMBOLS;

const PINNED_KOKORO_SYMBOLS: &str = " !\"(),.:;?AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻ—“”…→↓↗↘ꭧ";
const PINNED_KOKORO_VOCABULARY_SHA256: &str =
    "sha256-5977eee9e44024553a1511cbc7f2c9320fbd4f6409228bcab0b5d26922260beb";
pub const KOKORO_REVIEW_LEXICAL_ALPHABET_V1: &str = "AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻꭧ";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct SourceWordId(pub u32);

impl SourceWordId {
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BaselineUnresolvedReason {
    MissingPhones,
    UnresolvedMarker,
    UnsupportedSymbol,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BaselinePhoneState {
    Resolved {
        phone_runs: Vec<String>,
    },
    Unresolved {
        available_phone_runs: Vec<String>,
        reason: BaselineUnresolvedReason,
    },
}

impl BaselinePhoneState {
    pub fn phone_runs(&self) -> &[String] {
        match self {
            Self::Resolved { phone_runs } => phone_runs,
            Self::Unresolved {
                available_phone_runs,
                ..
            } => available_phone_runs,
        }
    }

    pub fn joined_phones(&self) -> String {
        self.phone_runs().join(" ")
    }

    pub fn resolved(&self) -> bool {
        matches!(self, Self::Resolved { .. })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceWordFingerprint {
    pub word_id: SourceWordId,
    pub block_id: String,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub source_text_sha256: String,
    pub baseline_phones_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PronunciationWindowRecord {
    pub window_id: u32,
    pub input_sha256: String,
    pub output_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PronunciationPatchKind {
    DirectPhones { phones: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedPronunciationPatch {
    pub window_id: u32,
    pub target: SourceWordFingerprint,
    pub correction: PronunciationPatchKind,
    pub patch_sha256: String,
}

impl ReviewedPronunciationPatch {
    pub fn new(
        window_id: u32,
        target: SourceWordFingerprint,
        correction: PronunciationPatchKind,
    ) -> Result<Self, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            window_id: u32,
            target: &'a SourceWordFingerprint,
            correction: &'a PronunciationPatchKind,
        }
        let patch_sha256 = canonical_sha256(&Body {
            window_id,
            target: &target,
            correction: &correction,
        })?;
        Ok(Self {
            window_id,
            target,
            correction,
            patch_sha256,
        })
    }

    pub fn validate_hash(&self) -> Result<(), String> {
        let rebuilt = Self::new(self.window_id, self.target.clone(), self.correction.clone())?;
        if rebuilt.patch_sha256 != self.patch_sha256 {
            return Err("pronunciationPlanInvalid: patch hash mismatch".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedPronunciationPlan {
    pub schema_version: u32,
    pub document_hash: String,
    pub baseline_hash: String,
    pub reviewer_profile_hash: String,
    pub prompt_version: u32,
    pub output_schema_version: u32,
    pub window_planner_version: u32,
    pub phone_alphabet_version: u32,
    pub phone_alphabet_sha256: String,
    pub kokoro_vocabulary_sha256: String,
    pub direct_phone_validator_version: u32,
    pub windows: Vec<PronunciationWindowRecord>,
    pub patches: Vec<ReviewedPronunciationPatch>,
}

impl ReviewedPronunciationPlan {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(self)
            .map_err(|error| format!("failed to encode pronunciation plan: {error}"))
    }

    pub fn sha256(&self) -> Result<String, String> {
        Ok(sha256_prefixed(&self.canonical_bytes()?))
    }

    pub fn validate_versions(&self) -> Result<(), String> {
        if self.schema_version != PRONUNCIATION_PLAN_SCHEMA_VERSION
            || self.prompt_version != PRONUNCIATION_PROMPT_VERSION
            || self.output_schema_version != PRONUNCIATION_OUTPUT_SCHEMA_VERSION
            || self.window_planner_version != AUDIT_WINDOW_PLANNER_VERSION
            || self.phone_alphabet_version != DIRECT_PHONE_ALPHABET_VERSION
            || self.phone_alphabet_sha256 != direct_phone_alphabet_sha256()
            || self.direct_phone_validator_version != DIRECT_PHONE_VALIDATOR_VERSION
        {
            return Err("pronunciationPlanInvalid: version mismatch".to_string());
        }
        if self
            .windows
            .iter()
            .enumerate()
            .any(|(index, window)| window.window_id as usize != index)
        {
            return Err("pronunciationPlanInvalid: window ids are not contiguous".to_string());
        }
        if self
            .patches
            .windows(2)
            .any(|pair| pair[0].target.word_id >= pair[1].target.word_id)
        {
            return Err(
                "pronunciationPlanInvalid: patches are not strictly source ordered".to_string(),
            );
        }
        for patch in &self.patches {
            patch.validate_hash()?;
            if patch.window_id as usize >= self.windows.len() {
                return Err("pronunciationPlanInvalid: patch has unknown window".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct KokoroVocabulary {
    symbols: HashSet<char>,
    sha256: String,
}

impl KokoroVocabulary {
    pub fn pinned() -> Self {
        Self {
            symbols: PINNED_KOKORO_SYMBOLS.chars().collect(),
            sha256: PINNED_KOKORO_VOCABULARY_SHA256.to_string(),
        }
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes =
            fs::read(path).map_err(|error| format!("failed to read Kokoro vocabulary: {error}"))?;
        let raw: HashMap<String, i64> = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid Kokoro vocabulary: {error}"))?;
        let mut symbols = HashSet::new();
        for key in raw.keys() {
            let mut chars = key.chars();
            let character = chars
                .next()
                .filter(|_| chars.next().is_none())
                .ok_or_else(|| "Kokoro vocabulary contains a non-character key".to_string())?;
            symbols.insert(character);
        }
        Ok(Self {
            symbols,
            sha256: sha256_prefixed(&bytes),
        })
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn supports(&self, value: &str) -> bool {
        value
            .chars()
            .all(|character| self.symbols.contains(&character))
    }

    pub fn validate(&self, value: &str) -> Result<(), String> {
        if value.trim().is_empty() {
            return Err("pronunciation contains no lexical phones".to_string());
        }
        if value.contains('❓') {
            return Err("pronunciation contains an unresolved marker".to_string());
        }
        if let Some(character) = value
            .chars()
            .find(|character| !self.symbols.contains(character))
        {
            return Err(format!(
                "pronunciation contains unsupported Kokoro symbol {character:?}"
            ));
        }
        Ok(())
    }
}

pub fn validate_direct_phone_string(
    phones: &str,
    vocabulary: &KokoroVocabulary,
) -> Result<Vec<String>, String> {
    validate_direct_phone_alphabet(vocabulary)?;
    if phones.is_empty()
        || phones.starts_with(' ')
        || phones.ends_with(' ')
        || phones.contains("  ")
        || phones.chars().count() > MAX_DIRECT_PHONE_SYMBOLS
    {
        return Err(
            "pronunciationDirectPhonesInvalid: phones are empty, noncanonical, or oversized"
                .to_string(),
        );
    }
    for character in phones.chars() {
        if character != ' ' && !KOKORO_REVIEW_LEXICAL_ALPHABET_V1.contains(character) {
            return Err(format!(
                "pronunciationDirectPhonesInvalid: unsupported lexical phone {character:?}"
            ));
        }
    }
    vocabulary
        .validate(phones)
        .map_err(|error| format!("pronunciationDirectPhonesInvalid: {error}"))?;
    Ok(phones.split(' ').map(str::to_string).collect())
}

pub fn direct_phone_alphabet_sha256() -> String {
    sha256_prefixed(KOKORO_REVIEW_LEXICAL_ALPHABET_V1.as_bytes())
}

pub fn validate_direct_phone_alphabet(vocabulary: &KokoroVocabulary) -> Result<(), String> {
    if let Some(character) = KOKORO_REVIEW_LEXICAL_ALPHABET_V1
        .chars()
        .find(|character| !vocabulary.symbols.contains(character))
    {
        return Err(format!(
            "pronunciationDirectPhonesInvalid: review alphabet symbol {character:?} is absent from Kokoro vocabulary"
        ));
    }
    Ok(())
}

pub fn normalize_phone_run(value: &str) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.chars().filter(|character| {
        !matches!(
            *character,
            '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}'
        )
    }) {
        if character.is_whitespace() {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
            }
            pending_space = false;
            output.push(character);
        }
    }
    output
}

pub fn joined_symbol_count(runs: &[String]) -> usize {
    runs.iter().map(|run| run.chars().count()).sum::<usize>() + runs.len().saturating_sub(1)
}

pub fn sha256_prefixed(bytes: &[u8]) -> String {
    format!("sha256-{:x}", Sha256::digest(bytes))
}

pub fn canonical_sha256(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode canonical JSON: {error}"))?;
    Ok(sha256_prefixed(&bytes))
}

pub fn count_direct_phone_patches(plan: &ReviewedPronunciationPlan) -> usize {
    plan.patches.len()
}

pub fn patch_map(
    plan: &ReviewedPronunciationPlan,
) -> Result<BTreeMap<SourceWordId, &ReviewedPronunciationPatch>, String> {
    let mut patches = BTreeMap::new();
    for patch in &plan.patches {
        if patches.insert(patch.target.word_id, patch).is_some() {
            return Err("pronunciationPlanInvalid: duplicate patch target".to_string());
        }
    }
    Ok(patches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_phones_are_canonical_allowlisted_and_bounded() {
        let vocabulary = KokoroVocabulary::pinned();
        let runs = validate_direct_phone_string("ˌeɪtʃ tˌiː ˌɛm ˈɛl ˈɔːdioʊ ˈɛləmənt", &vocabulary)
            .unwrap();
        assert_eq!(runs.len(), 6);
        assert!(validate_direct_phone_string("bæd/foʊnz", &vocabulary).is_err());
        assert!(validate_direct_phone_string(" bæd", &vocabulary).is_err());
        assert!(validate_direct_phone_string("bæd  foʊnz", &vocabulary).is_err());
        assert!(validate_direct_phone_string("bæd→foʊnz", &vocabulary).is_err());
        assert!(validate_direct_phone_string(&"a".repeat(451), &vocabulary).is_err());
        assert_eq!(vocabulary.sha256(), PINNED_KOKORO_VOCABULARY_SHA256);
        assert_eq!(
            direct_phone_alphabet_sha256(),
            "sha256-66c2e7ed0b07928fa5b5ff4426c53fbb4a643808d5bc4e5b4330ef59111f0bed"
        );
    }
}
