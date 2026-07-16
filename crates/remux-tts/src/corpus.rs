use std::collections::{BTreeMap, BTreeSet, HashMap};

use misaki_rs::lexicon::PhonemeEntry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CorpusOrigin {
    Gold,
    Silver,
    Compound,
    Override,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CorpusHint {
    Simple(String),
    Tagged(BTreeMap<String, Option<String>>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorpusResolution {
    pub origin: CorpusOrigin,
    pub phonemes: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusCompatibility {
    pub compatible_entries: usize,
    pub entries: usize,
    pub incompatible_entries: usize,
    pub unsupported_symbols: BTreeMap<char, usize>,
}

pub struct MisakiCorpus {
    gold: HashMap<String, PhonemeEntry>,
    silver: HashMap<String, PhonemeEntry>,
    gold_sha256: String,
    silver_sha256: String,
}

impl MisakiCorpus {
    pub fn load_us() -> Self {
        Self::from_maps(
            misaki_rs::data::load_us_gold(),
            misaki_rs::data::load_us_silver(),
        )
    }

    fn from_maps(
        gold: HashMap<String, PhonemeEntry>,
        silver: HashMap<String, PhonemeEntry>,
    ) -> Self {
        let gold_sha256 = canonical_digest(&gold);
        let silver_sha256 = canonical_digest(&silver);
        Self {
            gold,
            silver,
            gold_sha256,
            silver_sha256,
        }
    }

    pub fn gold_sha256(&self) -> &str {
        &self.gold_sha256
    }

    pub fn silver_sha256(&self) -> &str {
        &self.silver_sha256
    }

    pub fn audit_compatibility(
        &self,
        vocabulary: &std::collections::HashSet<char>,
    ) -> CorpusCompatibility {
        let mut report = CorpusCompatibility {
            compatible_entries: 0,
            entries: 0,
            incompatible_entries: 0,
            unsupported_symbols: BTreeMap::new(),
        };
        for entry in self.gold.values().chain(self.silver.values()) {
            report.entries += 1;
            let mut unsupported = BTreeSet::new();
            match entry {
                PhonemeEntry::Simple(phonemes) => {
                    collect_unsupported(phonemes, vocabulary, &mut unsupported);
                }
                PhonemeEntry::Tagged(entries) => {
                    for phonemes in entries.values().flatten() {
                        collect_unsupported(phonemes, vocabulary, &mut unsupported);
                    }
                }
            }
            if unsupported.is_empty() {
                report.compatible_entries += 1;
            } else {
                report.incompatible_entries += 1;
                for symbol in unsupported {
                    *report.unsupported_symbols.entry(symbol).or_default() += 1;
                }
            }
        }
        report
    }

    pub fn hint(&self, word: &str) -> Option<CorpusHint> {
        self.lookup_entry(word).map(|(_, entry)| hint(entry))
    }

    pub fn is_tagged(&self, word: &str) -> bool {
        self.lookup_entry(word)
            .is_some_and(|(_, entry)| matches!(entry, PhonemeEntry::Tagged(_)))
    }

    pub fn resolve_simple(&self, word: &str) -> Option<CorpusResolution> {
        if let Some((origin, entry)) = self.lookup_entry(word)
            && let Some(phonemes) = simple_phonemes(entry)
        {
            return Some(CorpusResolution { origin, phonemes });
        }

        if let Some(base) = possessive_base(word)
            && let Some(mut resolution) = self.resolve_simple(base)
        {
            resolution
                .phonemes
                .push_str(possessive_suffix(&resolution.phonemes));
            resolution.origin = CorpusOrigin::Compound;
            return Some(resolution);
        }

        let components = split_compound(word)?;
        let mut resolved = Vec::with_capacity(components.len());
        for component in components {
            let (_, entry) = self.lookup_entry(component)?;
            resolved.push(simple_phonemes(entry)?);
        }
        Some(CorpusResolution {
            origin: CorpusOrigin::Compound,
            phonemes: resolved.join(""),
        })
    }

    fn lookup_entry(&self, word: &str) -> Option<(CorpusOrigin, &PhonemeEntry)> {
        let candidates = lookup_candidates(word);
        for candidate in &candidates {
            if let Some(entry) = self.gold.get(candidate) {
                return Some((CorpusOrigin::Gold, entry));
            }
        }
        for candidate in &candidates {
            if let Some(entry) = self.silver.get(candidate) {
                return Some((CorpusOrigin::Silver, entry));
            }
        }
        None
    }
}

pub fn normalize_phonemes(value: &str) -> String {
    value
        .replace(['\u{200b}', '\u{200c}', '\u{200d}', '\u{feff}'], "")
        // Kokoro's vocabulary has a schwa and `n`, but not Misaki's
        // combining syllabic consonant mark. Pin the one corpus
        // normalization we can express without changing the consonant.
        .replace("n\u{0329}", "ᵊn")
}

pub fn validate_phonemes(
    phonemes: &str,
    mut supported: impl FnMut(char) -> bool,
) -> Result<(), String> {
    let phonemes = normalize_phonemes(phonemes);
    if phonemes.trim().is_empty() {
        return Err("pronunciation is empty".to_string());
    }
    if phonemes.contains(['{', '}']) {
        return Err("pronunciation contains source syntax".to_string());
    }
    if let Some(character) = phonemes
        .chars()
        .find(|character| !character.is_whitespace() && !supported(*character))
    {
        return Err(format!(
            "pronunciation contains unsupported Kokoro symbol {character:?}"
        ));
    }
    Ok(())
}

fn lookup_candidates(word: &str) -> Vec<String> {
    let apostrophe = word.replace(['’', '‘'], "'");
    let lower = apostrophe.to_lowercase();
    let capitalized = {
        let mut characters = lower.chars();
        characters
            .next()
            .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
            .unwrap_or_default()
    };
    let mut output = Vec::new();
    for candidate in [word.to_string(), apostrophe, lower, capitalized] {
        if !output.contains(&candidate) {
            output.push(candidate);
        }
    }
    output
}

fn split_compound(word: &str) -> Option<Vec<&str>> {
    if !word.contains(['-', '_']) {
        return None;
    }
    let components = word.split(['-', '_']).collect::<Vec<_>>();
    components
        .iter()
        .all(|component| !component.is_empty())
        .then_some(components)
}

fn possessive_base(word: &str) -> Option<&str> {
    word.strip_suffix("'s")
        .or_else(|| word.strip_suffix("’s"))
        .or_else(|| word.strip_suffix("‘s"))
        .filter(|base| !base.is_empty())
}

fn possessive_suffix(phonemes: &str) -> &'static str {
    let final_phone = phonemes
        .chars()
        .rev()
        .find(|character| character.is_alphabetic())
        .unwrap_or_default();
    if matches!(final_phone, 's' | 'z' | 'ʃ' | 'ʒ' | 'ʧ' | 'ʤ') {
        "ᵻz"
    } else if matches!(final_phone, 'p' | 't' | 'k' | 'f' | 'θ') {
        "s"
    } else {
        "z"
    }
}

fn collect_unsupported(
    phonemes: &str,
    vocabulary: &std::collections::HashSet<char>,
    unsupported: &mut BTreeSet<char>,
) {
    for symbol in normalize_phonemes(phonemes).chars() {
        if !symbol.is_whitespace() && !vocabulary.contains(&symbol) {
            unsupported.insert(symbol);
        }
    }
}

fn hint(entry: &PhonemeEntry) -> CorpusHint {
    if let Some(phonemes) = simple_phonemes(entry) {
        return CorpusHint::Simple(phonemes);
    }
    match entry {
        PhonemeEntry::Simple(phonemes) => CorpusHint::Simple(normalize_phonemes(phonemes)),
        PhonemeEntry::Tagged(entries) => CorpusHint::Tagged(
            entries
                .iter()
                .map(|(tag, phonemes)| (tag.clone(), phonemes.as_deref().map(normalize_phonemes)))
                .collect(),
        ),
    }
}

fn simple_phonemes(entry: &PhonemeEntry) -> Option<String> {
    match entry {
        PhonemeEntry::Simple(phonemes) => Some(normalize_phonemes(phonemes)),
        PhonemeEntry::Tagged(entries) => {
            let values = entries
                .values()
                .flatten()
                .map(|value| normalize_phonemes(value))
                .filter(|value| !value.is_empty())
                .collect::<BTreeSet<_>>();
            (values.len() == 1).then(|| values.into_iter().next().unwrap())
        }
    }
}

fn canonical_digest(entries: &HashMap<String, PhonemeEntry>) -> String {
    let mut keys = entries.keys().collect::<Vec<_>>();
    keys.sort();
    let mut digest = Sha256::new();
    for key in keys {
        digest.update((key.len() as u64).to_be_bytes());
        digest.update(key.as_bytes());
        match &entries[key] {
            PhonemeEntry::Simple(phonemes) => {
                digest.update([0]);
                let phonemes = normalize_phonemes(phonemes);
                digest.update((phonemes.len() as u64).to_be_bytes());
                digest.update(phonemes.as_bytes());
            }
            PhonemeEntry::Tagged(tags) => {
                digest.update([1]);
                let mut tags = tags.iter().collect::<Vec<_>>();
                tags.sort_by(|left, right| left.0.cmp(right.0));
                digest.update((tags.len() as u64).to_be_bytes());
                for (tag, phonemes) in tags {
                    digest.update((tag.len() as u64).to_be_bytes());
                    digest.update(tag.as_bytes());
                    match phonemes {
                        Some(phonemes) => {
                            digest.update([1]);
                            let phonemes = normalize_phonemes(phonemes);
                            digest.update((phonemes.len() as u64).to_be_bytes());
                            digest.update(phonemes.as_bytes());
                        }
                        None => digest.update([0]),
                    }
                }
            }
        }
    }
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> MisakiCorpus {
        MisakiCorpus::from_maps(
            HashMap::from([
                ("word".to_string(), PhonemeEntry::Simple("wɜɹd".to_string())),
                (
                    "same".to_string(),
                    PhonemeEntry::Tagged(HashMap::from([
                        ("NOUN".to_string(), Some("sAIm".to_string())),
                        ("VERB".to_string(), Some("sAIm".to_string())),
                    ])),
                ),
                (
                    "record".to_string(),
                    PhonemeEntry::Tagged(HashMap::from([
                        ("NOUN".to_string(), Some("ɹɛkɚd".to_string())),
                        ("VERB".to_string(), Some("ɹɪkɔɹd".to_string())),
                    ])),
                ),
            ]),
            HashMap::from([(
                "Silver".to_string(),
                PhonemeEntry::Simple("sɪlvɚ\u{200d}".to_string()),
            )]),
        )
    }

    #[test]
    fn resolves_gold_before_silver_and_normalizes_case_joiners_and_compounds() {
        let corpus = fixture();
        assert_eq!(
            corpus.resolve_simple("WORD").unwrap().origin,
            CorpusOrigin::Gold
        );
        assert_eq!(corpus.resolve_simple("silver").unwrap().phonemes, "sɪlvɚ");
        assert_eq!(
            corpus.resolve_simple("word-silver").unwrap().origin,
            CorpusOrigin::Compound
        );
    }

    #[test]
    fn collapses_equivalent_tags_but_keeps_contextual_entries_ambiguous() {
        assert!(fixture().resolve_simple("same").is_some());
        assert!(fixture().resolve_simple("record").is_none());
        assert!(matches!(
            fixture().hint("record"),
            Some(CorpusHint::Tagged(_))
        ));
    }

    #[test]
    fn canonical_hashes_ignore_hash_map_iteration_order() {
        let left = fixture();
        let mut entries = left.gold.clone().into_iter().collect::<Vec<_>>();
        entries.reverse();
        let right = MisakiCorpus::from_maps(entries.into_iter().collect(), left.silver.clone());
        assert_eq!(left.gold_sha256(), right.gold_sha256());
        assert_eq!(left.silver_sha256(), right.silver_sha256());
    }

    #[test]
    fn rejects_empty_source_syntax_and_unsupported_symbols() {
        assert!(validate_phonemes("", |_| true).is_err());
        assert!(validate_phonemes("{x}", |_| true).is_err());
        assert!(validate_phonemes("ab☃", |character| character != '☃').is_err());
    }

    #[test]
    fn normalizes_syllabic_n_and_resolves_productive_possessives() {
        assert_eq!(normalize_phonemes("ɹɪʔn\u{0329}"), "ɹɪʔᵊn");
        let corpus = fixture();
        assert_eq!(corpus.resolve_simple("word's").unwrap().phonemes, "wɜɹdz");
    }

    #[test]
    fn audits_every_corpus_entry_against_the_active_vocabulary() {
        let corpus = fixture();
        let vocabulary = "wɜɹdsAImɛkɚɪɔlvᵊnz"
            .chars()
            .collect::<std::collections::HashSet<_>>();
        let report = corpus.audit_compatibility(&vocabulary);
        assert_eq!(report.entries, 4);
        assert_eq!(report.compatible_entries, 4);

        let report = corpus.audit_compatibility(&std::collections::HashSet::new());
        assert_eq!(report.incompatible_entries, 4);
        assert!(!report.unsupported_symbols.is_empty());
    }
}
