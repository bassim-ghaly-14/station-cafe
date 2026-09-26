use super::super::escpos::{Align, EscPos};
use super::super::ir::PrintDoc;
use crate::money::format_minor_for_print;

/// Character cells per line on 80mm paper at font A.
pub const WIDTH: usize = 42; // characters per line on 80mm at font A

/*
INVOICE COMPOSITION — ONE SOURCE OF TRUTH
=========================================
`items_and_totals` below is the ONLY place invoice body composition lives.
Every invoice-shaped document — the persisted invoice, the persisted takeaway
receipt, the Checkout preview and the takeaway order preview — builds the same
neutral [`DocLine`]/[`DocTotals`] values and calls it. A document NEVER
re-implements the department loop, the subtotal arithmetic or the totals block.

The rules it owns, in one place:
  * Hybrid = the document carries BOTH departments. A cafe-only or wash-only
    document prints a clean flat item list with no department sections.
  * A hybrid document separates the departments and prints, per department,
    «إجمالي الكافيه الفرعي» / «إجمالي المغسلة الفرعي».
  * The invoice-level totals (subtotal → discount → service charge → total,
    then settlement) always follow the items, in that order.
*/

/// Business domains, in printed order, with their section heading and the
/// label of their separated subtotal.
const DEPARTMENTS: [(&str, &str, &str); 2] = [
    ("CAFE", "الكافيه", "إجمالي الكافيه الفرعي"),
    ("WASH", "المغسلة", "إجمالي المغسلة الفرعي"),
];

/// One printable line, independent of whether it came from a live order line
/// or from a persisted invoice-line snapshot.
pub(super) struct DocLine<'a> {
    pub department: &'a str,
    pub product_name: &'a str,
    pub unit_price: i64,
    pub quantity: i64,
    pub line_total: i64,
}

/// Settlement rows printed only by a settled document (a persisted invoice).
pub(super) struct DocSettlement {
    pub paid_amount: i64,
    /// Present only for a CREDIT invoice: what is still owed.
    pub credit_remaining: Option<i64>,
}

/// The money block of an invoice-shaped document.
pub(super) struct DocTotals {
    pub subtotal: i64,
    pub discount_minor: i64,
    pub service_charge_minor: i64,
    pub total: i64,
    /// Immutable per-department subtotals `(cafe, wash)` from a persisted
    /// invoice snapshot. `None` on a live order preview, where the subtotals
    /// are derived from the very line totals being printed.
    pub dept_subtotals: Option<(i64, i64)>,
    /// `None` for a pre-payment preview (nothing is settled yet).
    pub settlement: Option<DocSettlement>,
}

/// The one hybrid rule: a document is hybrid only when it carries BOTH
/// departments. Used for the document identity AND for the layout, so the
/// name a document is filed under and the layout it is printed with can never
/// disagree.
pub fn is_hybrid<'a, I: IntoIterator<Item = &'a str>>(departments: I) -> bool {
    let mut cafe = false;
    let mut wash = false;
    for department in departments {
        match department {
            "CAFE" => cafe = true,
            "WASH" => wash = true,
            _ => {}
        }
    }
    cafe && wash
}

/// The currency sentence carried by NON-invoice printed documents (shift and
/// day closing reports, printer test page).
///
/// Those documents are not invoices and are not part of the invoice print
/// system, so they keep following the application's global currency label.
/// Invoices and receipts never come through this constant.
const REPORT_CURRENCY_NOTE: &str = "المبالغ بالج.م";

/// Format a stored instant for paper, in Station business time.
///
/// A receipt must never disagree with the screen: both go through the same
/// canonical business-time conversion, so a sale at 17:30 prints 17:30 rather
/// than the raw UTC digits. An unparseable value is passed through unchanged
/// so a document is never left blank.
pub(super) fn stamp(value: &str) -> String {
    crate::time::to_business_datetime(value)
}

/// The document header of a NON-invoice document (shift/day closing, test
/// page): logo, title, subtitle, then the same currency sentence the
/// application uses on screen.
///
/// Invoice and receipt documents must NOT come through here — they use
/// [`invoice_header`], which states the currency in full and never follows the
/// application's currency label.
pub(super) fn header(p: &mut EscPos, logo: bool, title: &str, subtitle: &str) {
    header_with_currency(p, logo, title, subtitle, REPORT_CURRENCY_NOTE);
}

