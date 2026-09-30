//! Catalog business rules.
//!
//! Create/update/price/availability are single-row edits whose validation lives
//! with their commands (see `commands::catalog`). DELETION is different: it is
//! an ADMIN-only, audit-recorded, seemingly destructive action, so the rule that
//! makes it safe — archive a product, and remove a category only while nothing
//! points at it — is stated once, here, and enforced no matter which caller
//! reaches it.

use crate::error::{AppError, AppResult};
use crate::repositories::{catalog, Db};
use crate::services::audit;
use crate::services::auth::{require_role, User};

/// ADMIN-only delete of a product or service.
///
/// Ordering is the contract:
///   1. authorization (ADMIN) — a STAFF/MANAGER caller is rejected here,
///      whatever the frontend did or did not render;
///   2. the item must exist in the live catalog (an unknown or already-deleted
///      id is a not-found, never a silent success);
///   3. the row is ARCHIVED, never `DELETE`d, so invoices, order lines, stock
///      movements, reports and audit entries keep their references AND their
///      original name/price snapshots;
///   4. the action is written to the audit log like every other catalog write.
pub fn delete_product(conn: &Db, actor: &User, product_id: i64) -> AppResult<()> {
    require_role(actor, "ADMIN")?;

    let Some(product) = catalog::get(conn, product_id)? else {
        return Err(AppError::not_found("catalog.item_not_found"));
    };

    if !catalog::archive(conn, product_id)? {
        return Err(AppError::not_found("catalog.item_not_found"));
    }

    audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "catalog.product_deleted",
        "product",
        Some(&product_id.to_string()),
        None,
        Some(&serde_json::json!({
            "name": product.name,
            "item_type": product.item_type,
            "department": product.department,
            "category_id": product.category_id,
            "price_minor": product.price_minor,
        })),
    )
}

/// MANAGER+ rename of a category.
///
/// Products reference a category by ID, never by its name, and historical
/// invoices snapshot the category name at the moment of sale — so renaming
/// relabels today's catalog and leaves every past record exactly as it was.
///
/// The rule set is the same one the create command applies (non-empty trimmed
/// name, unique across categories), restated here so it holds for every caller.
pub fn rename_category(conn: &Db, actor: &User, category_id: i64, name: &str) -> AppResult<()> {
    require_role(actor, "MANAGER")?;

    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::validation("catalog.category_name_required"));
    }

    let Some(category) = catalog::get_category(conn, category_id)? else {
        return Err(AppError::not_found("catalog.category_not_found"));
    };

    if catalog::category_name_exists_except(conn, name, category_id)? {
        return Err(AppError::validation("catalog.category_name_taken"));
    }

    if !catalog::update_category(conn, category_id, name)? {
        return Err(AppError::not_found("catalog.category_not_found"));
    }

    audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "catalog.category_updated",
        "category",
        Some(&category_id.to_string()),
        Some(&serde_json::json!({ "name": category.name })),
        Some(&serde_json::json!({ "name": name })),
    )
}

