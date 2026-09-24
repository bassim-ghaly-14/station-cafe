use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, minor, WIDTH};
use crate::services::reports::DayReport;

pub fn day_report(mode: ArabicMode, codepage: u8, r: &DayReport, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "تقفيل يوم العمل", "DAY CLOSING");
    p.kv_line("اليوم", &r.day.day_date, WIDTH);
    p.hr(WIDTH);
    p.kv_line("عدد الفواتير", &r.totals.invoices_count.to_string(), WIDTH);
    p.kv_line("مبيعات الكافيه", &minor(r.totals.cafe_sales), WIDTH);
    p.kv_line("مبيعات المغسلة", &minor(r.totals.wash_sales), WIDTH);
    p.bold(true);
    p.kv_line("إجمالي المبيعات", &minor(r.totals.total_sales), WIDTH);
    p.bold(false);
    p.hr(WIDTH);
    p.kv_line("نقدي", &minor(r.totals.cash), WIDTH);
    p.kv_line("بطاقة", &minor(r.totals.card), WIDTH);
    p.kv_line("آجل", &minor(r.totals.credit), WIDTH);
    p.kv_line("خدمة", &minor(r.totals.service_charges), WIDTH);
    p.kv_line("خصومات", &minor(r.totals.discounts), WIDTH);
    p.kv_line("مصروفات", &minor(r.totals.expenses), WIDTH);
    p.hr(WIDTH);
    p.kv_line(
        "النقدية المتوقعة بالدرج",
        &minor(r.expected_drawer_cash),
        WIDTH,
    );
    p.kv_line("فروق الكاش", &minor(r.cash_differences), WIDTH);
    p.hr(WIDTH);
    p.line("الورديات:");
    for s in &r.shifts {
        p.line(&format!(
            "{} | {} | {}",
            s.user_name.as_deref().unwrap_or("-"),
            s.status,
            minor(s.cash_sales + s.card_sales)
        ));
    }
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("توقيع المدير: ____________");
    p.finish()
}
