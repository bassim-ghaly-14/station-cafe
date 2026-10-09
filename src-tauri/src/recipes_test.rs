//! Raw-material + recipe domain tests, written against the approved scenarios.
//!
//! Every test drives the SERVICE layer — the same entry points the commands
//! call — so a passing test protects the command path too. Checkout scenarios
//! run through the real `checkout::checkout`, so raw-material consumption is
//! proven to live inside the SAME transaction as the sale.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::repositories::{catalog, recipes};
use crate::services::recipes::{self as recipes_svc, PurchaseInput, RecipeLineInput};
use crate::services::{auth, checkout, pos as pos_svc, shifts as shift_svc};
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

fn login(conn: &Connection, name: &str, password: &str) -> auth::User {
    auth::login(
        conn,
        &auth::LoginInput {
            name: name.into(),
            password: password.into(),
        },
    )
    .unwrap()
    .user
}

/// The seeded manager, who is the only role allowed to touch raw materials.
fn manager(conn: &Connection) -> auth::User {
    login(conn, "amira", "20192")
}

/// A tracked CAFE product of our own, so its recipe is entirely under the test.
fn tracked_product(conn: &Connection, name: &str) -> i64 {
    let category_id = catalog::ensure_category(conn, "مشروبات ساخنة").unwrap();
    catalog::insert(
        conn,
        &catalog::NewProduct {
            name,
            item_type: "PRODUCT",
            department: "CAFE",
            category_id,
            price_minor: 1_000,
            track_inventory: true,
            stock_quantity: 0,
            min_quantity: 0,
            is_new: false,
            user_id: 1,
        },
    )
    .unwrap()
}

fn material(conn: &Connection, actor: &auth::User, name: &str, base_unit: &str) -> i64 {
    recipes_svc::create_material(
        conn,
        actor,
        &recipes::NewMaterial {
            name: name.into(),
            department: "CAFE".into(),
            base_unit: base_unit.into(),
        },
    )
    .unwrap()
}

fn balance(conn: &Connection, id: i64) -> i64 {
    recipes::current_quantity(conn, id).unwrap().unwrap()
}

fn recipe_lines(pairs: &[(i64, i64)]) -> Vec<RecipeLineInput> {
    pairs
        .iter()
        .map(|(raw_material_id, quantity_base)| RecipeLineInput {
            raw_material_id: *raw_material_id,
            quantity_base: *quantity_base,
        })
        .collect()
}

/// A TAKEAWAY order the cashier pays with cash, built inside a real day+shift.
fn sale(conn: &Connection, staff: &auth::User, lines: &[(i64, i64)]) -> checkout::CheckoutResult {
    let order_id = pos_svc::start_takeaway(conn, staff).unwrap();
    for (product_id, qty) in lines {
        pos_svc::add_line(conn, staff, order_id, *product_id, *qty).unwrap();
    }
    checkout::checkout(
        conn,
        staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: None,
            received: Some(10_000_000),
        },
    )
    .unwrap()
}