/// The document header of an INVOICE or RECEIPT.
///
/// Identical shape to [`header`], but the currency sentence is the print-layer
/// Egyptian-pound statement from the invoice domain, so no printed invoice can
/// ever carry the application's global currency abbreviation.
pub(super) fn invoice_header(p: &mut EscPos, logo: bool, title: &str, subtitle: &str) {
    let note = super::invoice_format::invoice_currency_note(p.arabic_mode);
    header_with_currency(p, logo, title, subtitle, note);
}

/// The one header implementation both variants share: only the currency
/// sentence differs, so the two document families can never disagree about
/// title/subtitle typography, alignment or the leading divider.
fn header_with_currency(
    p: &mut EscPos,
    logo: bool,
    title: &str,
    subtitle: &str,
    currency_note: &str,
) {
    if logo {
        if let Some((w, h, data)) = super::super::logo::logo_raster() {
            p.align(Align::Center);
            p.raster(*w, *h, data);
        }
    }
    p.align(Align::Center);
    p.bold(true);
    p.line(title);
    p.bold(false);
    p.line(subtitle);
    p.line(currency_note);
    p.hr(WIDTH);
    p.align(Align::Right);
}

pub(super) fn footer(mut p: EscPos) -> PrintDoc {
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("شكراً لزيارتكم — Station Cafe");
    p.preview_line("01154520775");
    p.finish()
}

/// The one invoice body composer. Every invoice-shaped document calls it.
pub(super) fn items_and_totals(
    p: &mut EscPos,
    lines: &[DocLine<'_>],
    totals: &DocTotals,
    // Printed inside the WASH section, where the department context is already
    // established (`None` when the document has no car snapshot).
    wash_note: Option<&str>,
) {
    if is_hybrid(lines.iter().map(|l| l.department)) {
        let mut first_section = true;
        for (dept, title, subtotal_label) in DEPARTMENTS {
            let dept_lines: Vec<&DocLine<'_>> =
                lines.iter().filter(|l| l.department == dept).collect();
            if dept_lines.is_empty() {
                continue;
            }
            if !first_section {
                p.hr(WIDTH);
            }
            first_section = false;
            if dept == "WASH" {
                if let Some(note) = wash_note {
                    p.kv_line("نوع السيارة", note, WIDTH);
                }
            }
            p.bold(true);
            p.line(title);
            p.bold(false);
            for l in &dept_lines {
                p.item(
                    l.product_name,
                    &l.quantity.to_string(),
                    &format_minor_for_print(l.unit_price),
                    &format_minor_for_print(l.line_total),
                );
            }
            p.financial(
                subtotal_label,
                &format_minor_for_print(department_subtotal(lines, totals, dept)),
                false,
            );
        }
    } else {
        for l in lines {
            p.item(
                l.product_name,
                &l.quantity.to_string(),
                &format_minor_for_print(l.unit_price),
                &format_minor_for_print(l.line_total),
            );
        }
    }
    p.hr(WIDTH);
    p.financial(
        "الإجمالي الفرعي",
        &format_minor_for_print(totals.subtotal),
        false,
    );
    if totals.discount_minor > 0 {
        p.financial(
            "الخصم",
            &format_minor_for_print(totals.discount_minor),
            false,
        );
    }
    if totals.service_charge_minor > 0 {
        p.financial(
            "خدمة",
            &format_minor_for_print(totals.service_charge_minor),
            false,
        );
    }
    p.bold(true);
    p.size(1, 2);
    p.financial("الإجمالي", &format_minor_for_print(totals.total), true);
    p.size(1, 1);
    p.bold(false);
    if let Some(settlement) = &totals.settlement {
        p.financial(
            "المدفوع",
            &format_minor_for_print(settlement.paid_amount),
            false,
        );
        if let Some(remaining) = settlement.credit_remaining {
            p.financial("المتبقي (آجل)", &format_minor_for_print(remaining), false);
        }
    }
}

/// Department subtotal: the persisted snapshot when one exists (a historical
/// invoice must print the value it was stored with), otherwise the sum of the
/// line totals actually printed above it.
fn department_subtotal(lines: &[DocLine<'_>], totals: &DocTotals, dept: &str) -> i64 {
    if let Some((cafe, wash)) = totals.dept_subtotals {
        return if dept == "CAFE" { cafe } else { wash };
    }
    lines
        .iter()
        .filter(|l| l.department == dept)
        .map(|l| l.line_total)
        .sum()
}
