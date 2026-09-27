//! INVOICE PRINT PRESENTATION — the print-layer rules for money, date, time and
//! the metadata/header block of every invoice & receipt.
//!
//! # Why this module exists
//!
//! Station has an application-wide currency label and application-wide
//! date/time formatting for the screen. **Paper is a different medium and has
//! its own rules**, so this module deliberately does NOT read the global
//! currency label and does NOT call the global date/time formatters:
//!
//! * Money on an invoice is stated once, in words, as Egyptian pounds
//!   ([`INVOICE_CURRENCY_NOTE`]). It never inherits the app's currency
//!   abbreviation, so changing the on-screen currency can never change what a
//!   printed invoice claims its amounts are.
//! * The printed date is a fixed, unambiguous numeric invoice date
//!   ([`invoice_date`], `DD/MM/YYYY`).
//! * The printed time is a fixed 12-hour receipt time ([`invoice_time`]).
//! * The identity block is a full-width, two-column metadata section built by
//!   [`meta_row`] / [`meta_timestamp`], so it occupies the same printable width
//!   model as the item table underneath it.
//!
//! Every rule lives here, so the cafe invoice, the wash invoice, the hybrid
//! invoice, the takeaway receipt and the checkout preview all present an
//! identical header — there is no per-template formatting to drift.

use super::super::escpos::{Align, ArabicMode, EscPos};
use super::shared::WIDTH;
use chrono::{DateTime, Datelike, Timelike};
use chrono_tz::Tz;

/// The one sentence that says what the numbers on an invoice are.
///
/// Print-domain only, and intentionally NOT the application's currency label:
/// a printed invoice always states Egyptian pounds in full, whatever the
/// screen is configured to display.
pub(super) const INVOICE_CURRENCY_NOTE: &str = "المبالغ بالجنيه المصري";

/// The same statement for the `LATIN` fallback mode, where the Arabic note is
/// stripped from the printed line. Without it that mode would print a blank
/// currency line.
const INVOICE_CURRENCY_NOTE_LATIN: &str = "AMOUNTS IN EGP";

/// Label of the printed date row.
const DATE_LABEL: &str = "التاريخ";
/// Label of the printed time row.
const TIME_LABEL: &str = "الوقت";

/// The currency sentence for the configured Arabic mode.
pub(super) fn invoice_currency_note(mode: ArabicMode) -> &'static str {
    match mode {
        ArabicMode::Latin => INVOICE_CURRENCY_NOTE_LATIN,
        ArabicMode::Cp1256 => INVOICE_CURRENCY_NOTE,
    }
}

/// The business-local wall clock of a stored instant, or `None` when the stored
/// value cannot be read as an instant.
///
/// This reuses Station's canonical business timezone so paper never disagrees
/// with the screen about *which moment* it is; only the *formatting* below is
/// print-specific.
fn business_local(value: &str) -> Option<DateTime<Tz>> {
    crate::time::parse_timestamp(value)
        .map(|instant| instant.with_timezone(&crate::time::BUSINESS_TZ))
}

/// The invoice date of a stored instant: `DD/MM/YYYY`.
///
/// Compact, unambiguous and identical on every invoice type. A value that is
/// not a readable instant is passed through unchanged, so a document is never
/// left with a blank date.
pub(super) fn invoice_date(value: &str) -> String {
    match business_local(value) {
        Some(local) => format!(
            "{:02}/{:02}/{:04}",
            local.day(),
            local.month(),
            local.year()
        ),
        None => value.to_string(),
    }
}

/// The invoice time of a stored instant: `hh:mm AM` / `hh:mm PM`.
///
/// Twelve-hour with a meridiem suffix — the shape a thermal receipt is scanned
/// for. An unreadable value is passed through unchanged.
pub(super) fn invoice_time(value: &str) -> String {
    match business_local(value) {
        Some(local) => invoice_time_of(local),
        None => value.to_string(),
    }
}

/// The print time of an already business-local wall clock.
fn invoice_time_of(local: DateTime<Tz>) -> String {
    let meridiem = if local.hour() < 12 { "AM" } else { "PM" };
    // `hour12` yields (is_pm, 1..=12); the meridiem above is the same fact.
    let (_, twelve) = local.hour12();
    format!("{twelve:02}:{:02} {meridiem}", local.minute())
}