/// A base unit is immutable once the material is used: stock or a recipe row
/// locks it. Other fields still edit fine, and a never-used zero-stock
/// material may still change units.
#[test]
fn base_unit_locked_after_stock_and_after_recipe() {
    let conn = fresh();
    let m = manager(&conn);
    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");
    recipes_svc::adjust_material(&conn, &m, beans, 500, None).unwrap();
    let err = recipes_svc::update_material(
        &conn,
        &m,
        beans,
        &recipes::NewMaterial {
            name: "حبوب القهوة".into(),
            department: "CAFE".into(),
            base_unit: "MILLILITER".into(),
        },
    )
    .unwrap_err();
    assert!(
        matches!(err, crate::error::AppError::BusinessRule(ref c) if c == "rawmaterials.unit_locked"),
        "stocked unit change refused: {err:?}"
    );
    recipes_svc::update_material(
        &conn,
        &m,
        beans,
        &recipes::NewMaterial {
            name: "حبوب مختصة".into(),
            department: "CAFE".into(),
            base_unit: "GRAM".into(),
        },
    )
    .unwrap();
    assert_eq!(
        recipes_svc::get_material(&conn, beans).unwrap().name,
        "حبوب مختصة"
    );
    assert_eq!(balance(&conn, beans), 500);

    let sugar = material(&conn, &m, "سكر", "GRAM");
    let coffee = tracked_product(&conn, "قهوة");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 5)])).unwrap();
    let err = recipes_svc::update_material(
        &conn,
        &m,
        sugar,
        &recipes::NewMaterial {
            name: "سكر".into(),
            department: "CAFE".into(),
            base_unit: "MILLILITER".into(),
        },
    )
    .unwrap_err();
    assert!(
        matches!(err, crate::error::AppError::BusinessRule(ref c) if c == "rawmaterials.unit_locked"),
        "recipe-referenced unit change refused: {err:?}"
    );
    assert_eq!(recipes::get_recipe(&conn, coffee).unwrap().len(), 1);

    let salt = material(&conn, &m, "ملح", "GRAM");
    recipes_svc::update_material(
        &conn,
        &m,
        salt,
        &recipes::NewMaterial {
            name: "ملح".into(),
            department: "CAFE".into(),
            base_unit: "MILLILITER".into(),
        },
    )
    .unwrap();
    assert_eq!(
        recipes_svc::get_material(&conn, salt).unwrap().base_unit,
        "MILLILITER"
    );
}

/// Scenario A — a simple recipe consumed on a sale of one.
#[test]
fn scenario_a_simple_recipe_consumes_each_material_once() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");
    let sugar = material(&conn, &m, "سكر", "GRAM");
    let milk = material(&conn, &m, "حليب", "MILLILITER");
    for id in [beans, sugar, milk] {
        recipes_svc::adjust_material(&conn, &m, id, 1_000, None).unwrap();
    }

    let coffee = tracked_product(&conn, "قهوة");
    recipes_svc::set_recipe(
        &conn,
        &m,
        coffee,
        &recipe_lines(&[(beans, 10), (sugar, 12), (milk, 100)]),
    )
    .unwrap();

    sale(&conn, &staff, &[(coffee, 1)]);

    assert_eq!(balance(&conn, beans), 990);
    assert_eq!(balance(&conn, sugar), 988);
    assert_eq!(balance(&conn, milk), 900);
}

/// Scenario B — quantity scales the recipe linearly.
#[test]
fn scenario_b_quantity_scales_every_requirement() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");
    let sugar = material(&conn, &m, "سكر", "GRAM");
    let milk = material(&conn, &m, "حليب", "MILLILITER");
    for id in [beans, sugar, milk] {
        recipes_svc::adjust_material(&conn, &m, id, 10_000, None).unwrap();
    }

    let coffee = tracked_product(&conn, "قهوة");
    recipes_svc::set_recipe(
        &conn,
        &m,
        coffee,
        &recipe_lines(&[(beans, 10), (sugar, 12), (milk, 100)]),
    )
    .unwrap();

    sale(&conn, &staff, &[(coffee, 3)]);

    assert_eq!(balance(&conn, beans), 9_970);
    assert_eq!(balance(&conn, sugar), 9_964);
    assert_eq!(balance(&conn, milk), 9_700);
}

