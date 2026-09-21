//! ESC/POS encoder for 80mm thermal printers (Xprinter).
//!
//! Text model: the printer prints LEFT→RIGHT, so Arabic lines are reordered
//! into visual order (runs reversed) and encoded in the configured codepage.
//! Arabic glyph shaping is performed by the printer firmware on models that
//! support the Arabic codepage; the codepage index is configurable
//! (`printer.codepage`) because it differs between Xprinter models. A
//! guaranteed-legible `LATIN` mode (bilingual templates) is also available.

pub const ESC: u8 = 0x1B;
pub const GS: u8 = 0x1D;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// How Arabic text is emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArabicMode {
    /// CP1256 bytes (printer must support the Arabic codepage).
    Cp1256,
    /// Arabic is stripped; bilingual templates supply Latin fallbacks.
    Latin,
}

#[derive(Debug, Clone)]
pub struct EscPos {
    buf: Vec<u8>,
    pub arabic_mode: ArabicMode,
    /// ESC/POS codepage index sent with `ESC t n`.
    pub codepage: u8,
}

impl EscPos {
    pub fn new(arabic_mode: ArabicMode, codepage: u8) -> Self {
        let mut p = Self { buf: Vec::new(), arabic_mode, codepage };
        p.init();
        p
    }

    /// ESC @ — reset, then select the codepage.
    pub fn init(&mut self) {
        self.buf.extend_from_slice(&[ESC, b'@']);
        self.buf.extend_from_slice(&[ESC, b't', self.codepage]);
    }

