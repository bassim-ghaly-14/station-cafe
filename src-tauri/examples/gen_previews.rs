use printpdf::{
    graphics::{PaintMode, Point, Polygon, PolygonRing, WindingOrder},
    Color, LinePoint, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Pt,
    RawImage, Rgb, TextItem, XObjectTransform,
};
use std::{fs, path::PathBuf};

const LOGO: &[u8] = include_bytes!("../../public/station-print.png");

fn line(ops: &mut Vec<Op>, font: &PdfFontHandle, text: &str, y: f32, size: f32) {
    ops.push(Op::StartTextSection);
    ops.push(Op::SetFont {
        font: font.clone(),
        size: Pt(size),
    });
    ops.push(Op::SetLineHeight { lh: Pt(size) });
    ops.push(Op::SetTextCursor {
        pos: Point {
            x: Pt(18.0),
            y: Pt(y),
        },
    });
    ops.push(Op::ShowText {
        items: vec![TextItem::Text(text.to_string())],
    });
    ops.push(Op::EndTextSection);
}

fn page(title: &str, lines: &[&str], thermal: bool, output: &PathBuf, font_bytes: &[u8]) {
    let mut document = PdfDocument::new(title);
    let parsed_font = ParsedFont::from_bytes(font_bytes, 0, &mut Vec::new()).expect("font");
    let font = PdfFontHandle::External(document.add_font(&parsed_font));
    let logo = RawImage::decode_from_bytes(LOGO, &mut Vec::new()).expect("logo");
    let logo_id = document.add_image(&logo);
    let (width, height) = if thermal {
        (Mm(80.0), Mm(180.0))
    } else {
        (Mm(210.0), Mm(297.0))
    };
    let page_width = width.0 * 2.83465;
    let page_height = height.0 * 2.83465;
    let mut ops = vec![
        Op::SetFillColor {
            col: Color::Rgb(Rgb {
                r: 1.0,
                g: 1.0,
                b: 1.0,
                icc_profile: None,
            }),
        },
        Op::DrawPolygon {
            polygon: Polygon {
                rings: vec![PolygonRing {
                    points: vec![
                        LinePoint {
                            p: Point {
                                x: Pt(0.0),
                                y: Pt(0.0),
                            },
                            bezier: false,
                        },
                        LinePoint {
                            p: Point {
                                x: Pt(page_width),
                                y: Pt(0.0),
                            },
                            bezier: false,
                        },
                        LinePoint {
                            p: Point {
                                x: Pt(page_width),
                                y: Pt(page_height),
                            },
                            bezier: false,
                        },
                        LinePoint {
                            p: Point {
                                x: Pt(0.0),
                                y: Pt(page_height),
                            },
                            bezier: false,
                        },
                    ],
                }],
                mode: PaintMode::Fill,
                winding_order: WindingOrder::NonZero,
            },
        },
        Op::UseXobject {
            id: logo_id,
            transform: XObjectTransform {
                translate_x: Some(Pt(18.0)),
                translate_y: Some(Pt(height.0 * 2.83465 - 92.0)),
                scale_x: Some(0.12),
                scale_y: Some(0.12),
                dpi: Some(300.0),
                ..Default::default()
            },
        },
    ];
    ops.push(Op::SetFillColor {
        col: Color::Rgb(Rgb {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            icc_profile: None,
        }),
    });
    line(&mut ops, &font, title, height.0 * 2.83465 - 112.0, 15.0);
    for (index, text) in lines.iter().enumerate() {
        line(
            &mut ops,
            &font,
            text,
            height.0 * 2.83465 - 132.0 - index as f32 * 16.0,
            9.0,
        );
    }
    let bytes = document
        .with_pages(vec![PdfPage::new(width, height, ops)])
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    fs::write(output, bytes).expect("write preview");
}

fn main() {
    let font_path = std::env::args()
        .nth(1)
        .expect("usage: gen_previews <font-path>");
    let font_bytes = fs::read(font_path).expect("read font");
    let output = PathBuf::from("public/print-previews");
    fs::create_dir_all(&output).expect("create preview directory");
    let previews = [
        (
            "CAFE_INVOICE",
            "cafe-invoice",
            false,
            [
                "Invoice #1001",
                "Arabic coffee x2                    70.00",
                "Subtotal                              70.00",
                "Total                                 70.00",
            ],
        ),
        (
            "WASH_INVOICE",
            "wash-invoice",
            false,
            [
                "Invoice #1002",
                "Full car wash x1                    160.00",
                "Subtotal                             160.00",
                "Total                                160.00",
            ],
        ),
        (
            "HYBRID_INVOICE",
            "hybrid-invoice",
            false,
            [
                "Invoice #1003",
                "Cafe: Arabic coffee x2                70.00",
                "Wash: Full car wash x1              160.00",
                "Total                                240.00",
            ],
        ),
        (
            "WASH_TICKET",
            "wash-ticket",
            true,
            [
                "Waiting number: 12",
                "Customer: Ahmed",
                "Plate: ABC123",
                "Services: Full car wash",
            ],
        ),
        (
            "SHIFT_REPORT",
            "shift-report",
            false,
            [
                "Shift closing",
                "Invoices: 12",
                "Cash sales                         840.00",
                "Card sales                         360.00",
            ],
        ),
        (
            "DAY_REPORT",
            "day-report",
            false,
            [
                "Day closing",
                "Invoices: 24",
                "Cafe sales                        1,240.00",
                "Wash sales                        2,160.00",
            ],
        ),
        (
            "TEST",
            "test-page",
            true,
            [
                "Printer test page",
                "Device: preview",
                "Width: 80mm",
                "Arabic: اختبار الطباعة",
            ],
        ),
    ];
    for (identifier, filename, thermal, lines) in previews {
        page(
            identifier,
            &lines,
            thermal,
            &output.join(format!("{filename}.pdf")),
            &font_bytes,
        );
    }
}
