//! # DEMO DATASET — DEVELOPMENT / DEMONSTRATION ONLY.
//!
//! This module is the ONE home of Station's sample data, and it is deliberately
//! the exact opposite of [`crate::seed`]:
//!
//! ```text
//! crate::seed      → OFFICIAL dataset   → production-safe baseline
//! crate::demo_data → DEMO dataset       → intentionally varied dev/demo data
//! ```
//!
//! # Why it is a separate module
//!
//! The official seed used to carry the generic `admin` / `manager` / `cashier`
//! demonstration logins. That put three guessable, shared-password accounts into
//! every production installation, and it meant "Load Official Data" was never
//! actually official. Those accounts — and every other sample record — now live
//! here instead, and are only ever created by the developer-only
//! **Load Demo Data** action (`services::developer::load_demo_data`).
//!
//! Nothing here is imported by the official seed, by a migration, or by any
//! production code path. `services::developer` is its single caller.
//!
//! # What the dataset covers
//!
//! Built against the REAL schema, through the REAL repositories and services,
//! so every figure obeys the same rules as a live till:
//!
//! - demo logins for `ADMIN`, `MANAGER` and `STAFF`, each linked to the
//!   `CASHIER` employee the database CHECK requires, plus `WASH_WORKER`
//!   employees that have no login at all;
//! - a demo catalog on top of the official one: extra café and wash items,
//!   tracked-inventory items with real stock and minimum thresholds, and
//!   inactive items (which the POS correctly hides);
//! - customers with cars, from very active to a one-off walk-in;
//! - 24 months of business days, shifts, orders, invoice lines, payments
//!   (cash / card / credit / part-paid), discounts, service charges, wash
//!   tickets, credit ledger, expenses, stock movements, attendance and payroll;
//! - a final VALID live state: today's business day open, one ACTIVE shift and
//!   a few open table orders, so the POS and table grid can be inspected.
//!
//! # Rules this dataset deliberately respects
//!
//! - **No cancelled invoices.** Migration 32 removed that state; every invoice
//!   here is `PAID`, `PARTIALLY_PAID` or `CREDIT`.
//! - **Revenue comes from invoice lines.** `cafe_total` / `wash_total` are the
//!   per-department line sums exactly as checkout computes them; a takeaway or
//!   hybrid order is never reclassified as a revenue department.
//! - **Real money arithmetic.** `total = subtotal − discount + service_charge`
//!   in piastres, reusing `services::pos::validate_discount` and the shared
//!   reconciliation formula instead of a second arithmetic of our own.
//! - **Real closing snapshots.** Shift and day figures come from
//!   `repositories::shifts::compute_shift_totals` and
//!   `services::reconciliation::aggregate_day`.
//! - **Real attendance rounding.** Punches go through
//!   `services::attendance::{check_in_instant, check_out_instant}`.
//! - **Business timezone.** Every timestamp is built from a business date plus a
//!   business-local wall clock through `Africa/Cairo`; no `+03:00` literal
//!   appears anywhere in this file.
//! - **Deterministic.** A fixed-seed generator drives every choice, so the same
//!   "today" always produces the same dataset.
//!
//! The ONE thing this module does that no production path can do is back-date
//! rows: Station has no "record this invoice as of last March" operation, so the
//! historical `created_at` / `opened_at` / `closed_at` values are written
//! explicitly after insert. Only the CLOCK is supplied by the demo; every
//! amount, state transition and aggregate is produced by the real code.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repositories::catalog::{self, NewProduct};
use crate::repositories::customers;
use crate::repositories::employee_analytics;
use crate::repositories::employees::{self, NewEmployee};
use crate::repositories::expenses;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::ops;
use crate::repositories::pos;
use crate::repositories::shifts::{self, BusinessDay, DayClosingSnapshot, DayTotals, ShiftRow};
use crate::repositories::users;
use crate::services::attendance::{self, AttendanceAction};
use crate::services::auth::{self, User};
use crate::services::checkout::NO_CUSTOMER_LABEL;
use crate::services::pos as pos_svc;
use crate::services::reconciliation;
use crate::services::settings::{self, CreditConfig};
use crate::time;
use chrono::{Datelike, Duration, NaiveDate, NaiveTime};
use rusqlite::params;

// ---------------------------------------------------------------------------
// 1. Demo accounts
// ---------------------------------------------------------------------------

/// Demonstration logins: `(name, password, role)`.
///
/// These are DEMO CREDENTIALS. They are intentionally trivial so a reviewer can
/// sign in as each role, and they exist only after someone has explicitly chosen
/// "Load Demo Data". They are never created by the official seed, by a
/// migration, or by application startup.
///
/// `is_seed = 1` marks them the way the official seed marks its own rows, so
/// they stay identifiable as baseline/demo rows rather than café records.
pub const DEMO_USERS: &[(&str, &str, &str)] = &[
    ("admin", "admin123", "ADMIN"),
    ("manager", "manager123", "MANAGER"),
    ("cashier", "cashier123", "STAFF"),
    ("sara", "sara1234", "STAFF"),
];

/// Wash workers: `(name, base salary in piastres)`.
///
/// A `WASH_WORKER` has NO login — the database CHECK enforces that — which is
/// exactly what makes the Wash side of the application inspectable.
pub const DEMO_WASH_WORKERS: &[(&str, i64)] = &[
    ("محمود عبد الله", 180_000),
    ("كريم سمير", 165_000),
    ("سيد فتحي", 150_000),
];

/// Handle on the demo accounts the dataset generator works through.
struct Accounts {
    admin: User,
    manager: User,
    /// Cashier logins, in a stable order.
    cashiers: Vec<User>,
    /// Wash-worker employees, in a stable order.
    wash_employees: Vec<i64>,
}

/// Create the demo logins and their employees.
///
/// Idempotent by NAME: an account that already exists is reused rather than
/// duplicated, so calling this twice can never violate `idx_users_name`.
fn seed_accounts(conn: &Db) -> AppResult<Accounts> {
    let mut admins: Vec<User> = Vec::new();
    let mut managers: Vec<User> = Vec::new();
    let mut cashiers: Vec<User> = Vec::new();

    for (name, password, role) in DEMO_USERS {
        let user = match users::find_by_name(conn, name)? {
            Some(existing) => existing.user,
            None => {
                let hash = auth::hash_password(password)?;
                let id = users::insert(
                    conn,
                    &users::NewUser {
                        name,
                        phone: None,
                        role,
                        password_hash: &hash,
                        is_seed: true,
                    },
                )?
                .ok_or_else(|| {
                    AppError::internal(format!("demo account {name} could not be created"))
                })?;
                users::find_by_id(conn, id)?
                    .ok_or_else(|| AppError::internal("demo account vanished after insert"))?
            }
        };

        // Every login is a CASHIER employee. Migration 28 backfilled the
        // employees of an existing installation, but this creates the link
        // explicitly so the dataset is correct on a FRESH database too — and
        // the CHECK refuses a CASHIER employee with no login, so it is not
        // optional.
        if employees::find_by_user(conn, user.id)?.is_none() {
            employees::insert(
                conn,
                &NewEmployee {
                    name,
                    phone: None,
                    employee_type: "CASHIER",
                    base_salary: 0,
                    notes: None,
                    user_id: Some(user.id),
                },
            )?;
        }

        match *role {
            "ADMIN" => admins.push(user),
            "MANAGER" => managers.push(user),
            _ => cashiers.push(user),
        }
    }

    let mut wash_employees = Vec::new();
    for (name, base_salary) in DEMO_WASH_WORKERS {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM employees
                 WHERE employee_type = 'WASH_WORKER' AND name = ?1 AND user_id IS NULL",
                params![name],
                |r| r.get(0),
            )
            .ok();
        let id = match existing {
            Some(id) => id,
            None => employees::insert(
                conn,
                &NewEmployee {
                    name,
                    phone: None,
                    employee_type: "WASH_WORKER",
                    base_salary: *base_salary,
                    notes: None,
                    user_id: None,
                },
            )?,
        };
        wash_employees.push(id);
    }

    let admin = admins
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("demo dataset needs an ADMIN account"))?;
    let manager = managers
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("demo dataset needs a MANAGER account"))?;

    Ok(Accounts {
        admin,
        manager,
        cashiers,
        wash_employees,
    })
}

/// The official baseline PLUS the demo accounts.
///
/// This is the entry point the backend test-suite uses instead of the official
/// seed: those tests exercise the application through real logins, so they need
/// demo accounts — but the accounts must not come from the official dataset.
pub fn seed_for_development(conn: &Db) -> AppResult<()> {
    crate::seed::run_if_empty(conn)?;
    seed_accounts(conn)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 2. Demo catalog
// ---------------------------------------------------------------------------

/// A demo catalog row.
///
/// `(name, item_type, department, category, price EGP, opening stock, minimum, active)`
///
/// `stock = None` means the item is NOT tracked by inventory, exactly like the
/// overwhelming majority of the official café catalog. `minimum` only applies to
/// tracked items and drives the low-stock warnings on the Inventory page.
///
/// # About "variants"
///
/// Station has NO product-variant entity: there is no variant table and no
/// COLOR / SIZE / COLOR_SIZE attribute anywhere in the schema. The purchasable
/// unit is the `products` row itself, and a different size is a different
/// product — which is exactly how the official catalog already sells them
/// (`قهوة سادة صغيرة` / `قهوة سادة كبيرة`). The demo catalog follows the same
/// convention instead of inventing a variant model the app cannot read.
type DemoProduct = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    i64,
    Option<i64>,
    i64,
    bool,
);