/// Scenario C — a material shared across recipes is summed before validation.
#[test]
fn scenario_c_shared_material_is_summed_across_lines() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 1_000, None).unwrap();

    let coffee = tracked_product(&conn, "قهوة");
    let tea = tracked_product(&conn, "شاي");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 12)])).unwrap();
    recipes_svc::set_recipe(&conn, &m, tea, &recipe_lines(&[(sugar, 10)])).unwrap();

    // Coffee ×2 = 24 g, Tea ×3 = 30 g → one 54 g deduction, not two.
    sale(&conn, &staff, &[(coffee, 2), (tea, 3)]);

    assert_eq!(balance(&conn, sugar), 946);

    let movements = recipes::list_movements(&conn, Some(sugar), 50).unwrap();
    let consumption: Vec<_> = movements
        .iter()
        .filter(|mv| mv.reason == "SALE_CONSUMPTION")
        .collect();
    assert_eq!(
        consumption.len(),
        1,
        "shared materials collapse to one movement"
    );
    assert_eq!(consumption[0].change, -54);
}

/// Scenario D — insufficient material blocks the WHOLE sale atomically.
#[test]
fn scenario_d_insufficient_material_blocks_the_whole_sale() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 5, None).unwrap();

    let coffee = tracked_product(&conn, "قهوة");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 12)])).unwrap();

    let order_id = pos_svc::start_takeaway(&conn, &staff).unwrap();
    pos_svc::add_line(&conn, &staff, order_id, coffee, 1).unwrap();
    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: None,
            received: Some(10_000_000),
        },
    );

    // No successful invoice, no movement, and the balance is untouched.
    assert!(result.is_err());
    assert_eq!(balance(&conn, sugar), 5);
    assert!(recipes::list_movements(&conn, Some(sugar), 50)
        .unwrap()
        .iter()
        .all(|mv| mv.reason != "SALE_CONSUMPTION"));
    let open_orders: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM orders WHERE status = 'CLOSED'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        open_orders, 0,
        "no order reaches CLOSED on a failed checkout"
    );
}

/// Scenario E — a tracked product with NO recipe sells on product stock alone.
#[test]
fn scenario_e_tracked_product_without_recipe_consumes_nothing() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 1_000, None).unwrap();

    let category_id = catalog::ensure_category(&conn, "مشروبات ساخنة").unwrap();
    let product_id = catalog::insert(
        &conn,
        &catalog::NewProduct {
            name: "منتج متتبع بلا وصفة",
            item_type: "PRODUCT",
            department: "CAFE",
            category_id,
            price_minor: 1_000,
            track_inventory: true,
            stock_quantity: 10,
            min_quantity: 0,
            is_new: false,
            user_id: 1,
        },
    )
    .unwrap();

    sale(&conn, &staff, &[(product_id, 2)]);

    // Product stock moved through the EXISTING inventory path; raw materials
    // were untouched because the product has no recipe.
    assert_eq!(balance(&conn, sugar), 1_000);
    let stock: i64 = conn
        .query_row(
            "SELECT quantity FROM inventory_items WHERE product_id = ?1",
            [product_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stock, 8);
}

/// Scenario F — an untracked product offers no recipe and consumes nothing.
#[test]
fn scenario_f_untracked_product_has_no_recipe_surface() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 1_000, None).unwrap();

    let category_id = catalog::ensure_category(&conn, "عام").unwrap();
    let service_id = catalog::insert(
        &conn,
        &catalog::NewProduct {
            name: "خدمة غير متتبعة",
            item_type: "SERVICE",
            department: "CAFE",
            category_id,
            price_minor: 500,
            track_inventory: false,
            stock_quantity: 0,
            min_quantity: 0,
            is_new: false,
            user_id: 1,
        },
    )
    .unwrap();

    // The gate: a recipe can never be attached to an untracked item.
    assert!(recipes_svc::set_recipe(&conn, &m, service_id, &recipe_lines(&[(sugar, 10)])).is_err());

    // The payload is honest about it, so the UI shows no recipe affordance.
    let item = catalog::get(&conn, service_id).unwrap().unwrap();
    assert!(!item.track_inventory);
    assert!(!item.has_recipe);

    sale(&conn, &staff, &[(service_id, 1)]);
    assert_eq!(balance(&conn, sugar), 1_000);
}

