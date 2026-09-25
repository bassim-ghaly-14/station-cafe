use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, WIDTH};
use crate::money::format_minor_for_print;
use crate::services::reports::DayReport;

pub fn day_report(mode: ArabicMode, codepage: u8, r: &DayReport, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل يوم العمل", "DAY CLOSING");
    p.kv_line("اليوم", &r.day.day_date, WIDTH);
    p.hr(WIDTH);
    p.kv_line("عدد الفواتير", &r.totals.invoices_count.to_string(), WIDTH);
    p.kv_line(
        "مبيعات الكافيه",
        &format_minor_for_print(r.totals.cafe_sales),
        WIDTH,
    );
    p.kv_line(
        "مبيعات المغسلة",
        &format_minor_for_print(r.totals.wash_sales),
        WIDTH,
    );
    p.bold(true);
    p.kv_line(
        "إجمالي المبيعات",
        &format_minor_for_print(r.totals.total_sales),
        WIDTH,
    );
    p.bold(false);
    p.hr(WIDTH);
    p.kv_line("نقدي", &format_minor_for_print(r.totals.cash), WIDTH);
    p.kv_line("بطاقة", &format_minor_for_print(r.totals.card), WIDTH);
    p.kv_line("آجل", &format_minor_for_print(r.totals.credit), WIDTH);
    p.kv_line(
        "خدمة",
        &format_minor_for_print(r.totals.service_charges),
        WIDTH,
    );
    p.kv_line("خصومات", &format_minor_for_print(r.totals.discounts), WIDTH);
    p.kv_line("مصروفات", &format_minor_for_print(r.totals.expenses), WIDTH);
    p.hr(WIDTH);
    p.kv_line(
        "النقدية المتوقعة بالدرج",
        &format_minor_for_print(r.expected_drawer_cash),
        WIDTH,
    );
    p.kv_line(
        "فروق الكاش",
        &format_minor_for_print(r.cash_differences),
        WIDTH,
    );
    p.hr(WIDTH);
    p.line("الورديات:");
    for s in &r.shifts {
        p.line(&format!(
            "{} | {} | {}",
            s.user_name.as_deref().unwrap_or("-"),
            s.status,
            format_minor_for_print(s.cash_sales + s.card_sales)
        ));
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع المدير: ____________");
    p.finish()
}