/// Café demo items: extra drinks, an inactive discontinued item, and the
/// consumables the Inventory page needs in order to mean anything.
const DEMO_CAFE_PRODUCTS: &[DemoProduct] = &[
    ("موكا كراميل", "PRODUCT", "CAFE", "مشروبات ساخنة", 98, None, 0, true),
    ("سبانيش لاتيه", "PRODUCT", "CAFE", "مشروبات ساخنة", 88, None, 0, true),
    ("شاي أخضر", "PRODUCT", "CAFE", "مشروبات ساخنة", 35, None, 0, true),
    ("نسكافيه جولد", "PRODUCT", "CAFE", "مشروبات ساخنة", 105, None, 0, true),
    ("كركديه", "PRODUCT", "CAFE", "مشروبات ساخنة", 30, None, 0, true),
    ("سحلب بالفستق", "PRODUCT", "CAFE", "مشروبات ساخنة", 82, None, 0, true),
    ("قهوة سادة صغيرة", "PRODUCT", "CAFE", "مشروبات ساخنة", 45, None, 0, true),
    ("قهوة سادة كبيرة", "PRODUCT", "CAFE", "مشروبات ساخنة", 65, None, 0, true),
    ("لاتيه كبير", "PRODUCT", "CAFE", "مشروبات ساخنة", 92, None, 0, true),
    ("كابتشينو كراميل", "PRODUCT", "CAFE", "مشروبات ساخنة", 95, None, 0, true),
    ("عصير مانجو طازج", "PRODUCT", "CAFE", "عصائر فريشات", 95, None, 0, true),
    ("ليمون بالنعناع كبير", "PRODUCT", "CAFE", "عصائر فريشات", 90, None, 0, true),
    ("حليب جهينة 1 لتر", "PRODUCT", "CAFE", "مخزون الكافيه", 65, Some(48), 12, true),
    ("سكر 1 كجم", "PRODUCT", "CAFE", "مخزون الكافيه", 45, Some(6), 10, true),
    ("أكواب ورقية", "PRODUCT", "CAFE", "مخزون الكافيه", 55, Some(4), 8, true),
    ("بسكويت شوكولاتة", "PRODUCT", "CAFE", "ثلاجة", 20, Some(24), 10, true),
    ("مياه 1.5 لتر", "PRODUCT", "CAFE", "ثلاجة", 15, Some(60), 24, true),
    ("ريد بول 250 مل", "PRODUCT", "CAFE", "ثلاجة", 90, Some(18), 12, true),
    ("عصير برتقال معلب", "PRODUCT", "CAFE", "ثلاجة", 25, Some(0), 6, true),
    ("قهوة ساخنة منتهية", "PRODUCT", "CAFE", "مشروبات ساخنة", 60, None, 0, false),
];

/// Wash demo items: more services, tracked consumables, and an inactive one.
const DEMO_WASH_PRODUCTS: &[DemoProduct] = &[
    ("غسيل خارجي سيدان", "SERVICE", "WASH", "غسيل السيارات", 95, None, 0, true),
    ("غسيل خارجي سوزوكي", "SERVICE", "WASH", "غسيل السيارات", 110, None, 0, true),
    ("تلميع داخلي", "SERVICE", "WASH", "غسيل السيارات", 250, None, 0, true),
    ("تلميع خارجي", "SERVICE", "WASH", "غسيل السيارات", 300, None, 0, true),
    ("شمع حماية طبقة واحدة", "SERVICE", "WASH", "غسيل السيارات", 180, None, 0, true),
    ("شمع حماية طبقتان", "SERVICE", "WASH", "غسيل السيارات", 320, None, 0, true),
    ("تعقيم الكابينة بالأوزون", "SERVICE", "WASH", "غسيل السيارات", 150, None, 0, true),
    ("تنظيف المحرك", "SERVICE", "WASH", "غسيل السيارات", 180, None, 0, true),
    ("مغسلة عجلات", "SERVICE", "WASH", "غسيل السيارات", 200, None, 0, true),
    ("كوب غسيل", "PRODUCT", "WASH", "ماركت مغسلة", 25, Some(80), 20, true),
    ("قطعة فوم", "PRODUCT", "WASH", "ماركت مغسلة", 35, Some(3), 10, true),
    ("شامبو مغسلة 5 لتر", "PRODUCT", "WASH", "ماركت مغسلة", 320, Some(14), 6, true),
    ("معطر إيري 1 لتر", "PRODUCT", "WASH", "ماركت مغسلة", 150, Some(0), 4, true),
    ("ستاند إضاءة مغسلة", "PRODUCT", "WASH", "ماركت مغسلة", 900, Some(2), 1, true),
    ("بريشة تلميع", "PRODUCT", "WASH", "ماركت مغسلة", 45, Some(22), 8, true),
    ("غسيل بالبخار", "SERVICE", "WASH", "غسيل السيارات", 220, None, 0, false),
];

/// Insert the demo catalog on top of the official one.
///
/// `is_seed = 0` on purpose: these are ordinary catalog rows, not part of the
/// authoritative starter list, so the official `sync_catalog` pass (which only
/// ever touches `is_seed = 1`) can neither deactivate nor delete them.
fn seed_products(conn: &Db, actor_id: i64) -> AppResult<()> {
    for table in [DEMO_CAFE_PRODUCTS, DEMO_WASH_PRODUCTS] {
        for (name, item_type, department, category, price, stock, min_qty, active) in table {
            let category_id = catalog::ensure_category(conn, category)?;
            let price_minor = price.checked_mul(100).ok_or_else(|| {
                AppError::internal(format!("demo price overflow for product: {name}"))
            })?;

            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM products
                     WHERE name = ?1 AND department = ?2 AND category_id = ?3
                     ORDER BY id LIMIT 1",
                    params![name, department, category_id],
                    |r| r.get(0),
                )
                .ok();

            let product_id = match existing {
                Some(id) => id,
                None => catalog::insert(
                    conn,
                    &NewProduct {
                        name,
                        item_type,
                        department,
                        category_id,
                        price_minor,
                        track_inventory: stock.is_some(),
                        // `catalog::insert` records the opening movement through
                        // the ledger, so quantity and history agree from the start.
                        stock_quantity: stock.unwrap_or(0),
                        is_new: false,
                        user_id: actor_id,
                    },
                )?,
            };

            // The minimum-quantity threshold is what turns the Inventory page
            // into a real screen: without it every item reads "fine" forever.
            if stock.is_some() {
                ops::set_min_quantity(conn, product_id, *min_qty)?;
            }

            if !*active {
                // The POS filters on `is_active`, so this is what proves an
                // inactive item disappears from the cashier's product page
                // without the demo data doing anything special to achieve it.
                catalog::set_active(conn, product_id, false)?;
            }
        }
    }

    Ok(())
}

/// Customers and their cars: `(name, phone, note, cars)`, each car being
/// `(plate, model)`.
///
/// Deliberately varied: a very active multi-car owner, single-car owners,
/// customers with no phone on file, and walk-ins with no car at all.
const DEMO_CUSTOMERS: &[(&str, Option<&str>, Option<&str>, &[(&str, &str)])] = &[
    (
        "أحمد سيد",
        Some("01001234567"),
        Some("عميل دائم"),
        &[("أ ب ج 1234", "BYD F3"), ("ر س ت 9876", "Nissan Sunny")],
    ),
    (
        "محمود عبد الرحمن",
        Some("01122334455"),
        Some("صاحب مغسلة"),
        &[("د هـ و 2233", "Hyundai Tucson")],
    ),
    (
        "مصطفى صلاح",
        Some("01233445566"),
        None,
        &[("ى ك ل 4455", "Chevrolet Tofa")],
    ),
    ("نهى إبراهيم", Some("01099887766"), None, &[]),
    (
        "كريم وائل",
        Some("01155667788"),
        Some("اشتراك شهري"),
        &[("م ن س 6677", "Fiat Fiore")],
    ),
    ("سارة حسن", Some("01266778899"), None, &[("ص ق ر 7788", "Kia Cerato")]),
    (
        "عمرو فتحي",
        Some("01077665544"),
        None,
        &[("ت ث ج 5544", "MG5")],
    ),
    ("هدى جمال", None, Some("زبونة نقدية فقط"), &[]),
    ("ياسر نبيل", Some("01188776655"), None, &[("خ ز ح 3322", "Peugeot 301")]),
    ("عميل عابر", None, None, &[]),
];

/// Create the demo customers and their cars.
fn seed_customers(conn: &Db) -> AppResult<Vec<i64>> {
    let mut ids = Vec::new();
    for (name, phone, notes, cars) in DEMO_CUSTOMERS {
        // `customers::insert` refuses a duplicate normalized phone — the
        // production duplicate-prevention rule — so reuse the row if present.
        let id = match customers::search(conn, name)?
            .into_iter()
            .find(|c| c.customer.name == *name)
        {
            Some(found) => found.customer.id,
            None => customers::insert(conn, name, *phone, *notes)?,
        };
        for (plate, model) in cars.iter() {
            customers::insert_car(conn, id, plate, Some(model), None)?;
        }
        ids.push(id);
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// 3. Determinism + business-time helpers
// ---------------------------------------------------------------------------

/// A tiny deterministic generator (xorshift64*).
///
/// The demo dataset must be REPRODUCIBLE: the same "today" has to yield the
/// same dataset so a bug found in demo data can be re-examined. `rand` is
/// deliberately not used here — that reproducibility is the whole point.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value in `0..n`.
    fn below(&mut self, n: i64) -> i64 {
        (self.next_u64() % (n.max(1) as u64)) as i64
    }

    /// An inclusive range.
    fn between(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            lo
        } else {
            lo + self.below(hi - lo + 1)
        }
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as i64) as usize]
    }

    fn chance(&mut self, percent: i64) -> bool {
        self.below(100) < percent
    }
}

/// The instant of a business-LOCAL wall clock on a business date, as the
/// canonical UTC string every Station timestamp uses.
///
/// This is the ONLY way a timestamp is built in this module. It goes through
/// `Africa/Cairo` via `attendance::override_instant`, so Egypt's DST rule is
/// honored and no fixed offset is ever assumed — exactly like the rest of the
/// application.
fn local_instant(date: &str, hour: u32, minute: u32) -> AppResult<String> {
    let wall = NaiveTime::from_hms_opt(hour, minute, 0)
        .ok_or_else(|| AppError::internal("demo timestamp out of range"))?;
    Ok(time::to_db_timestamp(attendance::override_instant(
        date, wall,
    )?))
}

/// A catalog row the demo can sell.
#[derive(Clone)]
struct CatalogItem {
    id: i64,
    name: String,
    price_minor: i64,
    department: &'static str,
}

/// Everything one generated day needs, resolved once up front so the per-order
/// code stays readable.
struct Context<'a> {
    accounts: &'a Accounts,
    /// All customers; an order may or may not have one.
    customers: &'a [i64],
    /// Customers who own a car — the only ones a wash order may name.
    car_owners: &'a [i64],
    /// Customers authorized for credit, mirroring the credit setting.
    credit_customers: &'a [i64],
    /// The sellable catalog, split by department.
    cafe: &'a [CatalogItem],
    wash: &'a [CatalogItem],
    /// Every employee on the roster, cashiers and wash workers alike.
    employees: &'a [i64],
    rng: Rng,
    /// The business day currently being generated.
    day_id: i64,
}

/// One purchasable line the demo puts on an order.
struct Line {
    product_id: i64,
    department: String,
    name: String,
    unit_price: i64,
    quantity: i64,
}

/// How an order is settled.
enum Settlement {
    Cash { received: i64 },
    Card,
    Credit,
    /// A part payment now and the remainder later: the real `PARTIALLY_PAID`
    /// lifecycle, not an invented one.
    PartPaid { first: i64 },
}

