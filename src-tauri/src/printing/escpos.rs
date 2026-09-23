//! ESC/POS encoder for 80mm thermal printers (Xprinter).
//!
//! Text model: the printer prints LEFT→RIGHT, so Arabic lines are reordered
//! into visual order (runs reversed) and encoded in the configured codepage.
//! Arabic glyph shaping is performed by the printer firmware on models that
//! support the Arabic codepage; the codepage index is configurable
//! (`printer.codepage`) because it differs between Xprinter models. A
//! guaranteed-legible `LATIN` mode (bilingual templates) is also available.
//!
//! Every drawing call also records a [`PreviewOp`] (see `printing::ir`), so the
//! same template run feeds both the printer and the on-screen preview.

use super::ir::{to_hex, PreviewOp, PrintDoc};
use serde::Serialize;

pub const ESC: u8 = 0x1B;
pub const GS: u8 = 0x1D;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
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

/// Active ESC/POS attributes — captured per text line for the preview.
#[derive(Debug, Clone, Copy)]
struct Attrs {
    align: Align,
    bold: bool,
    width: u8,
    height: u8,
}

impl Default for Attrs {
    fn default() -> Self {
        Self {
            align: Align::Left,
            bold: false,
            width: 1,
            height: 1,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EscPos {
    buf: Vec<u8>,
    pub arabic_mode: ArabicMode,
    /// ESC/POS codepage index sent with `ESC t n`.
    pub codepage: u8,
    attrs: Attrs,
    /// Preview operations, recorded in emission order.
    ops: Vec<PreviewOp>,
}

impl EscPos {
    pub fn new(arabic_mode: ArabicMode, codepage: u8) -> Self {
        let mut p = Self {
            buf: Vec::new(),
            arabic_mode,
            codepage,
            attrs: Attrs::default(),
            ops: Vec::new(),
        };
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
        self.attrs.align = a;
        self.buf.extend_from_slice(&[ESC, b'a', n]);
    }

    pub fn bold(&mut self, on: bool) {
        self.attrs.bold = on;
        self.buf
            .extend_from_slice(&[ESC, b'E', if on { 1 } else { 0 }]);
    }

    /// Character size multiplier (1..=3 per axis).
    pub fn size(&mut self, w: u8, h: u8) {
        let w = w.clamp(1, 3);
        let h = h.clamp(1, 3);
        let n = ((w - 1) << 4) | (h - 1);
        self.attrs.width = w;
        self.attrs.height = h;
        self.buf.extend_from_slice(&[GS, b'!', n]);
    }

    /// A preview-only line. It is intentionally not emitted as ESC/POS bytes.
    /// Used for screen-only contact details that must not alter printer output.
    pub fn preview_line(&mut self, text: &str) {
        self.ops.push(PreviewOp::Text {
            text: self.printed_text(text),
            align: self.attrs.align,
            bold: self.attrs.bold,
            width: self.attrs.width,
            height: self.attrs.height,
        });
    }

    /// A text line (encoded + reordered) followed by LF.
    pub fn line(&mut self, text: &str) {
        // The preview records the line exactly as the printer receives it, so
        // preview text and printer bytes are produced from one code path.
        self.ops.push(PreviewOp::Text {
            text: self.printed_text(text),
            align: self.attrs.align,
            bold: self.attrs.bold,
            width: self.attrs.width,
            height: self.attrs.height,
        });
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

    /// Emit the existing two thermal lines for an item and record their source
    /// values as one semantic preview operation. No price is derived here.
    pub fn item(&mut self, name: &str, quantity: &str, unit_price: &str, line_total: &str) {
        let first = format!("{name} x{quantity}");
        let pad = 42usize.saturating_sub(line_total.chars().count()).max(1);
        let second = format!("{}{line_total}", " ".repeat(pad));
        self.ops.push(PreviewOp::Item {
            name: self.printed_text(name),
            quantity: quantity.to_string(),
            unit_price: unit_price.to_string(),
            line_total: self.printed_text(line_total),
            align: self.attrs.align,
        });
        self.append_printed_lines(&[first, second]);
    }

    /// Emit one authoritative financial line and expose its label/value to the
    /// screen renderer without recalculating either value in the frontend.
    pub fn financial(&mut self, label: &str, value: &str, total: bool) {
        let pad = 42usize
            .saturating_sub(value.chars().count() + label.chars().count())
            .max(1);
        let line = format!("{label}{}{value}", " ".repeat(pad));
        self.ops.push(PreviewOp::Financial {
            label: self.printed_text(label),
            value: self.printed_text(value),
            total,
            align: self.attrs.align,
        });
        self.append_printed_lines(&[line]);
    }

    fn append_printed_lines(&mut self, lines: &[String]) {
        for line in lines {
            let bytes = self.encode_line(line);
            self.buf.extend_from_slice(&bytes);
            self.buf.push(b'\n');
        }
    }

    pub fn hr(&mut self, width: usize) {
        self.line(&"-".repeat(width));
    }

    pub fn feed(&mut self, n: u8) {
        self.ops.push(PreviewOp::Feed { lines: n });
        self.buf.extend_from_slice(&[ESC, b'd', n]);
    }

    /// GS V 0 — full cut with feed.
    pub fn cut(&mut self) {
        self.feed(3);
        self.ops.push(PreviewOp::Cut);
        self.buf.extend_from_slice(&[GS, b'V', 0]);
    }

    /// GS v 0 — raster bit image (monochrome), width ≤ 576 dots.
    pub fn raster(&mut self, width_dots: usize, height_dots: usize, data: &[u8]) {
        self.ops.push(PreviewOp::Logo {
            width_dots,
            height_dots,
            bits_hex: to_hex(data),
            align: self.attrs.align,
        });
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

    /// Finish the document: cut + both artefacts (printer bytes and preview).
    pub fn finish(mut self) -> PrintDoc {
        self.cut();
        PrintDoc {
            escpos: self.buf,
            ops: self.ops,
        }
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

    /// The line exactly as the printer receives it, decoded back to text:
    /// same reordering and same codepage mapping as [`Self::encode_line`].
    fn printed_text(&self, text: &str) -> String {
        let reordered = bidi_line(text);
        match self.arabic_mode {
            ArabicMode::Cp1256 => decode_cp1256(&encode_cp1256(&reordered)),
            ArabicMode::Latin => strip_arabic(&reordered),
        }
    }
}

/// Preserve Unicode logical order for the Arabic-capable printer firmware.
/// The firmware performs Arabic contextual shaping and visual ordering. Doing
/// a second run reversal in Rust reverses the letters inside each word before
/// shaping and is the source of broken character order.
pub fn bidi_line(text: &str) -> String {
    text.to_owned()
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
        '\u{060C}' => 0xA1,                                   // Arabic comma
        '\u{061B}' => 0xBA,                                   // Arabic semicolon
        '\u{061F}' => 0xBF,                                   // Arabic question mark
        '\u{0660}'..='\u{0669}' => 0x30 + (c - 0x0660) as u8, // Arabic-Indic digits → ASCII
        '\u{2013}' | '\u{2014}' => b'-',
        '\u{00A0}' => b' ',
        _ => b'?',
    }
}

/// CP1256 byte → character: the exact inverse of [`cp1256_byte`] for every
/// byte that function can emit. Used to render the preview from the same bytes
/// the printer receives (the preview text IS the printed text).
pub fn decode_cp1256(bytes: &[u8]) -> String {
    bytes.iter().map(|b| cp1256_char(*b)).collect()
}

fn cp1256_char(b: u8) -> char {
    match b {
        0x00..=0x7F => b as char,
        0xA1 => '\u{060C}',
        0xBA => '\u{061B}',
        0xBF => '\u{061F}',
        0xC1..=0xD6 => char::from_u32(0x0621 + (b - 0xC1) as u32).unwrap_or('?'),
        0xD8 => '\u{0637}',
        0xD9 => '\u{0638}',
        0xDA => '\u{0639}',
        0xDB => '\u{063A}',
        0xE0 => '\u{0640}',
        0xE1..=0xF2 => char::from_u32(0x0641 + (b - 0xE1) as u32).unwrap_or('?'),
        0xF3 => '\u{0670}',
        // Mirrors `cp1256_byte` for the bytes it can actually produce.
        0xF4..=0xFF => char::from_u32(0x0679 + (b - 0xF4) as u32).unwrap_or('?'),
        _ => '?',
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
    fn preview_text_round_trips_through_the_printer_codepage() {
        // Every character a template can print must decode back to what the
        // preview shows, and re-encode to the same byte (no preview drift).
        let sample = "ستيشن كافيه — الإجمالي الفرعي 240.00 (خصم) [x2] أ ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ل م ن ه و ي";
        for ch in sample.chars() {
            let byte = cp1256_byte(ch);
            assert_eq!(cp1256_byte(cp1256_char(byte)), byte, "char {ch:?}");
        }
        assert_eq!(
            encode_cp1256(&decode_cp1256(&encode_cp1256(sample))),
            encode_cp1256(sample)
        );
        // The em dash is printed as a plain dash — the preview shows a dash.
        assert_eq!(decode_cp1256(&encode_cp1256("—")), "-");
        // Arabic-Indic digits are printed as ASCII digits.
        assert_eq!(decode_cp1256(&encode_cp1256("١٢")), "12");
    }

    #[test]
    fn encoder_records_preview_ops_that_match_the_printed_lines() {
        let mut p = EscPos::new(ArabicMode::Cp1256, 22);
        p.align(Align::Center);
        p.bold(true);
        p.line("ستيشن كافيه");
        p.size(2, 2);
        p.line("الإجمالي 240.00");
        let doc = p.finish();
        assert_eq!(doc.ops.len(), 4, "two lines + feed + cut");
        match &doc.ops[0] {
            PreviewOp::Text {
                text,
                align,
                bold,
                width,
                height,
            } => {
                assert_eq!(*align, Align::Center);
                assert!(*bold);
                assert_eq!((*width, *height), (1, 1));
                // Exactly the bytes the printer receives, decoded back.
                assert_eq!(
                    encode_cp1256(text),
                    encode_cp1256(&bidi_line("ستيشن كافيه"))
                );
            }
            other => panic!("expected a text op, got {other:?}"),
        }
        match &doc.ops[1] {
            PreviewOp::Text {
                text,
                width,
                height,
                ..
            } => {
                assert_eq!((*width, *height), (2, 2));
                assert!(text.contains("240.00"));
            }
            other => panic!("expected a text op, got {other:?}"),
        }
        assert_eq!(doc.ops[2], PreviewOp::Feed { lines: 3 });
        assert_eq!(doc.ops[3], PreviewOp::Cut);
    }

    #[test]
    fn semantic_preview_ops_emit_the_existing_printer_bytes() {
        let mut old = EscPos::new(ArabicMode::Cp1256, 22);
        old.align(Align::Right);
        old.line("قهوة x2");
        old.kv_line("", "100.00", 42);
        old.kv_line("الإجمالي", "100.00", 42);
        let old = old.finish();

        let mut semantic = EscPos::new(ArabicMode::Cp1256, 22);
        semantic.align(Align::Right);
        semantic.item("قهوة", "2", "50.00", "100.00");
        semantic.financial("الإجمالي", "100.00", true);
        let doc = semantic.finish();

        assert_eq!(
            doc.escpos, old.escpos,
            "screen semantics must not change printer bytes"
        );
        assert!(matches!(doc.ops[0], PreviewOp::Item { .. }));
        assert!(matches!(
            doc.ops[1],
            PreviewOp::Financial { total: true, .. }
        ));
    }

    #[test]
    fn bidi_preserves_logical_arabic_for_printer_shaping() {
        assert_eq!(bidi_line("اجمالي 240.00"), "اجمالي 240.00");
        assert_eq!(bidi_line("ستيشن كافيه"), "ستيشن كافيه");
        assert_eq!(bidi_line("INV-000012"), "INV-000012");
    }

    #[test]
    fn encoder_emits_init_and_cut() {
        let mut p = EscPos::new(ArabicMode::Cp1256, 22);
        p.line("اجمالي");
        p.feed(2);
        let bytes = p.finish().escpos;
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
