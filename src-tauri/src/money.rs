//! Station Cafe — money core.
//!
//! The ONLY place financial arithmetic is defined on the backend.
//! Representation: integers in **minor units** (piasters; 1 EGP = 100).
//! No floats are ever used for money. Percentage rates use fixed-point ×1000
//! (`Rate`): 10_000 = 10.000%, 12_500 = 12.5%.

/// Minor units per major unit (1 EGP = 100 piasters).
pub const MINOR_PER_MAJOR: i64 = 100;
/// Fixed-point scale for percentage rates: 100_000 = 100.000%.
pub const RATE_SCALE: i64 = 100_000;

/// A monetary amount in piasters (integer minor units).
pub type Money = i64;

/// A percentage rate ×1000. `10_000` = 10.000%.
pub type Rate = i64;

/// Deterministic integer division with half-up rounding (ties away from zero
/// for positive values — predictable POS behavior).
pub fn div_round(num: i64, den: i64) -> i64 {
    assert!(den != 0, "div_round: zero denominator");
    let q = num / den;
    let r = num % den;
    let double = (r * 2).abs();
    let bump = if double > den.abs() || (double == den.abs() && num >= 0) {
        1
    } else {
        0
    };
    if num < 0 {
        q - bump
    } else {
        q + bump
    }
}

/// Percentage of an amount, deterministic integer rounding.
/// `percent_of(200_00, 10_000) = 20_00` (10% of 200 EGP = 20 EGP).
pub fn percent_of(amount: Money, rate: Rate) -> Money {
    div_round(amount * rate, RATE_SCALE)
}

/// Apply a percentage discount to an amount, floored at 0 (a discount must
/// never create a negative total).
pub fn apply_percent_discount(amount: Money, discount_rate: Rate) -> Money {
    (amount - percent_of(amount, discount_rate)).max(0)
}

/// Apply a fixed minor-unit discount, floored at 0.
pub fn apply_fixed_discount(amount: Money, discount_minor: Money) -> Money {
    (amount - discount_minor).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_of_is_exact() {
        assert_eq!(percent_of(200_00, 10_000), 20_00); // 10% of 200 = 20
        assert_eq!(percent_of(200_00, 5_000), 10_00); // 5% of 200 = 10
        assert_eq!(percent_of(100_00, 12_500), 12_50); // 12.5% of 100 = 12.5
        assert_eq!(percent_of(0, 10_000), 0);
        // Rounding: 15% of 55.50 = 8.325 → 8.33 (half-up)
        assert_eq!(percent_of(55_50, 15_000), 8_33);
    }

    #[test]
    fn discounts_never_go_negative() {
        assert_eq!(apply_fixed_discount(20_00, 25_00), 0);
        assert_eq!(apply_percent_discount(10_00, 150_000), 0); // 150% clamp
        assert_eq!(apply_fixed_discount(50_00, 20_00), 30_00);
    }

    #[test]
    fn div_round_half_up() {
        assert_eq!(div_round(5, 2), 3);
        assert_eq!(div_round(4, 2), 2);
        assert_eq!(div_round(-5, 2), -2); // symmetric half-up on magnitude
    }
}
