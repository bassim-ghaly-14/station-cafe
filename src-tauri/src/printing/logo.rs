//! Logo → monochrome raster conversion for thermal printing.
//!
//! The colored brand logo is NOT printed as-is: it is converted here (once,
//! cached) into a 1-bit raster suitable for ESC/POS `GS v 0`. This keeps all
//! printer-specific logo handling in one isolated module, fed by the single
//! branding asset (public/station-cafe.png).

use crate::error::{AppError, AppResult};
use image::imageops::FilterType;
use std::sync::OnceLock;

/// The single branding asset (frontend `public/station-cafe.png`).
const LOGO_PNG: &[u8] = include_bytes!("../../../public/station-cafe.png");

/// 80mm printers give 576 printable dots (72mm); we use a smaller logo.
pub const LOGO_WIDTH_DOTS: usize = 240;

static RASTER: OnceLock<Option<(usize, usize, Vec<u8>)>> = OnceLock::new();

/// Returns (width_dots, height_dots, 1-bit packed rows), or None when the
/// logo cannot be prepared (printing then continues without a logo).
pub fn logo_raster() -> Option<&'static (usize, usize, Vec<u8>)> {
    RASTER
        .get_or_init(|| build_raster().ok())
        .as_ref()
}

fn build_raster() -> AppResult<(usize, usize, Vec<u8>)> {
    let img = image::load_from_memory(LOGO_PNG)
        .map_err(|e| AppError::internal(format!("logo decode failed: {e}")))?;
    let target_h = LOGO_WIDTH_DOTS; // square brand mark
    let small = img.resize_exact(LOGO_WIDTH_DOTS as u32, target_h as u32, FilterType::Triangle);
    let luma = small.to_luma8();
    let (w, h) = (luma.width() as usize, luma.height() as usize);
    let width_bytes = w.div_ceil(8);
    let mut data = vec![0u8; width_bytes * h];
    for y in 0..h {
        for x in 0..w {
            // Threshold at mid-grey; alpha-blended light pixels stay white.
            let pixel = luma.get_pixel(x as u32, y as u32).0[0];
            if pixel < 150 {
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
        // Some ink must be present (not a blank page).
        assert!(data.iter().any(|b| *b != 0));
    }
}