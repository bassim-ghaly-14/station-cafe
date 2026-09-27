use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, WIDTH};
use super::shift_closing::{cash_block, expense_block, shift_status_word};
use crate::money::format_minor_for_print;
use crate::services::reconciliation::DayReconciliation;

pub fn day_report(mode: ArabicMode, codepage: u8, r: &DayReconciliation, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل يوم العمل", "DAY CLOSING");
    p.kv_line("اليوم", &r.day.day_date, WIDTH);
    p.kv_line("عدد الورديات المغلقة", &r.shift_count.to_string(), WIDTH);
    // When shifts were excluded the document must SAY so, rather than letting a
    // reader assume the total covered the whole day.
    if r.open_shift_count > 0 {
        p.kv_line(
            "ورديات مفتوحة (غير محتسبة)",
            &r.open_shift_count.to_string(),
            WIDTH,
        );
    }

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
    p.line("الورديات المغلقة:");
    for s in &r.shifts {
        // The shift name is truncated so the composed line can never exceed the
        // 42-cell printer width, whatever the operator is called, and the state
        // is printed in Arabic rather than as the stored status code.
        let name = s.user_name.as_deref().unwrap_or("-");
        let name: String = name.chars().take(12).collect();
        p.line(&format!(
            "{} | {} | {}",
            name,
            shift_status_word(&s.status),
            format_minor_for_print(s.cash_sales)
        ));
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع المدير: ____________");
    p.finish()
}