/// ADMIN-only delete of a category — narrower than renaming, exactly like
/// deleting a product is narrower than editing one.
///
/// Ordering is the contract:
///   1. authorization (ADMIN) — a MANAGER/STAFF caller is rejected here, whatever
///      the frontend did or did not render;
///   2. the category must exist (an unknown id is a not-found, never a silent
///      success);
///   3. the SYSTEM category is refused: it is the fallback every product was
///      migrated onto, and removing it would leave the catalog with no default;
///   4. a category that still holds products is refused with a business-rule
///      error. `products.category_id` is `NOT NULL REFERENCES categories(id)`
///      with foreign keys ON, so this pre-check is the readable form of what the
///      database would otherwise enforce — the ADMIN is told to move the items
///      instead of losing them or losing the category;
///   5. the removal is written to the audit log like every other catalog write.
pub fn delete_category(conn: &Db, actor: &User, category_id: i64) -> AppResult<()> {
    require_role(actor, "ADMIN")?;

    let Some(category) = catalog::get_category(conn, category_id)? else {
        return Err(AppError::not_found("catalog.category_not_found"));
    };

    if category.is_system {
        return Err(AppError::business("catalog.category_is_system"));
    }

    if catalog::category_product_count(conn, category_id)? > 0 {
        return Err(AppError::business("catalog.category_in_use"));
    }

    if !catalog::delete_category(conn, category_id)? {
        return Err(AppError::not_found("catalog.category_not_found"));
    }

    audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "catalog.category_deleted",
        "category",
        Some(&category_id.to_string()),
        Some(&serde_json::json!({ "name": category.name })),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::repositories::invoices;
    use crate::repositories::pos;
    use crate::services::auth::{self, LoginInput};
    use crate::services::{checkout, pos as pos_svc, shifts};
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        crate::demo_data::seed_for_development(&conn).unwrap();
        conn
    }

    fn login(conn: &Connection, name: &str, password: &str) -> User {
        auth::login(
            conn,
            &LoginInput {
                name: name.to_string(),
                password: password.to_string(),
            },
        )
        .unwrap()
        .user
    }

    fn product_id(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM products WHERE name = ?1 ORDER BY id LIMIT 1",
            [name],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Sell one unit of a seeded product and pay, producing a real closed
    /// invoice whose line is an immutable snapshot.
    fn sell(conn: &Connection, staff: &User, name: &str) -> i64 {
        let table = pos::list_tables(conn, None).unwrap().remove(0);
        pos_svc::open_table(conn, staff, table.id).unwrap();
        let order_id = pos_svc::start_order(conn, staff, table.id).unwrap();
        pos_svc::add_line(conn, staff, order_id, product_id(conn, name), 1).unwrap();
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
                received: Some(1_000_000),
            },
        )
        .unwrap()
        .invoice_id
    }

    fn invoice_line(conn: &Connection, invoice_id: i64) -> (String, i64, String, i64) {
        conn.query_row(
            "SELECT product_name, unit_price, department, line_total
             FROM invoice_lines WHERE invoice_id = ?1",
            [invoice_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    }

    #[test]
    fn an_admin_can_delete_a_product() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = product_id(&conn, "كابتشينو");

        delete_product(&conn, &admin, id).unwrap();

        assert!(catalog::get(&conn, id).unwrap().is_none());
        // Archived, not removed: the original data is still on the row.
        let archived: (i64, String, i64) = conn
            .query_row(
                "SELECT is_active, name, price_minor FROM products
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(archived, (0, "كابتشينو".to_string(), 8900));
    }

    // ------------------------------------------------- inactive products

    /// An open business day AND shift, so the POS order path is reachable.
    fn open_day(conn: &Connection) {
        let admin = login(conn, "admin", "admin123");
        let staff = login(conn, "cashier", "cashier123");
        shifts::open_day(conn, &admin).unwrap();
        shifts::open_shift(conn, &staff, 0).unwrap();
    }

    /// Turn a seeded product off, the way the Catalog page does.
    fn deactivate(conn: &Connection, name: &str) -> i64 {
        let id = product_id(conn, name);
        catalog::set_active(conn, id, false).unwrap();
        id
    }

    /// An ACTIVE product is in the cashier-facing query and can be ordered.
    #[test]
    fn an_active_product_is_sellable_by_a_cashier() {
        let conn = fresh();
        let staff = login(&conn, "cashier", "cashier123");
        let id = product_id(&conn, "كابتشينو");

        let sellable = catalog::list(&conn, Some("CAFE"), true).unwrap();
        assert!(
            sellable.iter().any(|p| p.id == id),
            "an active product must be listed"
        );
        assert!(
            sellable.iter().all(|p| p.is_active),
            "the sellable list is active-only"
        );

        // And the order itself goes through.
        open_day(&conn);
        sell(&conn, &staff, "كابتشينو");
    }

    /// An INACTIVE product is absent from the cashier-facing query, absent from
    /// search (the list is the search corpus) and from every department view.
    #[test]
    fn an_inactive_product_is_absent_from_every_cashier_facing_query() {
        let conn = fresh();
        let id = deactivate(&conn, "كابتشينو");

        for department in [None, Some("CAFE"), Some("WASH")] {
            let listed = catalog::list(&conn, department, true).unwrap();
            assert!(
                !listed.iter().any(|p| p.id == id),
                "inactive product leaked into {department:?}"
            );
        }
    }

    /// RULE 2: the BUSINESS LAYER refuses the inactive product even when the id
    /// is submitted directly — a stale UI, a tampered request and a replayed
    /// cached id all land here.
    #[test]
    fn an_inactive_product_cannot_be_added_to_an_order() {
        let conn = fresh();
        let staff = login(&conn, "cashier", "cashier123");
        let id = deactivate(&conn, "كابتشينو");
        open_day(&conn);

        let table = pos::list_tables(&conn, None).unwrap().remove(0);
        pos_svc::open_table(&conn, &staff, table.id).unwrap();
        let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();

        let err = pos_svc::add_line(&conn, &staff, order_id, id, 1).unwrap_err();
        assert!(
            matches!(err, AppError::BusinessRule(_)),
            "an inactive product must be refused by the service, got {err:?}"
        );
        // Nothing was written: the order still has no lines.
        let lines: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_lines WHERE order_id = ?1",
                [order_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(lines, 0, "the refused line must not be persisted");
    }

    /// REGRESSION: re-activation puts the product back into service completely —
    /// visible to the cashier AND orderable again.
    #[test]
    fn re_activating_a_product_makes_it_sellable_again() {
        let conn = fresh();
        let staff = login(&conn, "cashier", "cashier123");
        let id = deactivate(&conn, "كابتشينو");
        open_day(&conn);
        assert!(!catalog::list(&conn, Some("CAFE"), true)
            .unwrap()
            .iter()
            .any(|p| p.id == id));

        catalog::set_active(&conn, id, true).unwrap();

        assert!(catalog::list(&conn, Some("CAFE"), true)
            .unwrap()
            .iter()
            .any(|p| p.id == id));
        // And the order goes through exactly as it did before deactivation.
        sell(&conn, &staff, "كابتشينو");
    }

    /// REGRESSION: a MANAGER/ADMIN still sees inactive items, because the
    /// Catalog page is where they are listed and re-activated. Deactivation must
    /// not make a product unmanageable.
    #[test]
    fn a_manager_still_sees_and_manages_inactive_products() {
        let conn = fresh();
        let id = deactivate(&conn, "كابتشينو");

        let all = catalog::list(&conn, None, false).unwrap();
        let found = all
            .iter()
            .find(|p| p.id == id)
            .expect("managers see inactive items");
        assert!(
            !found.is_active,
            "it is listed precisely so it can be re-activated"
        );

        // And the management action that reverses it is still permitted.
        catalog::set_active(&conn, id, true).unwrap();
        assert!(catalog::list(&conn, None, false)
            .unwrap()
            .iter()
            .any(|p| p.id == id && p.is_active));
    }

    /// RULE 2 + the capability the command enforces: only a catalog MANAGER may
    /// read the whole catalog. A STAFF asking for `active_only = false` is
    /// answered with the active-only list instead, so the cashier-facing query
    /// cannot be widened from the client side.
    #[test]
    fn a_cashier_cannot_widen_the_catalog_query_to_reach_inactive_items() {
        use crate::services::auth::may_manage_catalog;

        let conn = fresh();
        let id = deactivate(&conn, "كابتشينو");

        // A cashier asking for the whole catalog.
        let requested = false;
        // Exactly the guard the Tauri command applies.
        let effective = crate::commands::catalog::effective_active_only("STAFF", requested);
        assert!(effective, "a STAFF request must be forced to active-only");
        assert!(
            !catalog::list(&conn, None, effective)
                .unwrap()
                .iter()
                .any(|p| p.id == id),
            "a STAFF must not receive inactive items"
        );

        // A catalog manager still gets them.
        for role in ["MANAGER", "ADMIN"] {
            assert!(may_manage_catalog(role), "{role} manages the catalog");
            let requested = false;
            let effective = crate::commands::catalog::effective_active_only(role, requested);
            assert!(!effective, "{role} keeps catalog visibility");
            let listed = catalog::list(&conn, None, effective).unwrap();
            assert!(
                listed.iter().any(|p| p.id == id),
                "{role} keeps catalog visibility"
            );
        }
    }

    /// An archived (ADMIN-deleted) item is gone from BOTH views: deactivation
    /// and deletion are different rules and must not be conflated.
    #[test]
    fn a_deleted_product_is_absent_even_from_the_manager_catalog() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = product_id(&conn, "كابتشينو");

        delete_product(&conn, &admin, id).unwrap();

        assert!(!catalog::list(&conn, None, true)
            .unwrap()
            .iter()
            .any(|p| p.id == id));
        assert!(!catalog::list(&conn, None, false)
            .unwrap()
            .iter()
            .any(|p| p.id == id));
    }

    #[test]
    fn a_deleted_item_is_absent_from_every_active_catalog_query() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = product_id(&conn, "كابتشينو");

        // Both the POS query and the management "everything" query.
        let pos_before = catalog::list(&conn, Some("CAFE"), true).unwrap();
        let all_before = catalog::list(&conn, None, false).unwrap();
        assert!(pos_before.iter().any(|p| p.id == id));
        assert!(all_before.iter().any(|p| p.id == id));

        delete_product(&conn, &admin, id).unwrap();

        let pos_after = catalog::list(&conn, Some("CAFE"), true).unwrap();
        let all_after = catalog::list(&conn, None, false).unwrap();
        assert!(!pos_after.iter().any(|p| p.id == id));
        assert!(!all_after.iter().any(|p| p.id == id));
        assert!(catalog::get(&conn, id).unwrap().is_none());
    }

    #[test]
    fn a_staff_user_cannot_delete() {
        let conn = fresh();
        let staff = login(&conn, "cashier", "cashier123");
        let id = product_id(&conn, "كابتشينو");

        let err = delete_product(&conn, &staff, id).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
        // Nothing changed: the gate runs before any write.
        assert!(catalog::get(&conn, id).unwrap().is_some());
    }

    #[test]
    fn a_manager_cannot_delete() {
        let conn = fresh();
        let manager = login(&conn, "manager", "manager123");
        let id = product_id(&conn, "كابتشينو");

        let err = delete_product(&conn, &manager, id).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
        assert!(catalog::get(&conn, id).unwrap().is_some());
    }

    #[test]
    fn deleting_an_unknown_or_already_deleted_item_is_not_found() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = product_id(&conn, "كابتشينو");

        assert!(matches!(
            delete_product(&conn, &admin, 999_999).unwrap_err(),
            AppError::NotFound(_)
        ));

        delete_product(&conn, &admin, id).unwrap();
        assert!(matches!(
            delete_product(&conn, &admin, id).unwrap_err(),
            AppError::NotFound(_)
        ));
    }

    /// The core promise: yesterday's invoice is untouched by today's delete.
    #[test]
    fn a_historical_invoice_survives_the_delete_with_its_original_snapshot() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let staff = login(&conn, "cashier", "cashier123");
        shifts::open_day(&conn, &admin).unwrap();
        shifts::open_shift(&conn, &staff, 0).unwrap();

        let product = product_id(&conn, "كابتشينو");
        let invoice_id = sell(&conn, &staff, "كابتشينو");
        let before = invoice_line(&conn, invoice_id);
        assert_eq!(
            before,
            ("كابتشينو".to_string(), 8900, "CAFE".to_string(), 8900)
        );

        delete_product(&conn, &admin, product).unwrap();

        // 1. The item is gone from the active catalog.
        assert!(catalog::get(&conn, product).unwrap().is_none());
        // 2. The invoice still exists and still totals what it did.
        let (invoice, _) = invoices::get_invoice_full(&conn, invoice_id)
            .unwrap()
            .unwrap();
        assert_eq!(invoice.total, 8900);
        // 3./4. Name and price are the ORIGINAL snapshot, never re-resolved.
        assert_eq!(invoice_line(&conn, invoice_id), before);
        // ...and the invoice still shows up in the list a cashier actually reads.
        let listed = invoices::search_invoices(&conn, None, None, None, None).unwrap();
        let row = listed.iter().find(|row| row.id == invoice_id).unwrap();
        assert_eq!(row.total, 8900);
        // 5. The order-line FK still resolves and the database stays consistent.
        let lines: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_lines WHERE product_id = ?1",
                [product],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lines, 1);
        let violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
        // 6. The delete is itself an audited operation.
        let audited: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action = 'catalog.product_deleted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audited, 1);
    }

    #[test]
    fn a_deleted_item_cannot_be_reactivated_or_edited() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let manager = login(&conn, "manager", "manager123");
        let id = product_id(&conn, "كابتشينو");

        delete_product(&conn, &admin, id).unwrap();

        // A MANAGER "Activate" is a no-op on an archived row.
        catalog::set_active(&conn, id, true).unwrap();
        let (is_active, deleted_at): (i64, Option<String>) = conn
            .query_row(
                "SELECT is_active, deleted_at FROM products WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(is_active, 0);
        assert!(deleted_at.is_some());

        assert!(
            !catalog::update(&conn, id, "Revived", 1, 100, false, None, false, manager.id).unwrap()
        );

        let name: String = conn
            .query_row("SELECT name FROM products WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "كابتشينو");
    }

    /// A deleted SERVICE behaves exactly like a deleted product: gone from the
    /// active catalog, history intact.
    #[test]
    fn a_service_can_be_deleted_with_its_history_intact() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let staff = login(&conn, "cashier", "cashier123");
        shifts::open_day(&conn, &admin).unwrap();
        shifts::open_shift(&conn, &staff, 0).unwrap();

        let service = product_id(&conn, "غسيل كامل سيدان");
        let invoice_id = sell(&conn, &staff, "غسيل كامل سيدان");
        let before = invoice_line(&conn, invoice_id);
        assert_eq!(before.1, 17500);

        delete_product(&conn, &admin, service).unwrap();

        assert!(catalog::get(&conn, service).unwrap().is_none());
        assert!(!catalog::list(&conn, Some("WASH"), true)
            .unwrap()
            .iter()
            .any(|p| p.id == service));
        assert_eq!(invoice_line(&conn, invoice_id), before);
    }

    /// Every OTHER active-catalog read must hide the archived item too, not
    /// just `catalog::list`: the inventory screen and the report's stock-alert
    /// counter both read the products table directly.
    #[test]
    fn a_deleted_item_leaves_the_inventory_and_stock_alert_queries() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        // A tracked item whose opening stock is zero, so it IS a stock alert.
        let water = product_id(&conn, "مياه");

        let stock_before = crate::repositories::ops::list_stock(&conn).unwrap();
        let alerts_before = crate::services::reports::today_summary(&conn)
            .unwrap()
            .stock_alerts;
        assert!(stock_before.iter().any(|row| row.product_id == water));
        assert!(alerts_before > 0);

        delete_product(&conn, &admin, water).unwrap();

        let stock_after = crate::repositories::ops::list_stock(&conn).unwrap();
        let alerts_after = crate::services::reports::today_summary(&conn)
            .unwrap()
            .stock_alerts;
        assert!(!stock_after.iter().any(|row| row.product_id == water));
        assert_eq!(alerts_after, alerts_before - 1);

        // The stock row itself is retained for the movement history.
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM inventory_items WHERE product_id = ?1",
                [water],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 0);
    }

    /// A deleted item must be unsellable: it is gone from the POS catalog, and
    /// even a hand-crafted call straight at the POS service is refused.
    #[test]
    fn a_deleted_item_cannot_be_added_to_a_new_pos_transaction() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let staff = login(&conn, "cashier", "cashier123");
        shifts::open_day(&conn, &admin).unwrap();
        shifts::open_shift(&conn, &staff, 0).unwrap();

        let table = pos::list_tables(&conn, None).unwrap().remove(0);
        pos_svc::open_table(&conn, &staff, table.id).unwrap();
        let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();

        let product = product_id(&conn, "كابتشينو");
        pos_svc::add_line(&conn, &staff, order_id, product, 1).unwrap();

        delete_product(&conn, &admin, product).unwrap();

        let err = pos_svc::add_line(&conn, &staff, order_id, product, 1).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
    }

    /* ===================================================================== */
    /* Categories: rename is MANAGER-level, delete is ADMIN-only             */
    /* ===================================================================== */

    fn category_id(conn: &Connection, name: &str) -> i64 {
        conn.query_row("SELECT id FROM categories WHERE name = ?1", [name], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn category_name(conn: &Connection, id: i64) -> Option<String> {
        conn.query_row("SELECT name FROM categories WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .ok()
    }

    fn audit_entries(conn: &Connection, action: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM audit_log WHERE action = ?1",
            [action],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// A MANAGER renames a category: allowed, audited, and the new label is what
    /// every catalog read shows, because they all join the live category row.
    #[test]
    fn a_manager_can_rename_a_category() {
        let conn = fresh();
        let manager = login(&conn, "manager", "manager123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();

        // A name the seeded catalog does not already use.
        rename_category(&conn, &manager, id, "  مشروبات سريعة  ").unwrap();

        // The name is trimmed on the way in.
        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات سريعة"));
        assert_eq!(audit_entries(&conn, "catalog.category_updated"), 1);
    }

    /// Renaming keeps the create rules: empty and duplicate names are refused,
    /// an unknown id is a not-found, and re-saving a category's OWN unchanged
    /// name is not a duplicate of itself.
    #[test]
    fn renaming_a_category_keeps_the_creation_rules() {
        let conn = fresh();
        let manager = login(&conn, "manager", "manager123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();
        catalog::insert_category(&conn, "حلويات").unwrap();

        let empty = rename_category(&conn, &manager, id, "   ").unwrap_err();
        assert!(matches!(empty, AppError::Validation(_)), "{empty:?}");

        // Category names are unique regardless of case (COLLATE NOCASE).
        let taken = rename_category(&conn, &manager, id, "حلويات").unwrap_err();
        assert!(matches!(taken, AppError::Validation(_)), "{taken:?}");

        let unknown = rename_category(&conn, &manager, 9_999, "مشروبات").unwrap_err();
        assert!(matches!(unknown, AppError::NotFound(_)), "{unknown:?}");

        rename_category(&conn, &manager, id, "مشروبات").unwrap();
        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات"));
    }

    /// A STAFF caller is refused at the SERVICE, not merely by a hidden button.
    #[test]
    fn a_staff_user_cannot_rename_a_category() {
        let conn = fresh();
        let staff = login(&conn, "cashier", "cashier123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();

        let err = rename_category(&conn, &staff, id, "مشروبات ساخنة").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات"));
    }

    /// The terminal action is ADMIN-only: a MANAGER is refused and the category
    /// survives untouched, which is what "denied" has to mean.
    #[test]
    fn a_manager_cannot_delete_a_category() {
        let conn = fresh();
        let manager = login(&conn, "manager", "manager123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();

        let err = delete_category(&conn, &manager, id).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات"));
        assert_eq!(audit_entries(&conn, "catalog.category_deleted"), 0);
    }

    /// An ADMIN removes an EMPTY category, and the removal is audited under the
    /// name the category had at the time.
    #[test]
    fn an_admin_can_delete_an_empty_category() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();

        delete_category(&conn, &admin, id).unwrap();

        assert!(category_name(&conn, id).is_none());
        assert!(!catalog::list_categories(&conn)
            .unwrap()
            .iter()
            .any(|c| c.id == id));
        assert_eq!(audit_entries(&conn, "catalog.category_deleted"), 1);
    }

    /// A category that still holds products is refused — the ADMIN is told to
    /// move the items — and not one product is touched by the refusal. An
    /// ARCHIVED item still blocks it, because its row keeps the foreign key.
    #[test]
    fn a_category_with_products_cannot_be_deleted() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let id = catalog::insert_category(&conn, "مشروبات").unwrap();
        let product = product_id(&conn, "كابتشينو");
        catalog::update(
            &conn,
            product,
            "كابتشينو",
            id,
            3000,
            false,
            None,
            false,
            admin.id,
        )
        .unwrap();

        let err = delete_category(&conn, &admin, id).unwrap_err();
        assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");

        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات"));
        assert!(catalog::get(&conn, product).unwrap().is_some());
        assert_eq!(audit_entries(&conn, "catalog.category_deleted"), 0);

        delete_product(&conn, &admin, product).unwrap();
        let err = delete_category(&conn, &admin, id).unwrap_err();
        assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");
        assert_eq!(category_name(&conn, id).as_deref(), Some("مشروبات"));
    }

    /// The built-in system category is the fallback every product was migrated
    /// onto, so it is never removable — not even for an ADMIN.
    #[test]
    fn the_system_category_cannot_be_deleted() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");
        let system = category_id(&conn, "عام");

        let err = delete_category(&conn, &admin, system).unwrap_err();
        assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");
        assert_eq!(category_name(&conn, system).as_deref(), Some("عام"));
        assert_eq!(audit_entries(&conn, "catalog.category_deleted"), 0);
    }

    /// An unknown id is a not-found on both operations, never a silent success.
    #[test]
    fn deleting_an_unknown_category_is_a_not_found() {
        let conn = fresh();
        let admin = login(&conn, "admin", "admin123");

        let err = delete_category(&conn, &admin, 9_999).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
        assert_eq!(audit_entries(&conn, "catalog.category_deleted"), 0);
    }
}