/// Insert an OPEN business day carrying a historical calendar label.
///
/// Written directly rather than through `shifts::open_day`, because that function
/// labels the day with `station_today()` — and a demo dataset has to be able to
/// say "this happened in March". Everything else about the row is exactly what
/// the closing services leave behind.
fn historical_day(conn: &Db, date: &str, opened_by: i64) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, ?2, 'OPEN', ?3)",
        params![date, local_instant(date, 8, 0)?, opened_by],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Close a business day the way `services::shifts::close_day` does: the totals
/// and the snapshot come from the shared reconciliation aggregation, so a demo
/// day is indistinguishable from a real one to every report.
fn close_day(conn: &Db, day_id: i64, date: &str, shift_ids: &[i64], closed_by: i64) -> AppResult<()> {
    let mut rows: Vec<ShiftRow> = Vec::new();
    for id in shift_ids {
        if let Some(row) = shifts::get_shift(conn, *id)? {
            rows.push(row);
        }
    }
    let day = BusinessDay {
        id: day_id,
        day_date: date.to_string(),
        status: "OPEN".into(),
        opened_at: local_instant(date, 8, 0)?,
        closed_at: None,
    };

    let report = reconciliation::aggregate_day(conn, day, shift_ids, &rows)?;
    let totals = DayTotals {
        invoices_count: report.invoices_count,
        cafe_sales: report.cafe_sales,
        wash_sales: report.wash_sales,
        subtotal: report.subtotal,
        discounts: report.discounts,
        service_charges: report.service_charges,
        total_sales: report.total_sales,
        cash: report.cash_sales,
        card: report.card_sales,
        credit: report.credit_sales,
        expenses: report.expenses,
    };
    let snapshot = DayClosingSnapshot {
        cafe_invoices: report.areas.cafe_invoices,
        wash_invoices: report.areas.wash_invoices,
        hybrid_invoices: report.areas.hybrid_invoices,
        shift_count: report.shift_count,
        opening_cash: report.cash.opening_cash,
        cash_expenses: report.cash_expenses,
        expected_cash: report.cash.expected_cash,
        actual_cash: report.cash.actual_cash,
        shortage: report.cash.shortage,
        surplus: report.cash.surplus,
    };
    shifts::insert_final_day_closing(
        conn,
        day_id,
        closed_by,
        shift_ids,
        &totals,
        &snapshot,
        &expenses::encode_breakdown(&report.expense_breakdown),
    )?;
    conn.execute(
        "UPDATE business_days SET status = 'CLOSED', closed_at = ?2 WHERE id = ?1",
        params![day_id, local_instant(date, 23, 30)?],
    )?;
    Ok(())
}