/// One metadata row of the invoice/receipt identity block.
///
/// `emphasis` is the print typographic hierarchy: the document's own moment is
/// set apart by weight, never by enlarging the cell — an 80mm receipt has one
/// cell size and the metadata must not compete with the title or the total.
pub(super) fn meta_row(p: &mut EscPos, label: &str, value: &str) {
    p.meta(label, value, WIDTH, false);
}

/// A metadata row set apart by weight — used for the date and the time.
pub(super) fn meta_row_emphasis(p: &mut EscPos, label: &str, value: &str) {
    p.meta(label, value, WIDTH, true);
}

/// The printed date and time of a stored instant, as two full-width rows.
///
/// Two compact rows rather than one long datetime: the date is unambiguous on
/// its own, the time is scannable on its own, and both sit at the same
/// typographic weight as the rest of the identity block.
pub(super) fn meta_timestamp(p: &mut EscPos, value: &str) {
    meta_row_emphasis(p, DATE_LABEL, &invoice_date(value));
    meta_row_emphasis(p, TIME_LABEL, &invoice_time(value));
}

/// One metadata row that states a moment in the print-layer format, for
/// documents that carry a single timestamp rather than a date and a time.
pub(super) fn meta_moment(p: &mut EscPos, label: &str, value: &str) {
    match business_local(value) {
        Some(local) => {
            let moment = format!("{} {}", invoice_date(value), invoice_time_of(local));
            meta_row_emphasis(p, label, &moment);
        }
        None => meta_row(p, label, value),
    }
}

/// Open the invoice/receipt identity block: same alignment, same printable
/// width, for every template.
pub(super) fn open_meta_block(p: &mut EscPos) {
    p.align(Align::Right);
}

/// Close the identity block and hand the page to the item table.
pub(super) fn close_meta_block(p: &mut EscPos) {
    p.hr(WIDTH);
}

