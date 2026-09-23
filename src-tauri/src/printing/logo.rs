//! Logo → monochrome raster conversion for thermal printing.
//!
//! The colored brand logo is NOT printed as-is: it is converted here (once,
//! cached) into a 1-bit raster suitable for ESC/POS `GS v 0`. This keeps all
//! printer-specific logo handling in one isolated module, fed by the single
//! branding asset (public/station-print.png).
//!
//! NOTE: The canonical print logo is public/station-print.png (square, 1254px).
//! The older public/station-cafe.png is a legacy screen-only asset and is NOT
//! used for printing or for any printable-template PDF preview.

use crate::error::{AppError, AppResult};
use image::imageops::FilterType;
use std::sync::OnceLock;

/// The canonical print/logo asset used by ALL printed and preview output
/// (thermal ESC/POS + static PDF previews). Square brand mark.
const LOGO_PNG: &[u8] = include_bytes!("../../../public/station-print.png");

/// 80mm printers give 576 printable dots (72mm); we use a smaller logo.
pub const LOGO_WIDTH_DOTS: usize = 240;

static RASTER: OnceLock<Option<(usize, usize, Vec<u8>)>> = OnceLock::new();

/// Returns (width_dots, height_dots, 1-bit packed rows), or None when the
/// logo cannot be prepared (printing then continues without a logo).
pub fn logo_raster() -> Option<&'static (usize, usize, Vec<u8>)> {
    RASTER.get_or_init(|| build_raster().ok()).as_ref()
}

fn build_raster() -> AppResult<(usize, usize, Vec<u8>)> {
    let img = image::load_from_memory(LOGO_PNG)
        .map_err(|e| AppError::internal(format!("logo decode failed: {e}")))?;
    // Preserve the source aspect ratio.  The canonical asset is currently
    // square, but this remains correct if the brand artwork changes later.
    let small = img.resize(LOGO_WIDTH_DOTS as u32, u32::MAX, FilterType::Triangle);
    let rgba = small.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let width_bytes = w.div_ceil(8);
    let mut data = vec![0u8; width_bytes * h];
    for y in 0..h {
        for x in 0..w {
            let [r, g, b, a] = rgba.get_pixel(x as u32, y as u32).0;
            // Composite against paper before thresholding.  Looking only at
            // RGB would turn transparent pixels with black RGB values into ink.
            let alpha = a as u32;
            let paper = |channel: u8| ((channel as u32 * alpha + 255 * (255 - alpha)) / 255) as u8;
            let luma = ((paper(r) as u32 * 299 + paper(g) as u32 * 587 + paper(b) as u32 * 114)
                / 1000) as u8;
            if luma < 150 {
                data[y * width_bytes + x / 8] |= 0b1000_0000 >> (x % 8);
            }
        }
    }
    Ok((w, h, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_converts_to_monochrome_raster() {
        let (w, h, data) = logo_raster().expect("logo raster");
        assert_eq!(*w, LOGO_WIDTH_DOTS);
        assert_eq!(data.len(), w.div_ceil(8) * h);
        assert!(*w <= 576, "logo must fit the printable width");
        // Aspect ratio is preserved and the transparent background is paper.
        let rgba = image::load_from_memory(LOGO_PNG).unwrap().to_rgba8();
        let source_aspect = rgba.width() as f64 / rgba.height() as f64;
        let raster_aspect = *w as f64 / *h as f64;
        assert!((source_aspect - raster_aspect).abs() < 0.01);
        assert!(data.iter().any(|b| *b != 0), "visible logo ink exists");
        // First row is transparent padding in the canonical asset, therefore
        // it must contain no ink. This fails if RGBA is converted without alpha.
        assert!(data.iter().take(w.div_ceil(8)).all(|b| *b == 0));
    }
}