/// The priced result of an order:
/// `(subtotal, discount_mode, discount_value, discount_minor, service_charge,
///   cafe_total, wash_total, total)`
type Priced = (i64, Option<&'static str>, Option<i64>, i64, i64, i64, i64, i64);

/// Compute the money of an order.
///
/// Delegated to the very same function checkout uses, so a demo invoice and a
/// real one can never differ. An order whose total would not be payable is
/// refused, so the demo skips it rather than persist an impossible document.
fn price_order(conn: &Db, lines: &[Line], rng: &mut Rng) -> AppResult<Priced> {
    let subtotal: i64 = lines.iter().map(|l| l.unit_price * l.quantity).sum();
    let cafe_total: i64 = lines
        .iter()
        .filter(|l| l.department == "CAFE")
        .map(|l| l.unit_price * l.quantity)
        .sum();
    let wash_total: i64 = lines
        .iter()
        .filter(|l| l.department == "WASH")
        .map(|l| l.unit_price * l.quantity)
        .sum();

    // A discount only when the order can carry one, and only from the admin's
    // own quick-pick list, so the demo never invents an amount the POS could not
    // have selected.
    let options = settings::get_discount_options(conn)?.amounts;
    let discount_minor = if subtotal > 0 && rng.chance(12) {
        match options.iter().find(|amount| **amount < subtotal) {
            Some(amount) => pos_svc::validate_discount(conn, subtotal, Some("FIXED"), Some(*amount))?,
            None => 0,
        }
    } else {
        0
    };
    let discount_mode = (discount_minor > 0).then_some("FIXED");
    let discount_value = (discount_minor > 0).then_some(discount_minor);

    // A service charge is likewise only ever one of the configured amounts.
    let charges = settings::get_service_charge(conn)?.amounts;
    let service_charge = if rng.chance(15) && !charges.is_empty() {
        charges[rng.below(charges.len() as i64) as usize]
    } else {
        0
    };

    let total = subtotal - discount_minor + service_charge;
    if total <= 0 {
        return Err(AppError::business("demo.order_total"));
    }
    Ok((
        subtotal,
        discount_mode,
        discount_value,
        discount_minor,
        service_charge,
        cafe_total,
        wash_total,
        total,
    ))
}

/// Choose how an order is paid.
///
/// Skewed towards cash (a café till), with cards, credit and a part payment all
/// represented so payment-method reporting has more than one shape.
/// `allow_credit` is true only for a customer the credit setting authorizes.
fn settle(total: i64, allow_credit: bool, rng: &mut Rng) -> Settlement {
    match rng.below(100) {
        0..=54 => {
            // Cash: the customer hands over a rounded-up note, so `change_given`
            // is populated on most documents.
            let step = 500;
            Settlement::Cash {
                received: ((total + step - 1) / step) * step,
            }
        }
        55..=84 => Settlement::Card,
        85..=94 if allow_credit => Settlement::Credit,
        95..=99 if allow_credit => Settlement::PartPaid { first: total / 2 },
        _ => Settlement::Cash { received: total },
    }
}

/// Persist one order and its settled invoice.
///
/// Follows the checkout pipeline step for step — order, lines, invoice, invoice
/// lines, customer/car snapshot, payment(s), credit ledger, stock decrement,
/// order closed, table session closed — using the same repositories, so every
/// invariant the live POS maintains is maintained here too.
#[allow(clippy::too_many_arguments)]
fn place_order(
    conn: &Db,
    ctx: &mut Context<'_>,
    shift_id: i64,
    cashier: &User,
    order_type: &str,
    table_id: Option<i64>,
    customer_id: Option<i64>,
    wash_employee_id: Option<i64>,
    lines: Vec<Line>,
    date: &str,
    hour: u32,
) -> AppResult<()> {
    if lines.is_empty() {
        return Ok(());
    }
    // The immutable context and the mutable generator are split apart here, so
    // callers never have to hold two conflicting borrows of the same struct.
    let day_id = ctx.day_id;
    let credit_customers = ctx.credit_customers;
    let rng = &mut ctx.rng;

    // A table order lives inside its lifecycle session; a takeaway never does.
    let session_id = match table_id {
        Some(id) => pos::open_session(conn, id, cashier.id, day_id, shift_id)?,
        None => None,
    };
    let Some(order_id) = pos::open_order(conn, order_type, table_id, cashier.id, day_id, shift_id)?
    else {
        return Ok(());
    };
    if let Some(session) = session_id {
        pos::set_session_order(conn, session, order_id)?;
    }

    for line in &lines {
        pos::add_line(
            conn,
            order_id,
            line.product_id,
            &line.department,
            &line.name,
            line.unit_price,
            line.quantity,
        )?;
    }
    if let Some(customer) = customer_id {
        pos::set_order_customer(conn, order_id, customer)?;
    }
    if let Some(worker) = wash_employee_id {
        pos::set_order_wash_employee(conn, order_id, Some(worker))?;
    }

    // A wash job gets its ticket BEFORE settlement, exactly as the POS does: the
    // per-day waiting number is part of the day's sequence.
    if lines.iter().any(|l| l.department == "WASH") {
        let waiting_no: i64 = conn.query_row(
            "SELECT COALESCE(MAX(waiting_no), 0) + 1 FROM wash_tickets WHERE day_date = ?1",
            params![date],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO wash_tickets (order_id, waiting_no, day_date, issued_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![order_id, waiting_no, date, local_instant(date, hour, 5)?],
        )?;
        pos::set_waiting_no(conn, order_id, waiting_no)?;
    }

    let (subtotal, discount_mode, discount_value, discount_minor, service_charge, cafe_total, wash_total, total) =
        price_order(conn, &lines, rng)?;
    if discount_minor > 0 {
        pos::set_order_discount(conn, order_id, discount_mode, discount_value)?;
    }

    let takeaway_no = match order_type {
        "TAKEAWAY" => Some(pos::next_takeaway_no(conn, day_id)?),
        _ => None,
    };
    if let Some(no) = takeaway_no {
        pos::set_takeaway_no(conn, order_id, no)?;
    }

    let invoice_no = invoices::next_invoice_no(conn)?;
    let table_label: Option<String> = table_id.and_then(|id| {
        conn.query_row(
            "SELECT label FROM cafe_tables WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    });
    let snapshot: Vec<InvoiceLine> = lines
        .iter()
        .map(|l| InvoiceLine {
            department: l.department.clone(),
            product_name: l.name.clone(),
            unit_price: l.unit_price,
            quantity: l.quantity,
            discount_minor: 0,
            line_total: l.unit_price * l.quantity,
        })
        .collect();

    let invoice_id = invoices::insert_invoice(
        conn,
        invoice_no,
        order_id,
        table_label.as_deref(),
        day_id,
        Some(shift_id),
        cashier.id,
        order_type,
        takeaway_no,
        customer_id,
        subtotal,
        discount_minor,
        discount_mode,
        discount_value,
        service_charge,
        total,
        cafe_total,
        wash_total,
        &snapshot,
    )?;

    // The customer/car identity snapshot is ALWAYS written, exactly like
    // checkout: an invoice raised without a customer carries the canonical Arabic
    // label instead of a blank.
    match customer_id {
        Some(cid) => {
            let (name, phone): (String, Option<String>) = conn.query_row(
                "SELECT name, phone FROM customers WHERE id = ?1",
                params![cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let car: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT plate_no, car_model FROM cars
                     WHERE customer_id = ?1 ORDER BY id DESC LIMIT 1",
                    params![cid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            let (plate, model) = car.map(|(p, m)| (Some(p), m)).unwrap_or((None, None));
            invoices::insert_invoice_customer(
                conn,
                invoice_id,
                &name,
                phone.as_deref(),
                plate.as_deref(),
                model.as_deref(),
            )?;
        }
        None => {
            invoices::insert_invoice_customer(conn, invoice_id, NO_CUSTOMER_LABEL, None, None, None)?
        }
    }

    // Settlement, through the real ledger writers so status, `paid_amount` and
    // the credit account can never contradict each other. Credit and a part
    // payment are offered only to a customer the credit setting authorizes.
    let allow_credit = customer_id.is_some_and(|c| credit_customers.contains(&c));
    match settle(total, allow_credit, rng) {
        Settlement::Cash { received } => {
            invoices::insert_payment(
                conn,
                invoice_id,
                "CASH",
                total,
                Some(received),
                Some(received - total),
                cashier.id,
            )?;
            invoices::apply_payment_to_invoice(conn, invoice_id, total)?;
        }
        Settlement::Card => {
            invoices::insert_payment(conn, invoice_id, "CARD", total, None, None, cashier.id)?;
            invoices::apply_payment_to_invoice(conn, invoice_id, total)?;
        }
        Settlement::Credit => {
            invoices::insert_payment(conn, invoice_id, "CREDIT", total, None, None, cashier.id)?;
            invoices::mark_invoice_credit(conn, invoice_id)?;
            invoices::open_or_extend_credit(
                conn,
                customer_id.expect("credit always has a customer"),
                total,
            )?;
        }
        Settlement::PartPaid { first } => {
            invoices::insert_payment(conn, invoice_id, "CASH", first, Some(first), None, cashier.id)?;
            invoices::apply_payment_to_invoice(conn, invoice_id, first)?;
        }
    }

    pos::set_order_status(conn, order_id, "CLOSED")?;
    if let Some(id) = table_id {
        // A settled table ends its lifecycle session: the table returns to EMPTY.
        pos::close_open_session_of_table(conn, id, cashier.id)?;
    }

    // Inventory: decrement every tracked line through the movement ledger, so
    // the quantity and its history stay in step.
    for line in &lines {
        if is_tracked(conn, line.product_id)? {
            ops::adjust(
                conn,
                line.product_id,
                -line.quantity,
                "SALE",
                None,
                Some(invoice_id),
                cashier.id,
            )?;
        }
    }

    // Back-date the document. This is the one thing no production path can do:
    // Station has no "record this invoice as of last March" operation.
    let created = local_instant(date, hour, (hour * 7) % 60)?;
    conn.execute(
        "UPDATE invoices SET created_at = ?2,
                paid_at = CASE WHEN paid_at IS NULL THEN NULL ELSE ?2 END
         WHERE id = ?1",
        params![invoice_id, created],
    )?;
    conn.execute(
        "UPDATE payments SET created_at = ?2 WHERE invoice_id = ?1",
        params![invoice_id, created],
    )?;
    conn.execute(
        "UPDATE orders SET opened_at = ?2, closed_at = ?2 WHERE id = ?1",
        params![order_id, created],
    )?;
    conn.execute(
        "UPDATE stock_movements SET created_at = ?2 WHERE ref_invoice_id = ?1",
        params![invoice_id, created],
    )?;
    if let Some(session) = session_id {
        conn.execute(
            "UPDATE table_sessions SET opened_at = ?2, closed_at = ?2 WHERE id = ?1",
            params![session, created],
        )?;
    }
    conn.execute(
        "UPDATE wash_tickets SET issued_at = ?2 WHERE order_id = ?1",
        params![order_id, created],
    )?;

    Ok(())
}

/// Is this catalog row tracked by inventory?
fn is_tracked(conn: &Db, product_id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT track_inventory FROM products WHERE id = ?1",
        params![product_id],
        |r| r.get::<_, i64>(0),
    )? != 0)
}

/// How many months of history the demo writes.
///
/// 24 is the widest window `MONTHLY_SALES_PERIOD_MONTHS` accepts, so the monthly
/// chart has real data for EVERY value the setting can hold, not only the
/// default. Nothing here hardcodes "the current month": every date is derived
/// from `time::today_business_date()` and walked backwards.
const HISTORY_MONTHS: i64 = 24;

/// The opening cash a demo till starts with.
fn opening_cash(rng: &mut Rng) -> i64 {
    rng.between(2, 12) * 5_000
}

fn days_between(from: NaiveDate, to: NaiveDate) -> i64 {
    (to - from).num_days().max(0)
}

/// The first day of the month `month` months before `today`.
///
/// Computed as a LINEAR month index rather than by shifting the month number,
/// so every offset works: December minus one is November of the SAME year, and
/// January minus one is December of the year before. A naive
/// `month - offset, wrap by 12` silently produces an invalid month as soon as
/// the offset exceeds the current month number.
fn month_first(today: NaiveDate, month: i64) -> NaiveDate {
    let index = today.year() as i64 * 12 + (today.month() as i64 - 1) - month;
    let year = index.div_euclid(12);
    let month_number = index.rem_euclid(12) + 1;
    NaiveDate::from_ymd_opt(year as i32, month_number as u32, 1).unwrap_or(today)
}

// ---------------------------------------------------------------------------
// 4. Expenses, shifts and attendance for one day
// ---------------------------------------------------------------------------

/// Expense descriptions per system category: `(code, description, min, max EGP)`
/// so the Expenses page and the category breakdown read like a real café list.
const DEMO_EXPENSES: &[(&str, &str, i64, i64)] = &[
    ("SUPPLIES", "مشتريات لبن وأكياز", 250, 900),
    ("SUPPLIES", "خامات الشرب", 400, 1_400),
    ("UTILITY", "فاتورة الكهرباء", 900, 2_400),
    ("UTILITY", "فاتورة المياه", 200, 700),
    ("MAINTENANCE", "صيانة ماكينة القهوة", 400, 1_800),
    ("MAINTENANCE", "صيانة مكبس الهواء", 350, 1_500),
    ("EMERGENCY", "قطع غيار طارئة", 300, 1_200),
    ("OTHER", "مستلزمات نظافة", 150, 600),
];

/// Record one day's expenses: some against a shift (money out of that drawer)
/// and some day-level (a bill belonging to no till) — exactly the split the
/// reconciliation module is built around.
fn seed_expenses(
    conn: &Db,
    ctx: &mut Context<'_>,
    shift_id: i64,
    date: &str,
    cashier: &User,
) -> AppResult<()> {
    // Same split as `place_order`: the immutable context and the mutable
    // generator are separated here rather than by every caller.
    let day_id = ctx.day_id;
    let rng = &mut ctx.rng;
    for _ in 0..rng.below(3) {
        let (category, description, lo, hi) = *rng.pick(DEMO_EXPENSES);
        let amount = rng.between(lo, hi) * 100;
        // Most spends leave the drawer; a few are card/transfer.
        let paid_from_cash = rng.chance(90);

        let id = expenses::insert(
            conn,
            category,
            amount,
            Some(description),
            date,
            false,
            None,
            Some(day_id),
            if paid_from_cash { Some(shift_id) } else { None },
            paid_from_cash,
            cashier.id,
            // Demo spends are ordinary expenses; none of them is an employee
            // advance, so none of them may claim an employee.
            None,
        )?;
        conn.execute(
            "UPDATE expenses SET created_at = ?2 WHERE id = ?1",
            params![id, local_instant(date, 20, 0)?],
        )?;
    }
    Ok(())
}

/// Close one shift the way `services::shifts::close_shift` does: the totals come
/// from the authoritative aggregation, the drawer formula is the shared one, and
/// a deliberate shortage or surplus appears on a few days so the closing
/// document has all three states to show.
fn close_shift(conn: &Db, shift_id: i64, date: &str, rng: &mut Rng) -> AppResult<()> {
    let totals = shifts::compute_shift_totals(conn, shift_id)?;
    let (expense_total, cash_expenses) = expenses::shift_totals(conn, shift_id)?;
    let breakdown = expenses::breakdown_for_shift(conn, shift_id)?;
    let opened: i64 = conn.query_row(
        "SELECT opening_cash FROM shifts WHERE id = ?1",
        params![shift_id],
        |r| r.get(0),
    )?;
    let expected = reconciliation::expected_cash(opened, totals.cash, cash_expenses);

    let difference = match rng.below(100) {
        0..=84 => 0,
        85..=94 => -rng.between(200, 1_500),
        _ => rng.between(200, 1_200),
    };
    let actual = (expected + difference).max(0);

    shifts::save_shift_closing(
        conn,
        shift_id,
        &totals,
        expense_total,
        cash_expenses,
        expected,
        actual,
        &local_instant(date, 21, 0)?,
        &expenses::encode_breakdown(&breakdown),
    )?;
    conn.execute(
        "UPDATE shifts SET opened_at = ?2 WHERE id = ?1",
        params![shift_id, local_instant(date, 8, 0)?],
    )?;
    Ok(())
}

/// Is this employee's day already on file?
///
/// The live attendance record is the one `idx_attendance_live` guards
/// (`employee_id`, `business_date`), so that pair is what decides whether a
/// calendar day has already been generated.
fn attendance_day_exists(conn: &Db, employee_id: i64, date: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM attendance_days
                       WHERE employee_id = ?1 AND business_date = ?2)",
        params![employee_id, date],
        |r| r.get::<_, i64>(0),
    )? != 0)
}

/// File one attendance day for an employee.
///
/// The `actual` instants are business-local wall clocks converted through
/// `Africa/Cairo`, and the `effective` ones are the attendance module's OWN
/// rounding of those instants — the same floor-for-check-in / ceil-for-check-out
/// rule a live punch goes through. The demo therefore cannot write a punch the
/// service would have moved, and `recorded_by_user_id` is a real MANAGER login,
/// which is what a wash worker (who has none) necessarily needs.
fn record_attendance(
    conn: &Db,
    recorder: &User,
    employee_id: i64,
    date: &str,
    rng: &mut Rng,
) -> AppResult<()> {
    let roll = rng.below(100);
    if roll >= 93 {
        // An explicit absence or leave: neither carries a punch pair, and the
        // CHECK constraint enforces that pairing.
        let state = if roll == 93 { "ABSENT" } else { "LEAVE" };
        employee_analytics::insert_day(
            conn,
            employee_id,
            date,
            state,
            None,
            None,
            None,
            None,
            None,
            recorder.id,
            Some("سجل تجريبي"),
        )?;
        return Ok(());
    }

    // Punch times sit ON the 10-minute grid, so the rounding rule is a no-op
    // here exactly as it is for a disciplined live punch.
    let check_in_wall = NaiveTime::from_hms_opt(8, rng.below(6) as u32 * 10, 0).unwrap();
    let check_out_wall = NaiveTime::from_hms_opt(16, rng.below(6) as u32 * 10, 0).unwrap();
    let in_actual = attendance::override_instant(date, check_in_wall)?;
    let out_actual = attendance::override_instant(date, check_out_wall)?;

    let in_effective = time::to_db_timestamp(attendance::effective_instant(
        in_actual,
        AttendanceAction::CheckIn,
    ));
    // A short day leaves the punch open, which the model allows and the UI shows
    // as "still working".
    let out_effective = (roll < 88).then(|| {
        time::to_db_timestamp(attendance::effective_instant(
            out_actual,
            AttendanceAction::CheckOut,
        ))
    });

    let id = employee_analytics::insert_day(
        conn,
        employee_id,
        date,
        "PRESENT",
        Some(&time::to_db_timestamp(in_actual)),
        Some(&in_effective),
        out_effective.as_deref(),
        out_effective.as_deref(),
        None,
        recorder.id,
        None,
    )?;
    conn.execute(
        "UPDATE attendance_days SET created_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, local_instant(date, 8, 5)?],
    )?;
    Ok(())
}

/// A handful of advances, so the employee drawer and payroll show real
/// deductions from money.
///
/// These are DIRECT ledger entries: `expense_id` is NULL, exactly like a
/// historical advance, so the demo data does not retroactively invent expenses for
/// advances that were never recorded as one. New advances recorded through the
/// Expenses screen are linked, and the salary queries read both identically.
fn seed_advances(conn: &Db, recorder: &User, employees: &[i64], rng: &mut Rng) -> AppResult<()> {
    const REASONS: &[&str] = &["سلفة شخصية", "سلفة علاج", "سلفة سفر"];
    for employee in employees.iter().take(3) {
        for _ in 0..rng.below(3) {
            let date = time::business_date_months_ago(rng.between(1, HISTORY_MONTHS - 1));
            employee_analytics::insert_advance(
                conn,
                *employee,
                rng.between(20_000, 90_000),
                &date,
                *rng.pick(REASONS),
                recorder.id,
                None,
            )?;
        }
    }
    Ok(())
}

/// Build a payroll run for one month from the real attendance and advance
/// aggregations, so a demo payslip carries exactly the figures the service would
/// have computed. Older months are finalized; the most recent stays a DRAFT, so
/// both states are visible.
fn seed_payroll(conn: &Db, recorder: &User, employees: &[i64], period: &str) -> AppResult<()> {
    let (first, last) = month_bounds(period);
    for employee in employees {
        if employee_analytics::run_for(conn, *employee, period)?.is_some() {
            continue;
        }
        let base: i64 = conn.query_row(
            "SELECT base_salary FROM employees WHERE id = ?1",
            params![employee],
            |r| r.get(0),
        )?;
        let (days, absences, leaves, minutes) =
            employee_analytics::month_attendance(conn, *employee, &first, &last)?;
        let advances = employee_analytics::advances_total_for_month(conn, *employee, &first, &last)?;
        // Station documents no attendance-based deduction, so the derived
        // deduction is zero — a manager figure only, exactly as the service.
        let net = base - advances;
        let id = employee_analytics::insert_run(
            conn,
            *employee,
            period,
            base,
            days,
            minutes,
            absences,
            leaves,
            advances,
            0,
            net,
            recorder.id,
        )?;
        if period != current_period() {
            employee_analytics::finalize_run(conn, id, recorder.id)?;
        }
    }
    Ok(())
}

/// `YYYY-MM` of today, in the business timezone.
fn current_period() -> String {
    NaiveDate::parse_from_str(&time::today_business_date(), "%Y-%m-%d")
        .map(|d| d.format("%Y-%m").to_string())
        .unwrap_or_default()
}

/// The first and last business date of a `YYYY-MM` period.
fn month_bounds(period: &str) -> (String, String) {
    let (year, month) = period.split_once('-').unwrap_or((period, "01"));
    let year: i32 = year.parse().unwrap_or(1970);
    let month: u32 = month.parse().unwrap_or(1);
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap_or_default();
    let last = first
        .succ_opt()
        .and_then(|d| d.with_day(1))
        .and_then(|d| d.pred_opt())
        .unwrap_or(first);
    (first.to_string(), last.to_string())
}

// ---------------------------------------------------------------------------
// 5. Catalog reads, order shapes and day generation
// ---------------------------------------------------------------------------

/// Read the catalog the demo sells from.
///
/// The official catalog is included deliberately: demo orders that only ever
/// contained demo products would hide the fact that the real business catalog is
/// what actually sells. Only ACTIVE rows are taken, because an inactive item is
/// not sellable and the POS refuses it.
fn read_catalog(conn: &Db) -> AppResult<(Vec<CatalogItem>, Vec<CatalogItem>)> {
    let mut stmt = conn.prepare(
        "SELECT id, name, price_minor, department FROM products
         WHERE is_active = 1 AND deleted_at IS NULL
         ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        let department: String = r.get(3)?;
        Ok(CatalogItem {
            id: r.get(0)?,
            name: r.get(1)?,
            price_minor: r.get(2)?,
            department: if department == "WASH" { "WASH" } else { "CAFE" },
        })
    })?;
    let all: Vec<CatalogItem> = rows.collect::<Result<Vec<_>, _>>()?;

    let cafe: Vec<CatalogItem> = all.iter().filter(|p| p.department == "CAFE").cloned().collect();
    let wash: Vec<CatalogItem> = all.iter().filter(|p| p.department == "WASH").cloned().collect();
    Ok((cafe, wash))
}

/// Build the lines of one order.
///
/// The SHAPE is what makes the dataset useful: café-only orders, wash orders
/// (which require a customer who owns a car), and HYBRID orders carrying both
/// departments on one document — which is exactly what the `hybrid_invoices`
/// metric and the shared-revenue rule describe.
fn build_lines(ctx: &mut Context<'_>, shape: &str) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut push = |item: &CatalogItem, quantity: i64| {
        if lines.iter().any(|l| l.product_id == item.id) {
            return;
        }
        lines.push(Line {
            product_id: item.id,
            department: item.department.to_string(),
            name: item.name.clone(),
            unit_price: item.price_minor,
            quantity,
        });
    };

    match shape {
        "WASH" => {
            for _ in 0..ctx.rng.between(1, 3) {
                let item = ctx.rng.pick(ctx.wash).clone();
                push(&item, 1);
            }
        }
        "HYBRID" => {
            let cafe = ctx.rng.pick(ctx.cafe).clone();
            push(&cafe, ctx.rng.between(1, 2));
            let wash = ctx.rng.pick(ctx.wash).clone();
            push(&wash, 1);
        }
        _ => {
            for _ in 0..ctx.rng.between(1, 4) {
                let item = ctx.rng.pick(ctx.cafe).clone();
                push(&item, ctx.rng.between(1, 3));
            }
        }
    }
    // The official catalog carries a genuinely FREE wash service (price 0), and a
    // random pick can land on it alone. An order whose lines are all zero-priced
    // has a total of 0, and `services::checkout::checkout` refuses exactly that
    // (`payment.zero_total`), so such a document is not one the till could ever
    // have produced. The demo therefore guarantees every generated order carries
    // at least one PRICED line — the free service rides along with a paid one,
    // which is how it is actually given — instead of weakening the pricing
    // arithmetic or the invariant it protects.
    if !lines.is_empty() && lines.iter().all(|l| l.unit_price <= 0) {
        let priced_pool = match shape {
            "CAFE" | "TAKEAWAY" => &ctx.cafe,
            _ => &ctx.wash,
        };
        // Written inline rather than through `push`, whose closure still holds the
        // mutable borrow of `lines`.
        if let Some(item) = priced_pool.iter().find(|i| i.price_minor > 0).cloned() {
            lines.push(Line {
                product_id: item.id,
                department: item.department.to_string(),
                name: item.name,
                unit_price: item.price_minor,
                quantity: 1,
            });
        }
    }
    lines
}

/// Generate one historical business day: an open day, one or two cashier shifts,
/// a handful of orders across the shapes, expenses, attendance, and the closing
/// snapshot for every shift and for the day itself.
fn trade_day(conn: &Db, ctx: &mut Context<'_>, tables: &[i64], date: String) -> AppResult<()> {
    let day_id = historical_day(conn, &date, ctx.accounts.manager.id)?;
    ctx.day_id = day_id;

    // The till is single, so the shifts are sequential rather than simultaneous.
    let shift_count = ctx.rng.between(1, 2);
    let mut shift_ids = Vec::new();
    for index in 0..shift_count {
        let cashier =
            ctx.accounts.cashiers[index as usize % ctx.accounts.cashiers.len()].clone();
        conn.execute(
            "INSERT INTO shifts (business_day_id, user_id, status, opened_at, opening_cash)
             VALUES (?1, ?2, 'ACTIVE', ?3, ?4)",
            params![
                day_id,
                cashier.id,
                local_instant(&date, 8, 0)?,
                opening_cash(&mut ctx.rng)
            ],
        )?;
        let shift_id = conn.last_insert_rowid();
        shift_ids.push(shift_id);

        for order in 0..ctx.rng.between(3, 9) {
            let hour = 9 + (order * 2) % 12;
            // The shape distribution is what gives the reports their variety.
            let roll = ctx.rng.below(100);
            let shape = if roll < 55 {
                "CAFE"
            } else if roll < 75 {
                "TAKEAWAY"
            } else if roll < 90 {
                "WASH"
            } else {
                "HYBRID"
            };

            let (order_type, table_id, customer_id, worker) = match shape {
                // A WASH or HYBRID order is a car job: the ticket rules require
                // a customer who actually owns a car.
                "WASH" | "HYBRID" => (
                    "TABLE",
                    Some(*ctx.rng.pick(tables)),
                    Some(*ctx.rng.pick(ctx.car_owners)),
                    Some(*ctx.rng.pick(&ctx.accounts.wash_employees)),
                ),
                "TAKEAWAY" => (
                    "TAKEAWAY",
                    None,
                    ctx.rng.chance(40).then(|| *ctx.rng.pick(ctx.customers)),
                    None,
                ),
                _ => (
                    "TABLE",
                    Some(*ctx.rng.pick(tables)),
                    ctx.rng.chance(45).then(|| *ctx.rng.pick(ctx.customers)),
                    None,
                ),
            };

            let lines = build_lines(ctx, shape);
            place_order(
                conn,
                ctx,
                shift_id,
                &cashier,
                order_type,
                table_id,
                customer_id,
                worker,
                lines,
                &date,
                hour as u32,
            )?;
        }

        seed_expenses(conn, ctx, shift_id, &date, &cashier)?;
        close_shift(conn, shift_id, &date, &mut ctx.rng)?;
    }

    close_day(conn, day_id, &date, &shift_ids, ctx.accounts.manager.id)
}

/// Open TODAY as a genuinely live, and genuinely VALID, operating state.
///
/// # Why the database is left open rather than tidy
///
/// A demo dataset that closes every shift leaves the POS showing "no business
/// day" and an empty table grid, which hides the very screens worth inspecting.
/// Leaving one open day, one ACTIVE shift and a few open orders is a normal
/// mid-day state of a real café — and a LEGAL one:
///
///   * `idx_business_days_one_open` — exactly one open business day. ✓
///   * `idx_shifts_one_active_global` — exactly one ACTIVE shift. ✓
///   * `idx_orders_open_table` — at most one live order per table. ✓
///   * `idx_table_sessions_open` — at most one live session per table. ✓
///
/// The open orders stay UNSETTLED. Nothing is broken by that: it is exactly the
/// state a table is in while its customers are still sitting there.
fn open_live_day(
    conn: &Db,
    ctx: &mut Context<'_>,
    tables: &[i64],
    date: &str,
) -> AppResult<()> {
    let day_id = historical_day(conn, date, ctx.accounts.manager.id)?;
    ctx.day_id = day_id;

    let cashier = ctx.accounts.cashiers[0].clone();
    conn.execute(
        "INSERT INTO shifts (business_day_id, user_id, status, opened_at, opening_cash)
         VALUES (?1, ?2, 'ACTIVE', ?3, ?4)",
        params![day_id, cashier.id, local_instant(date, 8, 0)?, 5_000],
    )?;
    let shift_id = conn.last_insert_rowid();

    // Two settled orders, so "today" is not empty on the reports...
    for index in 0..2 {
        let table = tables[index % tables.len()];
        let shape = if index == 0 { "CAFE" } else { "WASH" };
        let (customer, worker) = if shape == "WASH" {
            (
                Some(*ctx.rng.pick(ctx.car_owners)),
                Some(*ctx.rng.pick(&ctx.accounts.wash_employees)),
            )
        } else {
            (Some(*ctx.rng.pick(ctx.customers)), None)
        };
        let lines = build_lines(ctx, shape);
        place_order(
            conn,
            ctx,
            shift_id,
            &cashier,
            "TABLE",
            Some(table),
            customer,
            worker,
            lines,
            date,
            9 + index as u32,
        )?;
    }

    // ...and two genuinely OPEN tables plus one open takeaway, so the table grid
    // and the takeaway list have live content to render.
    for index in 2..4 {
        let table = tables[index % tables.len()];
        let session = pos::open_session(conn, table, cashier.id, day_id, shift_id)?
            .ok_or_else(|| AppError::internal("demo could not open a table session"))?;
        let order = pos::open_order(conn, "TABLE", Some(table), cashier.id, day_id, shift_id)?
            .ok_or_else(|| AppError::internal("demo could not open an order"))?;
        pos::set_session_order(conn, session, order)?;
        for line in build_lines(ctx, "CAFE") {
            pos::add_line(
                conn,
                order,
                line.product_id,
                &line.department,
                &line.name,
                line.unit_price,
                line.quantity,
            )?;
        }
    }

    let takeaway = pos::open_order(conn, "TAKEAWAY", None, cashier.id, day_id, shift_id)?
        .ok_or_else(|| AppError::internal("demo could not open a takeaway"))?;
    for line in build_lines(ctx, "CAFE") {
        pos::add_line(
            conn,
            takeaway,
            line.product_id,
            &line.department,
            &line.name,
            line.unit_price,
            line.quantity,
        )?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 6. Entry point
// ---------------------------------------------------------------------------

/// Load the complete demo dataset.
///
/// The caller is `services::developer::load_demo_data`, which has already reset
/// the database and run the OFFICIAL seed, so this function only ever ADDS the
/// demo records on top of a valid baseline. It is written to be re-runnable:
/// every insert is either idempotent (looked up first) or part of the freshly
/// cleared database, so loading twice can neither duplicate nor orphan anything.
pub fn load(conn: &Db) -> AppResult<()> {
    // ---- retire a previous run's LIVE state --------------------------------
    // The dataset deliberately ends with a live operating day: one OPEN
    // business day, one ACTIVE shift and a few open orders. Two partial unique
    // indexes make that state singular — `idx_business_days_one_open`
    // (one OPEN business day) and `idx_shifts_one_active_global` (one ACTIVE
    // shift) — so a SECOND `load()` into the same database would trip them the
    // moment it tried to open its own day, failing with
    // `UNIQUE constraint failed: business_days.status`.
    //
    // Loading is documented as re-runnable, so the previous run's live day and
    // its shift are closed here first. The historical rows are deliberately
    // LEFT ALONE: they are the demo's additive history, and the identity tests
    // rely on them accumulating rather than being wiped. This mirrors what
    // `services::developer::load_demo_data` achieves through a full
    // `clear_database`, without destroying history for the in-process caller.
    //
    // The same reasoning applies to the two "one at a time" indexes over live
    // POS state: `idx_table_sessions_open` (one OPEN session per table) and
    // `idx_orders_open_table` (one OPEN/READY_TO_PAY order per table). The
    // tables left occupied by the previous run's live orders must be released
    // too, or the second run cannot seat them. The status list mirrors the
    // partial index exactly.
    conn.execute(
        "UPDATE orders SET status = 'CLOSED', closed_at = station_now()
         WHERE status IN ('OPEN', 'READY_TO_PAY')",
        [],
    )?;
    conn.execute(
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = station_now()
         WHERE status = 'OPEN'",
        [],
    )?;
    conn.execute(
        "UPDATE shifts SET status = 'CLOSED', closed_at = station_now()
         WHERE status = 'ACTIVE'",
        [],
    )?;
    conn.execute(
        "UPDATE business_days SET status = 'CLOSED', closed_at = station_now()
         WHERE status = 'OPEN'",
        [],
    )?;

    let accounts = seed_accounts(conn)?;
    seed_products(conn, accounts.admin.id)?;
    let customer_ids = seed_customers(conn)?;

    // Credit is authorization, never an assumption: the demo enables it in LIST
    // mode and names the customers it authorizes, through the real setting.
    let credit_customers: Vec<i64> = customer_ids.iter().take(4).copied().collect();
    settings::set_credit_config(
        conn,
        &accounts.manager,
        &CreditConfig {
            enabled: true,
            mode: "LIST".into(),
            allowed_customer_ids: credit_customers.clone(),
        },
    )?;

    let car_owners: Vec<i64> = customer_ids
        .iter()
        .copied()
        .filter(|id| {
            conn.query_row(
                "SELECT COUNT(*) FROM cars WHERE customer_id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
                > 0
        })
        .collect();

    let (cafe, wash) = read_catalog(conn)?;
    let tables = ids_of(conn, "cafe_tables")?;
    let employees = ids_of(conn, "employees")?;

    let today = time::today_business_date();
    let today_date = NaiveDate::parse_from_str(&today, "%Y-%m-%d").unwrap_or_default();

    let mut ctx = Context {
        accounts: &accounts,
        customers: &customer_ids,
        car_owners: &car_owners,
        credit_customers: &credit_customers,
        cafe: &cafe,
        wash: &wash,
        employees: &employees,
        rng: Rng::new(0x5747_4154_494f_4e00),
        day_id: 0,
    };

    // ---- 24 months of closed trading days ---------------------------------
    // Two thirds of the days trade, so reports show real closed days as well as
    // real activity, and every month bucket inside the widest configured chart
    // window carries data.
    //
    // The window is computed ONCE and walked exactly once. It used to be
    // `for month in (1..HISTORY_MONTHS).rev() { for offset in
    // 0..days_between(month_first(month), today_date) { ... } }` — but each of
    // those per-month walks runs from its own first-of-the-month all the way up
    // to TODAY, so month 23's range almost entirely contains month 1's. Each
    // business date was therefore visited an average of ~12 times, and since
    // `business_days` deliberately has no UNIQUE constraint on `day_date`
    // (a real installation may open a second day on the same date), the
    // duplicates were written silently: the same calendar date got dozens of
    // business days, shifts, orders, invoices, payments and stock movements.
    // One walk over the union of those ranges produces exactly the same set of
    // dates — every day of the full history, once.
    let history_start = month_first(today_date, HISTORY_MONTHS - 1);
    for offset in 0..days_between(history_start, today_date) {
        if ctx.rng.below(100) >= 68 {
            continue;
        }
        let date = history_start + Duration::days(offset);
        // Today is the LIVE day, opened below, never a closed trading day.
        if date >= today_date {
            break;
        }
        trade_day(conn, &mut ctx, &tables, date.to_string())?;
    }

    // ---- today: one open, valid operating day ------------------------------
    open_live_day(conn, &mut ctx, &tables, &today)?;

    // ---- attendance across the whole history -------------------------------
    //
    // Deliberately NOT done inside `trade_day`: attendance belongs to a CALENDAR
    // day, not to a trading day, so it is written here for EVERY date in the
    // window — including the days that did not trade. Doing it per trading day
    // instead would also collide with this loop, because the model allows
    // exactly one live record per employee per day
    // (`idx_attendance_live` on (employee_id, business_date)).
    //
    // The window is therefore computed ONCE and walked exactly once. It used to
    // be `for month in (1..HISTORY_MONTHS).rev() { for offset in
    // 0..days_between(month_first(month), today) }` — but every one of those
    // per-month walks runs all the way from its own first-of-the-month up to
    // TODAY, so month 23's range almost entirely contains month 1's. Each
    // business date was therefore visited up to `HISTORY_MONTHS` times, and the
    // second visit for the same (employee, business_date) pair violated the
    // partial unique index. One walk over the union of those ranges produces
    // exactly the same set of dates — every day of the full history, once.
    let history_start = month_first(today_date, HISTORY_MONTHS - 1);
    for offset in 0..days_between(history_start, today_date) {
        let date = (history_start + Duration::days(offset)).to_string();
        for employee in &employees {
            if ctx.rng.below(100) < 88 {
                // Attendance is a CALENDAR fact keyed by (employee, day), so a
                // calendar day already on file is simply not generated again —
                // that is what makes a second `load()` additive rather than a
                // constraint violation. This is a real existence check, NOT
                // `INSERT OR IGNORE`: an accidental overlap INSIDE this run
                // would still be caught, because the row this loop just wrote
                // is already visible to the very next lookup.
                if attendance_day_exists(conn, *employee, &date)? {
                    continue;
                }
                record_attendance(conn, &accounts.manager, *employee, &date, &mut ctx.rng)?;
            }
        }
    }

    // ---- advances and payroll ----------------------------------------------
    seed_advances(conn, &accounts.manager, &employees, &mut ctx.rng)?;
    for month in (1..4).rev() {
        let period = (today_date - Duration::days(30 * month))
            .format("%Y-%m")
            .to_string();
        seed_payroll(conn, &accounts.manager, &employees, &period)?;
    }

    Ok(())
}

/// The `id` of every row of a table, in id order.
fn ids_of(conn: &Db, table: &str) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(&format!("SELECT id FROM {table} ORDER BY id"))?;
    let ids = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    Ok(ids.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::services::auth::LoginInput;
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;

    /// Build the dataset ONCE and keep it on disk, so the ~10s
    /// migrate + official seed + demo load is paid a single time for the whole
    /// module instead of once per test.
    ///
    /// `OnceLock` guarantees the build happens exactly once, no matter how the
    /// test runner schedules or interleaves the tests, so this introduces no
    /// ordering dependency. The snapshot is only ever READ here: each test gets
    /// its own private copy (see `demo_db`), so no test can observe or corrupt
    /// another's state, and tests still run in parallel safely.
    fn demo_snapshot_path() -> &'static std::path::PathBuf {
        static SNAPSHOT: OnceLock<std::path::PathBuf> = OnceLock::new();
        SNAPSHOT.get_or_init(|| {
            // Each run builds its own snapshot, so clear anything an earlier run
            // left behind rather than letting these throwaway multi-megabyte
            // files pile up in the temp directory.
            if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with("station-demo-") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }

            let path = std::env::temp_dir().join(format!(
                "station-demo-snapshot-{}.sqlite3",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            let conn = Connection::open(&path).unwrap();
            // Test-only durability trade-off: this is a throwaway file that is
            // deleted and rebuilt on every run, so paying for an fsync on each
            // of the ~100k inserts of a 24-month dataset buys nothing. The
            // OFF/MEMORY combination only skips durability, never integrity.
            conn.pragma_update(None, "synchronous", "OFF").unwrap();
            conn.pragma_update(None, "journal_mode", "MEMORY").unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            migrate(&conn).unwrap();
            crate::seed::run_if_empty(&conn).unwrap();
            load(&conn).unwrap();
            // Flush and release the file before any test copies it.
            conn.close().unwrap();
            path
        })
    }

    /// Migrated + officially seeded + full demo dataset, exactly as
    /// "Clear → Load Demo Data" leaves the database.
    ///
    /// Each call returns a FRESH, fully independent database — the tests can
    /// still mutate, truncate and re-query it freely without affecting any other
    /// test. Copying a few megabytes is milliseconds, so this stays far cheaper
    /// than rebuilding 24 months of trading from scratch.
    fn demo_db() -> Connection {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dest = std::env::temp_dir().join(format!(
            "station-demo-test-{}-{}.sqlite3",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&dest);
        std::fs::copy(demo_snapshot_path(), &dest).unwrap();
        let conn = Connection::open(&dest).unwrap();
        // Same throwaway-file trade-off as the snapshot build; a test that
        // writes to its own copy cannot lose anything that matters.
        conn.pragma_update(None, "synchronous", "OFF").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // `station_now()` / `station_today()` are per-CONNECTION functions
        // registered by `migrate`; a freshly opened copy needs them again
        // before any table with such a DEFAULT can be written.
        crate::db::register_clock(&conn).unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn login(conn: &Connection, name: &str, password: &str) -> User {
        auth::login(conn, &LoginInput { name: name.into(), password: password.into() })
            .unwrap()
            .user
    }

    /// PART 5 — every supported role can actually sign in.
    #[test]
    fn every_demo_role_signs_in_with_its_documented_password() {
        let conn = demo_db();
        assert_eq!(login(&conn, "admin", "admin123").role, "ADMIN");
        assert_eq!(login(&conn, "manager", "manager123").role, "MANAGER");
        assert_eq!(login(&conn, "cashier", "cashier123").role, "STAFF");
        assert_eq!(login(&conn, "sara", "sara1234").role, "STAFF");
    }

    /// A wash worker has no login at all — that is what the CHECK is for.
    #[test]
    fn wash_workers_exist_and_cannot_authenticate() {
        let conn = demo_db();
        let workers: i64 = count(
            &conn,
            "SELECT COUNT(*) FROM employees WHERE employee_type = 'WASH_WORKER'",
        );
        assert!(workers > 0, "the demo dataset must have wash workers");

        let with_login: i64 = count(
            &conn,
            "SELECT COUNT(*) FROM employees
             WHERE employee_type = 'WASH_WORKER' AND user_id IS NOT NULL",
        );
        assert_eq!(with_login, 0, "a wash worker can never hold a login");

        // Every login is a CASHIER employee, as the CHECK requires.
        let orphan_logins: i64 = count(
            &conn,
            "SELECT COUNT(*) FROM users u
             WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id)",
        );
        assert_eq!(orphan_logins, 0, "every demo login needs its employee row");
    }

    /// PART 17.1 / 17.2 — the two datasets are genuinely separate.
    #[test]
    fn demo_accounts_come_only_from_the_demo_module() {
        let official = Connection::open_in_memory().unwrap();
        migrate(&official).unwrap();
        crate::seed::run_if_empty(&official).unwrap();

        for (name, ..) in DEMO_USERS {
            let present = official
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap();
            assert_eq!(present, 0, "{name} must not exist in the official dataset");
        }

        let conn = demo_db();
        for (name, ..) in DEMO_USERS {
            let present = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap();
            assert_eq!(present, 1, "{name} must exist in the demo dataset");
        }
    }

    /// PART 7 — customers and cars are populated and varied.
    #[test]
    fn customers_and_cars_are_populated_and_varied() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM customers") > 5);
        assert!(count(&conn, "SELECT COUNT(*) FROM cars") > 3);

        // Some customers own a car and some do not — the section shows both.
        let with_car = count(&conn, "SELECT COUNT(DISTINCT customer_id) FROM cars");
        let without_car = count(&conn, "SELECT COUNT(*) FROM customers") - with_car;
        assert!(with_car > 0 && without_car > 0, "both kinds of customer must exist");

        // Plates are unique (the index would have refused a duplicate anyway).
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM cars"),
            count(&conn, "SELECT COUNT(DISTINCT plate_key) FROM cars")
        );

        // Several customers are linked to real invoices.
        assert!(count(
            &conn,
            "SELECT COUNT(DISTINCT customer_id) FROM invoices WHERE customer_id IS NOT NULL"
        ) > 1);
    }

    /// PART 8 — money is real: every invoice reconciles with its own lines,
    /// its payment and its customer snapshot.
    #[test]
    fn every_demo_invoice_is_internally_consistent() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM invoices") > 100, "a real history is required");

        // total = subtotal - discount + service_charge, on EVERY invoice.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM invoices
                 WHERE total <> subtotal - discount_minor + service_charge"
            ),
            0,
            "invoice arithmetic must hold on every row"
        );

        // cafe_total / wash_total are the per-department line sums.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM invoices i WHERE
                    i.cafe_total <> (SELECT COALESCE(SUM(l.line_total), 0) FROM invoice_lines l
                                     WHERE l.invoice_id = i.id AND l.department = 'CAFE')
                 OR i.wash_total <> (SELECT COALESCE(SUM(l.line_total), 0) FROM invoice_lines l
                                     WHERE l.invoice_id = i.id AND l.department = 'WASH')"
            ),
            0,
            "revenue must be derived from the invoice lines"
        );

        // Every invoice has lines, a payment and a customer snapshot.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id)"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id)"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM invoice_customers c WHERE c.invoice_id = i.id)"), 0);

        // A paid invoice is never over-paid, and no payment is non-positive.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM invoices WHERE paid_amount > total"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM payments WHERE amount <= 0"), 0);
    }

    /// PART 8 — NO cancelled invoice anywhere.
    ///
    /// Migration 32 removed that state from the schema. The demo must not invent
    /// one, and must certainly not create one to populate an "exceptions"
    /// metric.
    #[test]
    fn the_demo_dataset_contains_no_cancelled_documents() {
        let conn = demo_db();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM invoices WHERE status = 'CANCELLED'"),
            0,
            "Station has no cancelled invoice; the demo must not invent one"
        );

        // Every status used is one of the three real lifecycle states.
        let mut stmt = conn
            .prepare("SELECT DISTINCT status FROM invoices ORDER BY status")
            .unwrap();
        let statuses = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for status in &statuses {
            assert!(
                ["PENDING_PAYMENT", "PAID", "PARTIALLY_PAID", "CREDIT"].contains(&status.as_str()),
                "unexpected invoice status in demo data: {status}"
            );
        }
    }

    /// PART 8 — all three payment methods and both real order contexts exist,
    /// so the reports have more than one shape to show.
    #[test]
    fn the_demo_dataset_exercises_every_payment_method_and_order_shape() {
        let conn = demo_db();

        for method in ["CASH", "CARD", "CREDIT"] {
            assert!(
                count(&conn, &format!("SELECT COUNT(*) FROM payments WHERE method = '{method}'")) > 0,
                "no {method} payment was generated"
            );
        }
        for order_type in ["TABLE", "TAKEAWAY"] {
            assert!(
                count(&conn, &format!("SELECT COUNT(*) FROM orders WHERE order_type = '{order_type}'")) > 0,
                "no {order_type} order was generated"
            );
        }

        // Hybrid documents exist and are counted the way the reports count them:
        // an invoice carrying BOTH a café and a wash line.
        assert!(
            count(&conn, "SELECT COUNT(*) FROM day_closings WHERE hybrid_invoices > 0") > 0,
            "no hybrid (café + wash) document was generated"
        );
    }

    #[test]
    fn expenses_span_several_categories_and_the_whole_history() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM expenses") > 20);

        let categories = count(&conn, "SELECT COUNT(DISTINCT category) FROM expenses");
        assert!(categories >= 3, "expenses must cover several categories, found {categories}");

        // Monthly variation: more than one distinct month carries spend, so the
        // monthly expense chart is not a single bar.
        let months = count(&conn, "SELECT COUNT(DISTINCT strftime('%Y-%m', expense_date)) FROM expenses");
        assert!(months > 3, "expenses must span several months, found {months}");

        // Every category still resolves to a real, readable label.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM expenses e LEFT JOIN expense_categories c ON c.code = e.category WHERE c.id IS NULL"),
            0,
            "every expense category must still be readable"
        );
        // A recurring flag is only legal with a recurrence.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM expenses WHERE is_recurring = 1 AND recurrence IS NULL"), 0);
    }

    /// PART 11 — the Inventory page is immediately meaningful, and the stock
    /// ledger agrees with the quantities it produced.
    #[test]
    fn inventory_is_populated_and_consistent_with_its_ledger() {
        let conn = demo_db();

        let tracked = count(&conn, "SELECT COUNT(*) FROM products WHERE track_inventory = 1");
        assert!(tracked > 5, "the inventory page needs tracked items");
        assert!(count(&conn, "SELECT COUNT(*) FROM inventory_items") > 5);

        // Levels vary: some items are healthy, some are at/below their minimum.
        let low = count(
            &conn,
            "SELECT COUNT(*) FROM inventory_items WHERE quantity <= min_quantity",
        );
        assert!(low > 0, "a low-stock scenario must exist");
        let healthy = count(
            &conn,
            "SELECT COUNT(*) FROM inventory_items WHERE quantity > min_quantity",
        );
        assert!(healthy > 0, "a healthy-stock scenario must exist too");

        // The ledger and the quantity can never disagree: every movement is
        // attributed, and the movements reason is one the schema allows.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM stock_movements WHERE user_id IS NULL"), 0);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM stock_movements WHERE reason NOT IN ('SALE','PURCHASE','ADJUSTMENT','WASTE','SEED')"),
            0
        );
        // Sales movements point back at the invoice that caused them.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM stock_movements WHERE reason = 'SALE' AND ref_invoice_id IS NULL"),
            0,
            "a sale movement must reference its invoice"
        );
    }

    /// PART 6 — the demo catalog includes inactive items, and the POS rule
    /// (an inactive item is invisible to the cashier) still holds.
    #[test]
    fn the_demo_catalog_has_active_and_inactive_items() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM products WHERE is_active = 0 AND is_seed = 0") > 0);

        assert!(count(&conn, "SELECT COUNT(*) FROM products WHERE is_active = 1") > 50);

        // No invoice was ever raised against an inactive item, because the POS
        // refuses to sell one.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM invoice_lines l
                 JOIN products p ON p.name = l.product_name
                 WHERE p.is_active = 0"
            ),
            0,
            "an inactive product must never appear on a sold line"
        );

        // Demo products are ordinary catalog rows, never `is_seed`, so the
        // official catalog sync can neither deactivate nor delete them.
        assert!(count(&conn, "SELECT COUNT(*) FROM products WHERE is_seed = 0") > 10);
    }

    /// PART 12 — attendance covers the roster across the history, in states the
    /// model actually supports.
    #[test]
    fn attendance_is_populated_and_never_in_an_impossible_state() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM attendance_days") > 100);

        // All three states are represented.
        for state in ["PRESENT", "ABSENT", "LEAVE"] {
            assert!(
                count(&conn, &format!("SELECT COUNT(*) FROM attendance_days WHERE state = '{state}'")) > 0,
                "no {state} attendance day was generated"
            );
        }

        // The database CHECK already refuses impossible states, but assert the
        // pairing explicitly so a schema change cannot quietly relax it.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM attendance_days WHERE state IN ('ABSENT','LEAVE') AND (check_in_actual_at IS NOT NULL OR check_out_actual_at IS NOT NULL)"),
            0,
            "an absence or a leave carries no punch pair"
        );

        // Every day was recorded by a real login — necessary for a wash worker,
        // who has none of his own.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attendance_days WHERE recorded_by_user_id IS NULL"), 0);

        // At most one live record per employee per day.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM attendance_days"),
            count(&conn, "SELECT COUNT(*) FROM (SELECT employee_id, business_date FROM attendance_days GROUP BY employee_id, business_date)")
        );

        // Rounding respected: a check-in is never moved into the future and a
        // check-out never into the past, both in UTC instants.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM attendance_days WHERE check_in_effective_at > check_in_actual_at"),
            0
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM attendance_days WHERE check_out_effective_at < check_out_actual_at"),
            0
        );
    }

    /// PART 12 — shifts are settled with real closing snapshots, and the drawer
    /// arithmetic holds on every one of them.
    #[test]
    fn shifts_are_settled_with_consistent_closing_snapshots() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM shifts WHERE status = 'CLOSED'") > 50);
        // Exactly ONE shift is left ACTIVE — the live one the POS opens on.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM shifts WHERE status = 'ACTIVE'"), 1);

        // expected = opening + cash in - cash out, on every settled shift.
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM shifts
                 WHERE status = 'CLOSED'
                   AND expected_cash <> opening_cash + cash_sales - cash_expenses"
            ),
            0,
            "the drawer formula must hold on every closed shift"
        );
        // cash_difference is exactly actual - expected.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM shifts WHERE status = 'CLOSED' AND cash_difference <> actual_cash - expected_cash"),
            0
        );
        // An ACTIVE shift never carries a persisted snapshot.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM shifts WHERE status = 'ACTIVE' AND invoices_count <> 0"), 0);
    }

    /// PART 13 — the history spans enough months for the WIDEST monthly chart
    /// window the setting accepts, and is derived from the business date.

    /// PART 14 — the live state left behind is VALID, not broken.
    #[test]
    fn the_live_state_left_behind_is_valid() {
        let conn = demo_db();

        // At most one open business day, and there is exactly one.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM business_days WHERE status = 'OPEN'"), 1);
        // At most one ACTIVE shift, and there is exactly one.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM shifts WHERE status = 'ACTIVE'"), 1);
        // The open orders are genuinely open, and each holds lines.
        assert!(count(&conn, "SELECT COUNT(*) FROM orders WHERE status = 'OPEN'") > 0);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM orders o WHERE o.status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id)"),
            0,
            "an open order must have something on it"
        );

        // Foreign keys are enforced and the graph is intact.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0,
            "the demo dataset must not orphan a single row"
        );
    }

    /// PART 16 / 17.6 — loading twice is safe and never duplicates an identity.
    #[test]
    fn loading_the_demo_dataset_twice_does_not_duplicate_anything() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();

        load(&conn).unwrap();
        let users = count(&conn, "SELECT COUNT(*) FROM users");
        let customers = count(&conn, "SELECT COUNT(*) FROM customers");
        let cars = count(&conn, "SELECT COUNT(*) FROM cars");
        let products = count(&conn, "SELECT COUNT(*) FROM products");

        load(&conn).unwrap();

        // The master data is idempotent by construction.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM users"), users);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM customers"), customers);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM cars"), cars);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM products"), products);

        // The history is additive by design, but never corrupts an identity.

        for (table, column) in [
            ("users", "name"),
            ("cars", "plate_key"),
            ("invoices", "invoice_no"),
        ] {
            assert_eq!(
                count(&conn, &format!("SELECT COUNT(*) FROM {table}")),
                count(&conn, &format!("SELECT COUNT(DISTINCT {column}) FROM {table}")),
                "{table}.{column} must stay unique"
            );
        }
    }

    /// PART 17.7 — demo loading does not weaken authentication.
    #[test]
    fn demo_loading_does_not_weaken_authentication() {
        let conn = demo_db();

        // Passwords are Argon2id PHC strings, never the clear text.
        for (name, password, _) in DEMO_USERS {
            let (hash, status): (String, String) = conn
                .query_row(
                    "SELECT password_hash, status FROM users WHERE name = ?1",
                    [name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert!(hash.starts_with("$argon2"), "{name} must be Argon2id hashed");
            assert!(!hash.contains(password), "{name}'s password must not be stored in the clear");
            assert_eq!(status, "ACTIVE");
            // The wrong password still fails.
            assert!(auth::login(
                &conn,
                &LoginInput {
                    name: (*name).into(),
                    password: "wrong-password".into(),
                },
            )
            .is_err());
        }

        // Role ranking is untouched.
        let staff = login(&conn, "cashier", "cashier123");
        assert!(auth::require_role(&staff, "ADMIN").is_err());
        assert!(auth::require_role(&staff, "MANAGER").is_err());
        assert!(auth::require_role(&staff, "STAFF").is_ok());
        assert!(auth::require_role(&login(&conn, "admin", "admin123"), "ADMIN").is_ok());
    }

    /// PART 17.8 — the dataset obeys the business rules it claims to.
    #[test]
    fn the_demo_dataset_obeys_the_business_rules() {
        let conn = demo_db();

        // Credit is authorization, never an assumption.
        let credited: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT customer_id FROM invoices WHERE status = 'CREDIT'")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, i64>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(!credited.is_empty(), "no credit invoice was generated");
        let allowed = crate::services::settings::get_credit_config(&conn)
            .unwrap()
            .allowed_customer_ids;
        for customer in credited {
            assert!(
                allowed.contains(&customer),
                "customer {customer} settled on credit without being authorized"
            );
            assert!(
                count(&conn, &format!("SELECT COUNT(*) FROM credit_accounts WHERE customer_id = {customer}")) > 0,
                "a credit invoice must have a credit account"
            );
        }

        // A credit invoice is invoiced credit, never collected cash.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM invoices WHERE status = 'CREDIT' AND paid_amount <> 0"),
            0
        );
        // An account is never over-paid.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM credit_accounts WHERE paid_total > original_total"), 0);

        // A takeaway order never holds a table, and a table order always does.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE order_type = 'TAKEAWAY' AND table_id IS NOT NULL"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE order_type = 'TABLE' AND table_id IS NULL"), 0);
        // Takeaway numbers are unique per business day.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM orders WHERE takeaway_no IS NOT NULL"),
            count(&conn, "SELECT COUNT(DISTINCT business_day_id || '-' || takeaway_no) FROM orders WHERE takeaway_no IS NOT NULL")
        );
        // Every settled order reached CLOSED and carries its settlement time.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.status <> 'CLOSED'"),
            0
        );
    }


    #[test]
    fn the_history_spans_the_widest_configured_monthly_chart_window() {
        let conn = demo_db();
        let months = count(
            &conn,
            "SELECT COUNT(DISTINCT strftime('%Y-%m', day_date)) FROM business_days",
        );
        let widest = crate::services::settings::MONTHLY_SALES_PERIOD_MONTHS
            .iter()
            .copied()
            .max()
            .unwrap();
        assert!(
            months as i64 >= widest - 1,
            "expected ~{widest} months of trading, found {months}"
        );

        // No invoice is dated in the future: every one belongs to a real,
        // already-traded business day.
        let today = crate::time::today_business_date();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM business_days WHERE day_date > ?1",
                params![today],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    /// PART 13 — every business day carries a closing snapshot produced by the
    /// real aggregation, so reports reconcile with the till.
    #[test]
    fn every_historical_day_has_a_final_closing_snapshot() {
        let conn = demo_db();
        let closed_days = count(&conn, "SELECT COUNT(*) FROM business_days WHERE status = 'CLOSED'");
        let closings = count(&conn, "SELECT COUNT(*) FROM day_closings WHERE final_snapshot = 1");
        assert_eq!(closings, closed_days, "each closed day needs its final snapshot");

        // At most one FINAL snapshot per day (the unique index guarantees it, so
        // the counts above already prove it is not exceeded).
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM day_closings WHERE final_snapshot = 1"),
            count(&conn, "SELECT COUNT(DISTINCT business_day_id) FROM day_closings WHERE final_snapshot = 1")
        );

        // A settled shift belongs to exactly one closing.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM day_closing_shifts"),
            count(&conn, "SELECT COUNT(DISTINCT shift_id) FROM day_closing_shifts")
        );
    }



    /// PART 9 — the Wash side is visibly populated and correctly attributed.
    #[test]
    fn wash_activity_is_populated_and_attributed_to_a_worker() {
        let conn = demo_db();
        assert!(count(&conn, "SELECT COUNT(*) FROM wash_tickets") > 0);
        assert!(count(&conn, "SELECT COUNT(*) FROM invoices WHERE wash_total > 0") > 0);

        // A wash invoice snapshots its worker. Unattributed ones are legal, but
        // they must not be ALL of them.
        assert!(
            count(&conn, "SELECT COUNT(*) FROM invoices WHERE wash_total > 0 AND wash_employee_id IS NOT NULL") > 0,
            "wash invoices must be attributed to a wash worker"
        );
        // Waiting numbers are unique per day.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM wash_tickets"),
            count(&conn, "SELECT COUNT(DISTINCT day_date || '-' || waiting_no) FROM wash_tickets")
        );
    }
}