/// Scenario G — a purchase raises stock, writes a PURCHASE movement and books
/// the matching SUPPLIES expense, all linked and all in one transaction.
#[test]
fn scenario_g_purchase_links_movement_to_expense_atomically() {
    let conn = fresh();
    let m = manager(&conn);
    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");

    recipes_svc::purchase_material(
        &conn,
        &m,
        &PurchaseInput {
            raw_material_id: beans,
            quantity: 2,
            purchase_unit: "KILOGRAM".into(),
            total_cost_minor: 100_000,
            note: None,
        },
    )
    .unwrap();

    // 2 KG normalizes to 2000 g — never 2, and never a float.
    assert_eq!(balance(&conn, beans), 2_000);

    let movements = recipes::list_movements(&conn, Some(beans), 10).unwrap();
    let purchase = movements
        .iter()
        .find(|mv| mv.reason == "PURCHASE")
        .expect("a PURCHASE movement is written");
    assert_eq!(purchase.change, 2_000);
    let expense_id = purchase
        .expense_id
        .expect("the purchase references its expense");

    // The expense is a NORMAL existing SUPPLIES expense of the exact total.
    let (category, amount): (String, i64) = conn
        .query_row(
            "SELECT category, amount FROM expenses WHERE id = ?1",
            [expense_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(category, "SUPPLIES");
    assert_eq!(amount, 100_000);

    // ...and the informational per-base-unit cost is what Recipe Cost reads.
    let row = recipes::get_material(&conn, beans).unwrap().unwrap();
    assert_eq!(row.last_purchase_unit_cost_minor, Some(50)); // 100000 / 2000
}

/// A purchase whose unit does not match the material's family is refused,
/// and nothing is half-written.
#[test]
fn a_purchase_unit_must_match_the_material_family() {
    let conn = fresh();
    let m = manager(&conn);
    let milk = material(&conn, &m, "حليب", "MILLILITER");

    let result = recipes_svc::purchase_material(
        &conn,
        &m,
        &PurchaseInput {
            raw_material_id: milk,
            quantity: 1,
            purchase_unit: "KILOGRAM".into(),
            total_cost_minor: 1_000,
            note: None,
        },
    );
    assert!(result.is_err());
    assert_eq!(balance(&conn, milk), 0);
    assert!(recipes::list_movements(&conn, Some(milk), 10)
        .unwrap()
        .is_empty());
    let expenses_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM expenses", [], |r| r.get(0))
        .unwrap();
    assert_eq!(expenses_count, 0);
}

/// Scenario H — WASTE is always a decrease and always records its reason.
#[test]
fn scenario_h_waste_decreases_and_records_the_reason() {
    let conn = fresh();
    let m = manager(&conn);
    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 500, None).unwrap();

    recipes_svc::waste_material(&conn, &m, sugar, 100, Some("تالف")).unwrap();

    assert_eq!(balance(&conn, sugar), 400);
    let movement = recipes::list_movements(&conn, Some(sugar), 10)
        .unwrap()
        .into_iter()
        .find(|mv| mv.reason == "WASTE")
        .expect("a WASTE movement is written");
    assert_eq!(movement.change, -100);
    assert_eq!(movement.note.as_deref(), Some("تالف"));

    // Waste may never exceed what exists.
    assert!(recipes_svc::waste_material(&conn, &m, sugar, 500, None).is_err());
    assert_eq!(balance(&conn, sugar), 400);
}

/// Scenario I — adjustment works in both directions and never goes negative.
#[test]
fn scenario_i_adjustment_both_directions_never_negative() {
    let conn = fresh();
    let m = manager(&conn);
    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");

    recipes_svc::adjust_material(&conn, &m, beans, 300, None).unwrap();
    assert_eq!(balance(&conn, beans), 300);

    recipes_svc::adjust_material(&conn, &m, beans, -100, None).unwrap();
    assert_eq!(balance(&conn, beans), 200);

    // A negative result is refused; balance and ledger stay in step.
    assert!(recipes_svc::adjust_material(&conn, &m, beans, -500, None).is_err());
    assert_eq!(balance(&conn, beans), 200);
    let movements = recipes::list_movements(&conn, Some(beans), 10).unwrap();
    assert_eq!(
        movements.iter().map(|mv| mv.change).sum::<i64>(),
        200,
        "the ledger sums to exactly the authoritative balance"
    );
}

/// Scenario J — one material serves many recipes, each with its own quantity.
#[test]
fn scenario_j_one_material_serves_many_recipes_independently() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    shift_svc::open_day(&conn, &m).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 10_000, None).unwrap();

    let coffee = tracked_product(&conn, "قهوة");
    let tea = tracked_product(&conn, "شاي");
    let juice = tracked_product(&conn, "عصير");
    let iced = tracked_product(&conn, "قهوة مثلجة");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 12)])).unwrap();
    recipes_svc::set_recipe(&conn, &m, tea, &recipe_lines(&[(sugar, 10)])).unwrap();
    recipes_svc::set_recipe(&conn, &m, juice, &recipe_lines(&[(sugar, 20)])).unwrap();
    recipes_svc::set_recipe(&conn, &m, iced, &recipe_lines(&[(sugar, 15)])).unwrap();

    // Each recipe keeps its OWN quantity — independent rows, no coupling.
    assert_eq!(
        recipes::get_recipe(&conn, coffee).unwrap()[0].quantity_base,
        12
    );
    assert_eq!(
        recipes::get_recipe(&conn, tea).unwrap()[0].quantity_base,
        10
    );
    assert_eq!(
        recipes::get_recipe(&conn, juice).unwrap()[0].quantity_base,
        20
    );
    assert_eq!(
        recipes::get_recipe(&conn, iced).unwrap()[0].quantity_base,
        15
    );

    // One sale mixing all four sums the shared material:
    // 1(12) + 2(10) + 1(20) + 3(15) = 12 + 20 + 20 + 45 = 97 g.
    sale(
        &conn,
        &staff,
        &[(coffee, 1), (tea, 2), (juice, 1), (iced, 3)],
    );
    assert_eq!(balance(&conn, sugar), 9_903);
}