/// The printed TEXT lines of a document, decoded back from the bytes.
///
/// Every ESC/POS control sequence is removed first (each command has a known
/// parameter count), so what is left is exactly the characters the printer puts
/// on the paper and nothing else. Test-only: it exists so the width of real
/// paper can be asserted rather than guessed.
#[cfg(test)]
pub(super) fn printed_text_lines(doc: &crate::printing::ir::PrintDoc) -> Vec<String> {
    use crate::printing::escpos::{ESC, GS};

    /// Parameter bytes that follow a command byte.
    fn params(command: u8) -> usize {
        match command {
            b'@' => 0,                      // ESC @   — reset
            b't' | b'a' | b'E' | b'd' => 1, // ESC t/a/E/d
            b'!' => 1,                      // GS !    — character size
            b'v' => 3,                      // GS v    — raster image
            b'V' => 1,                      // GS V    — cut
            _ => 0,
        }
    }

    let mut text = Vec::new();
    let mut line = Vec::new();
    let mut bytes = doc.escpos.iter().copied().peekable();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\n' => {
                if !line.is_empty() {
                    text.push(String::from_utf8_lossy(&line).to_string());
                }
                line.clear();
            }
            ESC | GS => {
                if let Some(command) = bytes.next() {
                    for _ in 0..params(command) {
                        bytes.next();
                    }
                }
            }
            other => line.push(other),
        }
    }
    if !line.is_empty() {
        text.push(String::from_utf8_lossy(&line).to_string());
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printing::ir::PreviewOp;

    #[test]
    fn invoice_currency_note_never_uses_an_abbreviation() {
        assert_eq!(
            invoice_currency_note(ArabicMode::Cp1256),
            "المبالغ بالجنيه المصري"
        );
        assert_eq!(invoice_currency_note(ArabicMode::Latin), "AMOUNTS IN EGP");
        for note in [
            invoice_currency_note(ArabicMode::Cp1256),
            invoice_currency_note(ArabicMode::Latin),
        ] {
            assert!(
                !note.contains('.'),
                "an invoice states the currency in full: {note}"
            );
            assert!(
                !note.contains("ج.م"),
                "must not follow the app label: {note}"
            );
        }
    }

    #[test]
    fn invoice_date_is_a_fixed_unambiguous_numeric_format() {
        // The printed date is the business-local (Cairo) calendar day.
        assert_eq!(invoice_date("2026-09-25 14:30:00Z"), "25/09/2026");
        // 22:30 UTC on the 26th is already the 27th in Cairo.
        assert_eq!(invoice_date("2026-09-26 22:30:00Z"), "27/09/2026");
        assert_eq!(invoice_date("2026-01-05 00:05:00Z"), "05/01/2026");
        // An unreadable value is never blanked out of a document.
        assert_eq!(invoice_date(""), "");
        assert_eq!(invoice_date("2026-09-25"), "2026-09-25");
    }

    #[test]
    fn invoice_time_is_a_fixed_twelve_hour_receipt_format() {
        // Cairo is UTC+3 in September (EEST): the printed clock is the café's.
        assert_eq!(invoice_time("2026-09-25 14:30:00Z"), "05:30 PM");
        assert_eq!(invoice_time("2026-09-26 00:30:00Z"), "03:30 AM");
        assert_eq!(invoice_time("2026-09-26 11:05:00Z"), "02:05 PM");
        assert_eq!(invoice_time("2026-09-26 23:59:00Z"), "02:59 AM");
        // The two boundaries a receipt must never get wrong.
        assert_eq!(invoice_time("2026-09-25 21:00:00Z"), "12:00 AM"); // midnight
        assert_eq!(invoice_time("2026-09-25 09:00:00Z"), "12:00 PM"); // noon
                                                                      // The legacy unmarked storage shape prints identically.
        assert_eq!(invoice_time("2026-09-25 14:30:00"), "05:30 PM");
        // Egypt is UTC+2 in winter, and the printed clock follows the tz
        // database rather than a fixed offset.
        assert_eq!(invoice_time("2026-01-15 14:30:00Z"), "04:30 PM");
    }

    #[test]
    fn a_metadata_row_prints_exactly_the_line_a_kv_line_prints() {
        let mut meta = EscPos::new(ArabicMode::Cp1256, 22);
        meta.meta("التاريخ", "25/09/2026", WIDTH, true);
        let meta = meta.finish();

        let mut plain = EscPos::new(ArabicMode::Cp1256, 22);
        plain.kv_line("التاريخ", "25/09/2026", WIDTH);
        let plain = plain.finish();

        assert_eq!(
            meta.escpos, plain.escpos,
            "the screen op must not move a single printed character"
        );
        assert!(matches!(meta.ops[0], PreviewOp::Meta { .. }));
    }

    /// The printed bytes of one metadata row fill the 42-cell printable width,
    /// so the identity block occupies the same canvas as the item table below.
    #[test]
    fn every_metadata_row_fills_the_full_printable_width() {
        let mut p = EscPos::new(ArabicMode::Cp1256, 22);
        open_meta_block(&mut p);
        meta_row(&mut p, "العميل", "أحمد");
        meta_row(&mut p, "الطاولة", "04");
        let doc = p.finish();

        let rows = printed_text_lines(&doc);
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(
                row.chars().count(),
                WIDTH,
                "row must span the paper: {row:?}"
            );
        }
    }

    /// Hierarchy by weight, not by bulk: the moment is emphasised, the rest is
    /// not, and nothing is enlarged.
    #[test]
    fn the_timestamp_is_emphasised_and_the_rest_is_not() {
        let mut p = EscPos::new(ArabicMode::Cp1256, 22);
        meta_timestamp(&mut p, "2026-09-25 14:30:00Z");
        meta_row(&mut p, "رقم الفاتورة", "000123");
        let doc = p.finish();

        let rows: Vec<(&str, &str, bool)> = doc
            .ops
            .iter()
            .filter_map(|op| match op {
                PreviewOp::Meta {
                    label,
                    value,
                    emphasis,
                    ..
                } => Some((label.as_str(), value.as_str(), *emphasis)),
                _ => None,
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("التاريخ", "25/09/2026", true),
                ("الوقت", "05:30 PM", true),
                ("رقم الفاتورة", "000123", false),
            ]
        );
    }

    /// The date and the time must never be confused with one another: a
    /// full-width two-column row is only safe if both values are short enough
    /// to keep their column.
    #[test]
    fn date_and_time_rows_never_overflow_their_column() {
        for instant in [
            "2026-09-25 14:30:00Z",
            "2026-01-01 00:00:00Z",
            "2026-12-31 23:59:59Z",
        ] {
            for (label, value) in [
                ("التاريخ", invoice_date(instant)),
                ("الوقت", invoice_time(instant)),
            ] {
                assert!(
                    label.chars().count() + value.chars().count() <= WIDTH,
                    "{label} {value} does not fit 42 cells"
                );
            }
        }
    }
}
