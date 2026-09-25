//! Station Cafe — identity normalization.
//!
//! Duplicate prevention compares a NORMALIZED form of a phone number or a
//! plate number, never the raw string the operator typed. "٠١٠٠ ١٢٣ ٤٥٦٧",
//! "01001234567" and "0100-123-4567" are one identity; "أ ب ج ١٢٣٤" and
//! "أبج 1234" are one vehicle.
//!
//! Normalization is deliberately conservative: it folds digits, case,
//! whitespace and separator noise only. Letters are preserved, so genuinely
//! distinct plates (different letters or different digit sequences) can never
//! collapse into one another.

/// Fold Arabic-Indic (U+0660..U+0669) and Extended Arabic-Indic
/// (U+06F0..U+06F9) digits into ASCII `0..9`.
fn fold_digits(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '٠'..='٩' => char::from(b'0' + (c as u32 - 0x0660) as u8),
            '۰'..='۹' => char::from(b'0' + (c as u32 - 0x06F0) as u8),
            other => other,
        })
        .collect()
}

/// Canonical comparison form of a phone number: ASCII digits only, with an
/// optional leading `+`. Returns `None` when nothing usable remains, so a
/// missing phone is never treated as a shared identity.
pub fn normalize_phone(raw: &str) -> Option<String> {
    let folded = fold_digits(raw);
    let mut out = String::with_capacity(folded.len());
    let mut plus = false;
    for (index, c) in folded.chars().enumerate() {
        if c == '+' && index == 0 {
            plus = true;
            continue;
        }
        if c.is_ascii_digit() {
            out.push(c);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(if plus { format!("+{out}") } else { out })
}

/// Canonical comparison form of a plate: upper case, ASCII digits, without
/// whitespace or separator noise. Letters (Arabic or Latin) are kept.
pub fn normalize_plate(raw: &str) -> Option<String> {
    let folded = fold_digits(raw).to_uppercase();
    let mut out = String::with_capacity(folded.len());
    for c in folded.chars() {
        if c.is_whitespace() || c == '-' || c == '_' || c == '–' || c == '—' {
            continue;
        }
        out.push(c);
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_normalization_folds_digits_and_separators() {
        assert_eq!(
            normalize_phone("01001234567").as_deref(),
            Some("01001234567")
        );
        assert_eq!(
            normalize_phone("0100 123 4567").as_deref(),
            Some("01001234567")
        );
        assert_eq!(
            normalize_phone("0100-123-4567").as_deref(),
            Some("01001234567")
        );
        assert_eq!(
            normalize_phone("٠١٠٠١٢٣٤٥٦٧").as_deref(),
            Some("01001234567")
        );
        assert_eq!(
            normalize_phone("+20 100 123 4567").as_deref(),
            Some("+201001234567")
        );
        assert_eq!(normalize_phone("  ").as_deref(), None);
        assert_eq!(normalize_phone("--").as_deref(), None);
    }

    #[test]
    fn plate_normalization_keeps_letters_but_folds_formatting() {
        assert_eq!(
            normalize_plate("أ ب ج ١٢٣٤").as_deref(),
            normalize_plate("أبج 1234").as_deref()
        );
        assert_eq!(
            normalize_plate("abc-123").as_deref(),
            normalize_plate(" ABC 123 ").as_deref()
        );
        // Distinct plates stay distinct.
        assert_ne!(
            normalize_plate("أ ب ج ١٢٣٤").as_deref(),
            normalize_plate("ب ج د ١٢٣٤").as_deref()
        );
        assert_ne!(
            normalize_plate("1234").as_deref(),
            normalize_plate("1235").as_deref()
        );
        assert_eq!(normalize_plate("  ").as_deref(), None);
    }
}