/// Recipe Cost is INFORMATIONAL: quantity × latest known per-unit cost.
#[test]
fn recipe_cost_is_informational_and_never_touches_history() {
    let conn = fresh();
    let m = manager(&conn);
    let beans = material(&conn, &m, "حبوب القهوة", "GRAM");
    recipes_svc::purchase_material(
        &conn,
        &m,
        &PurchaseInput {
            raw_material_id: beans,
            quantity: 1,
            purchase_unit: "KILOGRAM".into(),
            total_cost_minor: 500_000,
            note: None,
        },
    )
    .unwrap();

    let coffee = tracked_product(&conn, "قهوة");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(beans, 10)])).unwrap();

    // 10 g × 500 minor/g = 5000 minor — a display estimate only.
    let cost = recipes_svc::recipe_cost(&conn, coffee).unwrap();
    assert_eq!(cost.total_cost_minor, Some(5_000));
    assert_eq!(cost.lines[0].unit_cost_minor, Some(500));

    // It is not accounting truth: the recorded expense is untouched.
    let amount: i64 = conn
        .query_row("SELECT amount FROM expenses", [], |r| r.get(0))
        .unwrap();
    assert_eq!(amount, 500_000);
}

/// Checked accumulation: a merging payload that would overflow i64 fails
/// closed with no partial recipe writes.
#[test]
fn quantity_overflow_fails_closed_without_partial_writes() {
    let conn = fresh();
    let m = manager(&conn);
    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 10, None).unwrap();
    let coffee = tracked_product(&conn, "قهوة");
    let half = i64::MAX / 2 + 1;
    let err = recipes_svc::set_recipe(
        &conn,
        &m,
        coffee,
        &recipe_lines(&[(sugar, half), (sugar, half)]),
    )
    .unwrap_err();
    assert!(
        matches!(err, crate::error::AppError::Internal(ref c) if c == "rawmaterials.quantity_overflow"),
        "merge overflow fails closed: {err:?}"
    );
    assert!(recipes::get_recipe(&conn, coffee).unwrap().is_empty());
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 5)])).unwrap();
    assert_eq!(
        recipes::get_recipe(&conn, coffee).unwrap()[0].quantity_base,
        5
    );
}