    pub fn raw(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn align(&mut self, a: Align) {
        let n = match a {
            Align::Left => 0,
            Align::Center => 1,
            Align::Right => 2,
        };
        self.buf.extend_from_slice(&[ESC, b'a', n]);
    }

    pub fn bold(&mut self, on: bool) {
        self.buf.extend_from_slice(&[ESC, b'E', if on { 1 } else { 0 }]);
    }

    /// Character size multiplier (1..=3 per axis).
    pub fn size(&mut self, w: u8, h: u8) {
        let n = ((w.clamp(1, 3) - 1) << 4) | (h.clamp(1, 3) - 1);
        self.buf.extend_from_slice(&[GS, b'!', n]);
    }

    /// A text line (encoded + reordered) followed by LF.
    pub fn line(&mut self, text: &str) {
        let bytes = self.encode_line(text);
        self.buf.extend_from_slice(&bytes);
        self.buf.push(b'\n');
    }

    /// Two-column line: label right, value left (RTL layout, 80mm = 42 chars).
    pub fn kv_line(&mut self, label: &str, value: &str, width: usize) {
        let pad = width
            .saturating_sub(value.chars().count() + label.chars().count())
            .max(1);
        let line = format!("{label}{}{value}", " ".repeat(pad));
        self.line(&line);
    }

    pub fn hr(&mut self, width: usize) {
        self.line(&"-".repeat(width));
    }

    pub fn feed(&mut self, n: u8) {
        self.buf.extend_from_slice(&[ESC, b'd', n]);
    }

    /// GS V 0 — full cut with feed.
    pub fn cut(&mut self) {
        self.feed(3);
        self.buf.extend_from_slice(&[GS, b'V', 0]);
    }

    /// GS v 0 — raster bit image (monochrome), width ≤ 576 dots.
    pub fn raster(&mut self, width_dots: usize, height_dots: usize, data: &[u8]) {
        let width_bytes = width_dots.div_ceil(8);
        self.buf.extend_from_slice(&[
            GS,
            b'v',
            b'0',
            0,
            (width_bytes & 0xFF) as u8,
            ((width_bytes >> 8) & 0xFF) as u8,
            (height_dots & 0xFF) as u8,
            ((height_dots >> 8) & 0xFF) as u8,
        ]);
        self.buf.extend_from_slice(data);
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.cut();
        self.buf
    }

    pub fn buffer(&self) -> &[u8] {
        &self.buf
    }

    /// Encode one logical line: bidi-reorder then codepage-encode.
    fn encode_line(&self, text: &str) -> Vec<u8> {
        let reordered = bidi_line(text);
        match self.arabic_mode {
            ArabicMode::Cp1256 => encode_cp1256(&reordered),
            ArabicMode::Latin => strip_arabic(&reordered).into_bytes(),
        }
    }
}

/// Visual reordering for RTL: reverse the order of Arabic/other runs while
/// keeping the characters inside each run in their original order. Boundary
/// whitespace is preserved at the corresponding (mirrored) boundary so the
/// printed line keeps its spacing.
pub fn bidi_line(text: &str) -> String {
    #[derive(PartialEq)]
    enum Run {
        Arabic,
        Other,
    }
    let mut runs: Vec<(Run, String)> = Vec::new();
    for ch in text.chars() {
        let kind = if is_arabic(ch) { Run::Arabic } else { Run::Other };
        match runs.last_mut() {
            Some((k, s)) if *k == kind => s.push(ch),
            _ => runs.push((kind, ch.to_string())),
        }
    }
    if runs.len() < 2 {
        return text.to_string();
    }
    // Whitespace at an internal boundary is mirror-symmetric, so the same
    // flags applied in reversed order reproduce the intended spacing.
    let mut separators: Vec<bool> = (0..runs.len() - 1)
        .map(|i| runs[i].1.ends_with(' ') || runs[i + 1].1.starts_with(' '))
        .collect();
    separators.reverse();

    let trimmed: Vec<String> = runs.into_iter().map(|(_, s)| s.trim().to_string()).collect();
    let mut trimmed = trimmed;
    trimmed.reverse();
    let mut out = String::new();
    for (i, part) in trimmed.iter().enumerate() {
        if i > 0 && separators[i - 1] {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

fn is_arabic(ch: char) -> bool {
    matches!(ch as u32, 0x0600..=0x06FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

fn strip_arabic(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        if is_arabic(ch) {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = ch == ' ';
        }
    }
    out.trim().to_string()
}

/// CP1256 encoding for the Arabic block + ASCII pass-through.
pub fn encode_cp1256(text: &str) -> Vec<u8> {
    text.chars().map(cp1256_byte).collect()
}

fn cp1256_byte(ch: char) -> u8 {
    let c = ch as u32;
    if c < 0x80 {
        return c as u8;
    }
    match ch {
        '\u{0621}'..='\u{063A}' => {
            let off = c - 0x0621;
            match off {
                0..=0x15 => 0xC1 + off as u8, // U+0621..U+0636
                0x16 => 0xD8,                 // U+0637
                0x17 => 0xD9,                 // U+0638
                0x18 => 0xDA,                 // U+0639
                0x19 => 0xDB,                 // U+063A
                _ => b'?',
            }
        }
        '\u{0640}' => 0xE0, // tatweel
        '\u{0641}'..='\u{0652}' => 0xE1 + (c - 0x0641) as u8,
        '\u{0670}' => 0xF3,
        '\u{0679}'..='\u{06D5}' => 0xF4 + (c - 0x0679) as u8,
        '\u{060C}' => 0xA1, // Arabic comma
        '\u{061B}' => 0xBA, // Arabic semicolon
        '\u{061F}' => 0xBF, // Arabic question mark
        '\u{0660}'..='\u{0669}' => 0x30 + (c - 0x0660) as u8, // Arabic-Indic digits → ASCII
        '\u{2013}' | '\u{2014}' => b'-',
        '\u{00A0}' => b' ',
        _ => b'?',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cp1256_encodes_arabic_letters_and_digits() {
        assert_eq!(encode_cp1256("ال"), vec![0xC7, 0xE4]); // alef, lam
        assert_eq!(encode_cp1256("240.00"), b"240.00".to_vec());
        assert_eq!(encode_cp1256("١٢"), b"12".to_vec()); // Arabic-Indic digits
    }

    #[test]
    fn bidi_reorders_runs_for_rtl() {
        assert_eq!(bidi_line("اجمالي 240.00"), "240.00 اجمالي");
        assert_eq!(bidi_line("INV-000012"), "INV-000012");
    }

    #[test]
    fn encoder_emits_init_and_cut() {
        let mut p = EscPos::new(ArabicMode::Cp1256, 22);
        p.line("اجمالي");
        p.feed(2);
        let bytes = p.finish();
        assert!(bytes.starts_with(&[ESC, b'@']));
        assert!(bytes.windows(3).any(|w| w == [GS, b'V', 0]));
    }

    #[test]
    fn latin_mode_strips_arabic() {
        let mut p = EscPos::new(ArabicMode::Latin, 22);
        p.line("اجمالي 240.00");
        assert!(p.buffer().windows(4).any(|w| w == b"240."));
        assert!(!p.buffer().iter().any(|b| *b >= 0x80));
    }
}