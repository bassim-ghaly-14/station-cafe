use super::super::escpos::{Align, ArabicMode, EscPos};
use super::super::ir::PrintDoc;
use super::shared::{header, WIDTH};

/// Test page used to verify a newly installed/renamed printer.
pub fn test_page(mode: ArabicMode, codepage: u8, device: &str, logo: bool) -> PrintDoc {
    let mut p = EscPos::new(mode, codepage);
    header(&mut p, logo, "اختبار الطباعة", "PRINTER TEST PAGE");
    p.kv_line("الجهاز", device, WIDTH);
    p.kv_line("العرض", "80mm", WIDTH);
    p.kv_line("الترميز", &format!("{mode:?} / cp{codepage}"), WIDTH);
    p.hr(WIDTH);
    p.line("أرقام: 0123456789");
    p.line("عربي: أ ب ت ث ج ح خ د ذ ر ز س ش");
    p.line("English: The quick brown fox 123");
    p.hr(WIDTH);
    p.align(Align::Center);
    p.line("تم إرسال الاختبار بنجاح");
    p.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printing::escpos::ArabicMode;

    #[test]
    fn test_page_test_preserves_latin_mode_output() {
        let bytes = test_page(ArabicMode::Latin, 22, "file:/tmp/x.prn", false).escpos;
        assert!(!bytes.iter().skip(4).any(|b| *b >= 0x80));
        assert!(String::from_utf8_lossy(&bytes).contains("0123456789"));
    }
}
