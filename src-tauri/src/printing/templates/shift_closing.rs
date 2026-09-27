use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, stamp, WIDTH};
use crate::money::format_minor_for_print;
use crate::services::reconciliation::{CashStatus, ShiftReconciliation};

/// Arabic status word for the reconciliation result. The document must never
/// print a bare signed number labelled "الفرق" without saying what it means.
fn status_word(status: CashStatus) -> &'static str {
    match status {
        CashStatus::Balanced => "متوازن",
        CashStatus::Shortage => "عجز",
        CashStatus::Surplus => "زيادة",
    }
}

/// Render the shared cash-reconciliation block. Used by BOTH the shift and the
/// day document, so the two can never print a different set of lines.
pub fn cash_block(p: &mut EscPos, c: &crate::services::reconciliation::CashReconciliation) {
    p.kv_line(
        "رصيد افتتاح الوردية",
        &format_minor_for_print(c.opening_cash),
        WIDTH,
    );
    p.kv_line(
        "إجمالي النقدية الداخلة",
        &format_minor_for_print(c.cash_inflows),
        WIDTH,
    );
    p.kv_line(
        "إجمالي المصروفات النقدية",
        &format_minor_for_print(c.cash_outflows),
        WIDTH,
    );
    p.bold(true);
    p.kv_line(
        "رصيد الإقفال المتوقع",
        &format_minor_for_print(c.expected_cash),
        WIDTH,
    );
    p.bold(false);
    p.kv_line(
        "النقدية الفعلية المسلّمة",
        &format_minor_for_print(c.actual_cash),
        WIDTH,
    );
    p.kv_line("الفرق", &format_minor_for_print(c.difference), WIDTH);
    p.bold(true);
    // The magnitude comes from the backend's own resolved shortage/surplus, so
    // the paper cannot express the difference with arithmetic of its own.
    p.kv_line(
        "حالة التسوية",
        &format!(
            "{} {}",
            status_word(c.status),
            format_minor_for_print(match c.status {
                CashStatus::Shortage => c.shortage,
                CashStatus::Surplus => c.surplus,
                CashStatus::Balanced => 0,
            })
        ),
        WIDTH,
    );
    p.bold(false);
}

/// Arabic name of a shift's lifecycle state. The closing document must never
/// print the raw stored status (`ACTIVE` / `CLOSED`) — that is implementation
/// vocabulary, not the operator's language.
pub fn shift_status_word(status: &str) -> &'static str {
    match status {
        "CLOSED" => "مغلقة",
        "ACTIVE" => "مفتوحة",
        "CLOSING" => "قيد التقفيل",
        _ => "-",
    }
}

/// Render the expense total plus its per-category breakdown.
pub fn expense_block(
    p: &mut EscPos,
    total: i64,
    rows: &[crate::repositories::expenses::BreakdownRow],
) {
    p.bold(true);
    p.kv_line("إجمالي المصروفات", &format_minor_for_print(total), WIDTH);
    p.bold(false);
    for row in rows {
        // `name_ar` comes from the category table, so nothing is hardcoded here.
        p.kv_line(
            &row.category_name,
            &format!("({}) {}", row.count, format_minor_for_print(row.amount)),
            WIDTH,
        );
    }
}

pub fn shift_closing(
    mode: ArabicMode,
    codepage: u8,
    r: &ShiftReconciliation,
    logo: bool,
) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل وردية", "SHIFT CLOSING");
    p.kv_line("الموظف", r.shift.user_name.as_deref().unwrap_or("-"), WIDTH);
    p.kv_line("فتح", &stamp(&r.shift.opened_at), WIDTH);
    p.kv_line(
        "إغلاق",
        &r.shift
            .closed_at
            .as_deref()
            .map(stamp)
            .unwrap_or_else(|| "-".into()),
        WIDTH,
    );

    p.hr(WIDTH);
    p.line("المبيعات");
    p.kv_line(
        "عدد فواتير الكافيه",
        &r.areas.cafe_invoices.to_string(),
        WIDTH,
    );
    p.kv_line(
        "مبيعات الكافيه",
        &format_minor_for_print(r.cafe_sales),
        WIDTH,
    );
    p.kv_line(
        "عدد فواتير المغسلة",
        &r.areas.wash_invoices.to_string(),
        WIDTH,
    );
    p.kv_line(
        "مبيعات المغسلة",
        &format_minor_for_print(r.wash_sales),
        WIDTH,
    );
    p.kv_line(
        "عدد الفواتير المختلطة",
        &r.areas.hybrid_invoices.to_string(),
        WIDTH,
    );
    p.bold(true);
    p.kv_line("إجمالي الفواتير", &r.invoices_count.to_string(), WIDTH);
    p.kv_line(
        "إجمالي المبيعات",
        &format_minor_for_print(r.total_sales),
        WIDTH,
    );
    p.bold(false);

    p.hr(WIDTH);
    p.line("الخدمات والخصومات");
    p.kv_line(
        "إجمالي الخدمات",
        &format_minor_for_print(r.service_charges),
        WIDTH,
    );
    p.kv_line(
        "إجمالي الخصومات",
        &format_minor_for_print(r.discounts),
        WIDTH,
    );

    p.hr(WIDTH);
    p.line("المصروفات");
    expense_block(&mut p, r.expenses, &r.expense_breakdown);

    p.hr(WIDTH);
    p.line("تسوية العهدة");
    p.kv_line("نقدي", &format_minor_for_print(r.cash_sales), WIDTH);
    p.kv_line("بطاقة", &format_minor_for_print(r.card_sales), WIDTH);
    p.kv_line("آجل", &format_minor_for_print(r.credit_sales), WIDTH);
    cash_block(&mut p, &r.cash);

    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع الكاشير: ____________");
    p.finish()
}
