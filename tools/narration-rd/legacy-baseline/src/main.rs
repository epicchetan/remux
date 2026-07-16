use std::io::{self, Read};

use misaki_rs::{G2P, Language};
use serde::Serialize;
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenOutput {
    text: String,
    tag: String,
    phonemes: Option<String>,
}

#[derive(Serialize)]
struct CaseOutput {
    input: String,
    phonemes: String,
    tokens: Vec<TokenOutput>,
}

fn normalize(value: &str) -> String {
    value
        .replace(['’', '‘'], "'")
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .collect()
}

fn main() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| error.to_string())?;
    let cases: Vec<String> = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let mut g2p = G2P::new(Language::EnglishUS);
    g2p.unk.clear();
    let mut output = Vec::new();
    for value in cases {
        let normalized = normalize(&value);
        let (phonemes, tokens) = g2p.g2p(&normalized).map_err(|error| error.to_string())?;
        output.push(CaseOutput {
            input: value,
            phonemes,
            tokens: tokens
                .into_iter()
                .map(|token| TokenOutput {
                    text: token.text,
                    tag: token.tag,
                    phonemes: token.phonemes,
                })
                .collect(),
        });
    }
    println!("{}", serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?);
    Ok(())
}