/// STAFF cannot invoke manager-only mutations: the service gate is
/// authoritative, not the hidden UI button.
#[test]
fn staff_is_forbidden_from_raw_material_mutations() {
    let conn = fresh();
    let m = manager(&conn);
    let staff = login(&conn, "momo", "11111");
    let beans = material(&conn, &m, "حبوب", "GRAM");
    assert!(recipes_svc::create_material(
        &conn,
        &staff,
        &recipes::NewMaterial {
            name: "x".into(),
            department: "CAFE".into(),
            base_unit: "GRAM".into()
        }
    )
    .is_err());
    assert!(recipes_svc::purchase_material(
        &conn,
        &staff,
        &PurchaseInput {
            raw_material_id: beans,
            quantity: 1,
            purchase_unit: "GRAM".into(),
            total_cost_minor: 100,
            note: None,
        }
    )
    .is_err());
    assert!(recipes_svc::adjust_material(&conn, &staff, beans, 5, None).is_err());
    assert!(recipes_svc::waste_material(&conn, &staff, beans, 1, None).is_err());
    let coffee = tracked_product(&conn, "قهوة");
    assert!(recipes_svc::set_recipe(&conn, &staff, coffee, &recipe_lines(&[(beans, 1)])).is_err());
    assert_eq!(balance(&conn, beans), 0);
}

/// Advisory availability: available / short / no-recipe absent, read-only.
#[test]
fn recipe_availability_batches_without_touching_stock() {
    let conn = fresh();
    let m = manager(&conn);
    let sugar = material(&conn, &m, "سكر", "GRAM");
    recipes_svc::adjust_material(&conn, &m, sugar, 15, None).unwrap();
    let coffee = tracked_product(&conn, "قهوة");
    let tea = tracked_product(&conn, "شاي");
    let plain = tracked_product(&conn, "سادة");
    recipes_svc::set_recipe(&conn, &m, coffee, &recipe_lines(&[(sugar, 10)])).unwrap();
    recipes_svc::set_recipe(&conn, &m, tea, &recipe_lines(&[(sugar, 20)])).unwrap();
    let rows = recipes_svc::recipe_availability(&conn, &[coffee, tea, plain, 999_999]).unwrap();
    let by_id: std::collections::HashMap<i64, bool> =
        rows.iter().map(|r| (r.product_id, r.available)).collect();
    assert_eq!(by_id.get(&coffee), Some(&true));
    assert_eq!(by_id.get(&tea), Some(&false));
    assert!(!by_id.contains_key(&plain), "no recipe -> no row");
    assert!(!by_id.contains_key(&999_999));
    assert_eq!(balance(&conn, sugar), 15);
}

/// Reset ordering keeps FKs green with the new child tables first.
#[test]
fn developer_reset_clears_recipe_tables_child_first() {
    use crate::repositories::developer::APPLICATION_DATA_TABLES;
    let pos = |t: &str| {
        APPLICATION_DATA_TABLES
            .iter()
            .position(|x| *x == t)
            .unwrap()
    };
    assert!(pos("raw_material_movements") < pos("raw_materials"));
    assert!(pos("product_recipe_items") < pos("products"));
    assert!(pos("raw_material_movements") < pos("expenses"));
    assert!(pos("raw_material_movements") < pos("invoices"));
}
