//! Deterministic OFFICIAL seed infrastructure.
//!
//! - Runs the full starter seed only on a fresh database.
//! - Catalog v4 is synchronized once for existing installations.
//! - Seed catalog entries are flagged (`is_seed = 1`).
//! - Historical transaction data is never deleted.
//! - Old catalog rows that are referenced by history are deactivated;
//!   unreferenced old seed rows can be removed safely.
//! - Categories are required for every catalog row; existing rows were
//!   backfilled to a seeded system category during migration 14.
//!
//! # THIS FILE IS THE OFFICIAL DATASET — PRODUCTION DATA ONLY
//!
//! There are three classes of row in Station, and only two of them belong here:
//!
//!   A) required baseline / system data — the real staff accounts, the 12 cafe
//!      tables and the business catalog supplied by the business;
//!   B) official business / catalog data — `DEFAULT_PRODUCTS`;
//!   C) demo / test / sample data — **never here**.
//!
//! Class C lives in its own dedicated module, `crate::demo_data`, and is only
//! ever reached through the developer "Load Demo Data" action. Nothing in this
//! file may create a demonstration account, a demonstration customer, a fake
//! invoice, a fake expense or any other sample business record: "Load Official
//! Data" must produce the official baseline and nothing else, so a production
//! installation can never be contaminated by a test fixture.
//!
//! In particular the generic `admin` / `manager` / `cashier` demonstration
//! logins that used to live in `DEFAULT_USERS` are GONE. They are demo
//! credentials (see `crate::demo_data::DEMO_USERS`) and shipping them in the
//! official seed meant every installation started with three guessable,
//! shared-password accounts.

use crate::db::Db;
use crate::error::AppResult;
use crate::repositories::{catalog, employees, users};
use crate::services::auth;

/// Marker written into `app_settings` after the initial seed completes.
const SEED_MARKER: &str = "seed.completed_at";

/// Reconcile the credential of a starter account that exists but was NOT
/// created by this seed.
///
/// # Why this exists
///
/// `users::insert` is `ON CONFLICT(name) DO NOTHING`, so a starter account that
/// already exists is left exactly as it is. That is correct for a row this seed
/// created — an administrator may legitimately have changed that person's PIN
/// through the Employees page, and re-running the seed must never silently
/// revert a real password change.
///
/// It is NOT correct for the row the DEVELOPER RESET creates. That reset
/// preserves one account by re-inserting it directly (with `is_seed = 0`,
/// because it did not come from this seed), and it is documented to recreate it
/// "under the very same credentials" as the official seed. Before this function
/// existed, that contract was silently broken for any database whose reset ran
/// against a build with a different developer PIN: the reset wrote the old
/// credential, the seed then skipped the existing name, and the account was
/// permanently unable to authenticate — the owner locked out of the very tool
/// that exists to restore access, and offered on the login screen as an account
/// guaranteed to fail.
///
/// # The rule
///
/// A starter account whose existing row is NOT seed-owned (`is_seed = 0`) is
/// one this application manufactured, not one a person chose, so its credential
/// is restored to the official one. A seed-owned row (`is_seed = 1`) is left
/// completely alone.
///
/// This is deliberately driven off `DEFAULT_USERS` and the `is_seed` flag. There
/// is no name comparison against any particular account, so it repairs the
/// developer account, the cafe owner's account and any starter account added in
/// future without a special case, and it can never touch an account a human
/// created or renamed.
fn reconcile_starter_credentials(conn: &Db) -> AppResult<()> {
    for (name, _, _, password) in DEFAULT_USERS {
        let existing = users::find_by_name(conn, name)?;
        let Some(record) = existing else { continue };
        if record.is_seed {
            continue;
        }

        // Only rewrite when the stored hash really does not already match, so a
        // healthy database is left byte-for-byte alone and `updated_at` is not
        // churned on every launch.
        if auth::verify_password(password, &record.password_hash) {
            continue;
        }

        let hash = auth::hash_password(password)?;
        users::set_password(conn, record.user.id, &hash)?;
        log::warn!(
            "seed: restored the official credential for the non-seeded starter account {name}"
        );
    }
    Ok(())
}

/// Marker for the current starter catalog version.
const CATALOG_SEED_MARKER: &str = "seed.catalog.v4.completed_at";

/// Real starter accounts of the business.
///
/// Public so the developer-reset test can assert the re-seeded account count
/// against the real list instead of a hardcoded number that silently rots the
/// next time a starter account is added.
///
/// These are the café's OWN people with their own credentials. The
/// demonstration logins (`admin`, `manager`, `cashier`) are NOT here — they
/// live in `crate::demo_data::DEMO_USERS`, because a shared, guessable
/// password must never reach a production installation.
pub const DEFAULT_USERS: &[(&str, Option<&str>, &str, &str)] = &[
    ("amira", None, "MANAGER", "20192"),
    ("momo", None, "STAFF", "11111"),
    ("foly", None, "STAFF", "22222"),
    // The café's own owner account. An ADMIN like any other: it gets its
    // permissions from the SAME `users.role` every other admin has, so it needs
    // no special case anywhere in the authorization code.
    ("Bassam", None, "ADMIN", "55555"),
    // The owner/developer account. It is here, in the OFFICIAL dataset, because
    // it is a real account of this business and not a demonstration fixture —
    // see `DEVELOPER_ACCOUNT` in `services::developer`, which is the very same
    // account, recreated under the very same credentials whenever the database
    // is cleared. Having it in the official seed is what lets one person drive
    // BOTH data modes: "Load Official Data" and "Load Demo Data" are both
    // ADMIN-gated, and this account is an ADMIN in both.
    ("Belly", None, "ADMIN", "2214"),
];

/// Usernames that used to be demonstration accounts in this seed.
///
/// Kept as a named list so the tests that assert the OFFICIAL dataset is free
/// of demo records can state the exclusion explicitly instead of hardcoding
/// strings at each call site.
pub const FORMER_DEMO_USERNAMES: &[&str] = &["admin", "manager", "cashier"];

/// Current Station starter catalog.
///
/// Tuple: (name, item_type, department, price in EGP, category, opening stock).
/// The catalog below is AUTHORITATIVE source data supplied by the business:
/// every entry is inserted exactly as written — names, item types,
/// departments, prices, categories and opening stock are never normalized,
/// translated, merged or deduplicated. Duplicate names are intentional and
/// are preserved, because the source catalog contains them.
// The catalog is DATA, not code: `rustfmt::skip` keeps every entry on the exact
// single line the business supplied it on, instead of reflowing long tuples.
#[rustfmt::skip]
const DEFAULT_PRODUCTS: &[(&str, &str, &str, i64, &str, Option<i64>)] = &[

    // ============================================================
    // HOT DRINKS (مشروبات ساخنة)
    // ============================================================
    ("كابتشينو", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    ("لاتيه", "PRODUCT", "CAFE", 92, "مشروبات ساخنة", None),
    ("هوت شوكليت", "PRODUCT", "CAFE", 74, "مشروبات ساخنة", None),
    ("هوت شوكليت أوريو", "PRODUCT", "CAFE", 79, "مشروبات ساخنة", None),
    ("هوت شوكليت مارشميلو", "PRODUCT", "CAFE", 84, "مشروبات ساخنة", None),
    ("قهوة تركي دبل", "PRODUCT", "CAFE", 50, "مشروبات ساخنة", None),
    ("قهوة تركي سينجل", "PRODUCT", "CAFE", 39, "مشروبات ساخنة", None),
    ("إسبريسو دبل", "PRODUCT", "CAFE", 65, "مشروبات ساخنة", None),
    ("إسبريسو سينجل", "PRODUCT", "CAFE", 56, "مشروبات ساخنة", None),
    ("سحلب كراميل", "PRODUCT", "CAFE", 75, "مشروبات ساخنة", None),
    ("قهوة فرنساوي", "PRODUCT", "CAFE", 54, "مشروبات ساخنة", None),
    ("قهوة بندق", "PRODUCT", "CAFE", 59, "مشروبات ساخنة", None),
    ("نسكافيه لارج", "PRODUCT", "CAFE", 60, "مشروبات ساخنة", None),
    ("سحلب", "PRODUCT", "CAFE", 75, "مشروبات ساخنة", None),
    ("شاي", "PRODUCT", "CAFE", 25, "مشروبات ساخنة", None),
    ("شاي فليفر", "PRODUCT", "CAFE", 28, "مشروبات ساخنة", None),
    ("أعشاب", "PRODUCT", "CAFE", 32, "مشروبات ساخنة", None),
    ("هوت سيدر", "PRODUCT", "CAFE", 75, "مشروبات ساخنة", None),
    ("موكا", "PRODUCT", "CAFE", 79, "مشروبات ساخنة", None),
    ("هوت كراميل", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("شاي اسطف", "PRODUCT", "CAFE", 10, "مشروبات ساخنة", Some(0)),
    ("قهوة اسطف", "PRODUCT", "CAFE", 20, "مشروبات ساخنة", None),
    ("براد شاي", "PRODUCT", "CAFE", 35, "مشروبات ساخنة", None),
    ("شاي بناء المور", "PRODUCT", "CAFE", 10, "مشروبات ساخنة", Some(0)),
    ("قهوة محوج سينجل", "PRODUCT", "CAFE", 40, "مشروبات ساخنة", None),
    ("قهوة محوج دبل", "PRODUCT", "CAFE", 50, "مشروبات ساخنة", None),
    ("قرفة حليب", "PRODUCT", "CAFE", 45, "مشروبات ساخنة", None),
    ("فلات وايت", "PRODUCT", "CAFE", 84, "مشروبات ساخنة", None),
    ("شاي بلس", "PRODUCT", "CAFE", 45, "مشروبات ساخنة", None),
    ("شاي أخضر", "PRODUCT", "CAFE", 25, "مشروبات ساخنة", None),
    ("قرفة جنزبيل", "PRODUCT", "CAFE", 30, "مشروبات ساخنة", None),
    ("إسبريسو 3", "PRODUCT", "CAFE", 60, "مشروبات ساخنة", None),
    ("أمريكان كوفي", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("فرانسيسبو كراميل", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    ("فرانسيسبو موكا", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    ("فرانسيسبو فانيليا", "PRODUCT", "CAFE", 85, "مشروبات ساخنة", None),
    ("فرانسيسبو بستاشيو", "PRODUCT", "CAFE", 99, "مشروبات ساخنة", None),
    ("آيس لاتيه", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    ("آيس كابتشينو", "PRODUCT", "CAFE", 70, "مشروبات ساخنة", None),
    ("ميكاتو سينجل", "PRODUCT", "CAFE", 65, "مشروبات ساخنة", None),
    ("ميكاتو دبل", "PRODUCT", "CAFE", 85, "مشروبات ساخنة", None),
    ("شاي أحمد تي", "PRODUCT", "CAFE", 25, "مشروبات ساخنة", None),
    ("نسكافيه إم", "PRODUCT", "CAFE", 45, "مشروبات ساخنة", None),
    ("آيس موكا", "PRODUCT", "CAFE", 93, "مشروبات ساخنة", None),
    ("كورنو كوفي", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("جلسة", "PRODUCT", "CAFE", 50, "مشروبات ساخنة", None),
    ("بلبلة", "PRODUCT", "CAFE", 65, "مشروبات ساخنة", None),
    ("لبن", "PRODUCT", "CAFE", 30, "مشروبات ساخنة", Some(0)),
    ("هوت أوريو", "PRODUCT", "CAFE", 55, "مشروبات ساخنة", None),
    ("صدلية", "PRODUCT", "CAFE", 35, "مشروبات ساخنة", None),
    ("ليمون دافئ", "PRODUCT", "CAFE", 30, "مشروبات ساخنة", None),
    ("آيس كوفي", "PRODUCT", "CAFE", 80, "مشروبات ساخنة", None),
    ("آيس كراميل ميكاتو", "PRODUCT", "CAFE", 93, "مشروبات ساخنة", None),
    ("نسكافيه بلاك", "PRODUCT", "CAFE", 35, "مشروبات ساخنة", None),
    ("سبانيش لاتيه", "PRODUCT", "CAFE", 99, "مشروبات ساخنة", None),
    ("بندق دبل", "PRODUCT", "CAFE", 65, "مشروبات ساخنة", None),
    ("كراميل ميكاتو", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    ("ميكاتو كريمي مملح", "PRODUCT", "CAFE", 99, "مشروبات ساخنة", None),
    ("كراميل مملح مثلج", "PRODUCT", "CAFE", 123, "مشروبات ساخنة", None),
    ("آيس أمريكانو", "PRODUCT", "CAFE", 87, "مشروبات ساخنة", None),
    ("آيس وايت موكا", "PRODUCT", "CAFE", 96, "مشروبات ساخنة", None),
    ("لاتيه لارج", "PRODUCT", "CAFE", 98, "مشروبات ساخنة", None),

    // ============================================================
    // DESSERT (ديزارت)
    // ============================================================
    ("مولتن كيك", "PRODUCT", "CAFE", 94, "ديزارت", None),
    ("تشيز كيك", "PRODUCT", "CAFE", 89, "ديزارت", None),
    ("براونيز", "PRODUCT", "CAFE", 65, "ديزارت", None),
    ("ريد فيلفت", "PRODUCT", "CAFE", 85, "ديزارت", None),
    ("شوكليت كيك", "PRODUCT", "CAFE", 85, "ديزارت", None),
    ("لوتس كيك", "PRODUCT", "CAFE", 89, "ديزارت", None),
    ("سينابون", "PRODUCT", "CAFE", 120, "ديزارت", None),
    ("ديزرت مع نسكافيه", "PRODUCT", "CAFE", 100, "ديزارت", None),
    ("ديزرت مع كاتر", "PRODUCT", "CAFE", 100, "ديزارت", None),
    ("فشار", "PRODUCT", "CAFE", 30, "ديزارت", None),
    ("وافل شوكليت", "PRODUCT", "CAFE", 80, "ديزارت", None),
    ("وافل وايت شوكليت", "PRODUCT", "CAFE", 85, "ديزارت", None),
    ("وافل نوتيلا", "PRODUCT", "CAFE", 95, "ديزارت", None),
    ("وافل لوتس", "PRODUCT", "CAFE", 95, "ديزارت", None),
    ("وافل كراميل", "PRODUCT", "CAFE", 80, "ديزارت", None),
    ("وافل بستاشيو", "PRODUCT", "CAFE", 100, "ديزارت", None),
    ("وافل ميكس", "PRODUCT", "CAFE", 135, "ديزارت", None),

    // ============================================================
    // FRESH JUICES (عصائر فريشات)
    // ============================================================
    ("جوافة نعناع", "PRODUCT", "CAFE", 87, "عصائر فريشات", None),
    ("بطيخ", "PRODUCT", "CAFE", 85, "عصائر فريشات", None),
    ("جوافة", "PRODUCT", "CAFE", 85, "عصائر فريشات", None),
    ("عصير فراولة", "PRODUCT", "CAFE", 87, "عصائر فريشات", None),
    ("جوافة حليب", "PRODUCT", "CAFE", 89, "عصائر فريشات", None),
    ("موز حليب", "PRODUCT", "CAFE", 75, "عصائر فريشات", None),
    ("بلح حليب", "PRODUCT", "CAFE", 87, "عصائر فريشات", None),
    ("عصير برتقال", "PRODUCT", "CAFE", 85, "عصائر فريشات", None),
    ("ليمون", "PRODUCT", "CAFE", 69, "عصائر فريشات", None),
    ("ليمون نعناع", "PRODUCT", "CAFE", 85, "عصائر فريشات", None),
    ("مانجو", "PRODUCT", "CAFE", 89, "عصائر فريشات", None),
    ("فريش ميكس", "PRODUCT", "CAFE", 110, "عصائر فريشات", None),
    ("مانجا باشون فروت", "PRODUCT", "CAFE", 120, "عصائر فريشات", None),

    // ============================================================
    // SMOOTHIE (اسموزي)
    // ============================================================
    ("اسموزي بطيخ (عرض)", "PRODUCT", "CAFE", 30, "اسموزي", None),
    ("اسموزي جوافة نعناع", "PRODUCT", "CAFE", 65, "اسموزي", None),
    ("اسموزي تفاح أخضر", "PRODUCT", "CAFE", 79, "اسموزي", None),
    ("اسموزي توت", "PRODUCT", "CAFE", 65, "اسموزي", None),
    ("اسموزي خوخ", "PRODUCT", "CAFE", 65, "اسموزي", None),
    ("اسموزي جوافة", "PRODUCT", "CAFE", 60, "اسموزي", None),
    ("اسموزي باشون فروت", "PRODUCT", "CAFE", 99, "اسموزي", None),
    ("اسموزي بطيخ", "PRODUCT", "CAFE", 90, "اسموزي", None),
    ("اسموزي مانجو", "PRODUCT", "CAFE", 90, "اسموزي", None),
    ("اسموزي بطيخ نعناع", "PRODUCT", "CAFE", 70, "اسموزي", None),
    ("اسموزي ليمون نعناع", "PRODUCT", "CAFE", 69, "اسموزي", None),
    ("سبانيش لاتيه (اسموري)", "PRODUCT", "CAFE", 60, "اسموزي", None),
    ("اسموزي ميكس", "PRODUCT", "CAFE", 90, "اسموزي", None),
    ("سموري ليمون نعناع", "PRODUCT", "CAFE", 69, "اسموزي", None),
    ("سموري فراولة", "PRODUCT", "CAFE", 87, "اسموزي", None),
    ("اسموزي بلوبيري", "PRODUCT", "CAFE", 88, "اسموزي", None),
    ("اسموزي موز باللبن", "PRODUCT", "CAFE", 90, "اسموزي", None),

    // ============================================================
    // ICE CREAM (آيس كريم)
    // ============================================================
    ("ميكس شوكليت", "PRODUCT", "CAFE", 65, "آيس كريم", None),
    ("آيس كريم كلاسيك", "PRODUCT", "CAFE", 50, "آيس كريم", None),
    ("آيس كريم فروت سلاط", "PRODUCT", "CAFE", 70, "آيس كريم", None),
    ("آيس كريم أوريو مدبنس", "PRODUCT", "CAFE", 70, "آيس كريم", None),
    ("آيس كريم ميكس مدبنس", "PRODUCT", "CAFE", 70, "آيس كريم", None),
    ("آيس كريم شوكولاتة (1 بولة) (عرض)", "PRODUCT", "CAFE", 15, "آيس كريم", Some(0)),
    ("آيس كريم فراولة (2 بولة) (عرض)", "PRODUCT", "CAFE", 25, "آيس كريم", Some(0)),
    ("آيس كريم فانيليا (2 بولة) (عرض)", "PRODUCT", "CAFE", 25, "آيس كريم", Some(0)),
    ("آيس كريم فانيليا (1 بولة) (عرض)", "PRODUCT", "CAFE", 15, "آيس كريم", Some(0)),
    ("آيس كريم شوكولاتة (2 بولة) (عرض)", "PRODUCT", "CAFE", 15, "آيس كريم", Some(0)),
    ("آيس كريم بسكوت مكرمل بالقرفة (2 بولة) (عرض)", "PRODUCT", "CAFE", 25, "آيس كريم", Some(0)),
    ("آيس كريم مانجا (2 بولة) (عرض)", "PRODUCT", "CAFE", 25, "آيس كريم", Some(0)),
    ("آيس كريم مانجا (1 بولة) (عرض)", "PRODUCT", "CAFE", 15, "آيس كريم", Some(0)),
    ("آيس كريم بسكوت مكرمل بالقرفة بولة (عرض)", "PRODUCT", "CAFE", 20, "آيس كريم", Some(0)),
    ("آيس كريم شوكولاتة (2 بولة) (عرض)", "PRODUCT", "CAFE", 13, "آيس كريم", Some(0)),
    ("آيس كريم (عرض) 3 بولة", "PRODUCT", "CAFE", 35, "آيس كريم", Some(0)),
    ("بولة 2", "PRODUCT", "CAFE", 30, "آيس كريم", None),
    ("إكسترا بستاشيو", "PRODUCT", "CAFE", 30, "آيس كريم", None),
    ("آيس كريمر كلاسيك", "PRODUCT", "CAFE", 80, "آيس كريم", None),

    // ============================================================
    // MILK SHAKE (ميلك شيك)
    // ============================================================
    ("بلوبيري", "PRODUCT", "CAFE", 88, "ميلك شيك", None),
    ("مانجا باشون", "PRODUCT", "CAFE", 120, "ميلك شيك", None),
    ("ميلك شيك فانيليا", "PRODUCT", "CAFE", 87, "ميلك شيك", None),
    ("ميلك شيك موكا", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("ميلك شيك أوريو", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("ميلك شيك فراولة", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك مانجا", "PRODUCT", "CAFE", 90, "ميلك شيك", None),
    ("ميلك شيك بلوبيري", "PRODUCT", "CAFE", 99, "ميلك شيك", None),
    ("ميلك شيك هوهور", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك نسكافيه", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك لوتس", "PRODUCT", "CAFE", 87, "ميلك شيك", None),
    ("ميلك شيك بستاشيو", "PRODUCT", "CAFE", 99, "ميلك شيك", None),

    // ============================================================
    // FRIDGE (ثلاجة)
    // ============================================================
    ("مياه", "PRODUCT", "CAFE", 10, "ثلاجة", Some(0)),
    ("بريل", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("ريد بول", "PRODUCT", "CAFE", 90, "ثلاجة", Some(0)),
    ("كاتر مناسبات", "PRODUCT", "CAFE", 25, "ثلاجة", Some(0)),
    ("ميرندا تفاح", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("نوبست", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("فروتر", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("فيروز", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("فاينا", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("في سفن", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("فاينا برتقال", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("سفن أب", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),

    // ============================================================
    // WASH MARKET (ماركت مغسلة)
    // ============================================================
    ("لحاف فيبر", "PRODUCT", "WASH", 50, "ماركت مغسلة", None),
    ("تلميع باب", "PRODUCT", "WASH", 200, "ماركت مغسلة", None),
    ("عرض 400", "PRODUCT", "WASH", 400, "ماركت مغسلة", None),
    ("كسوة طارة جلد", "PRODUCT", "WASH", 300, "ماركت مغسلة", None),
    ("ثلاثة إم طفاية", "PRODUCT", "WASH", 200, "ماركت مغسلة", None),
    ("وصلة صوت", "PRODUCT", "WASH", 220, "ماركت مغسلة", None),
    ("طفاية كربون", "PRODUCT", "WASH", 220, "ماركت مغسلة", None),
    ("وصلة أول إس", "PRODUCT", "WASH", 150, "ماركت مغسلة", None),
    ("رأس شاحن دبليو 105", "PRODUCT", "WASH", 450, "ماركت مغسلة", None),
    ("رأس شاحن دبليو 30", "PRODUCT", "WASH", 350, "ماركت مغسلة", None),
    ("وصلة لينو صوت", "PRODUCT", "WASH", 150, "ماركت مغسلة", None),
    ("رأس شاحن 45", "PRODUCT", "WASH", 450, "ماركت مغسلة", None),
    ("كابل بطارية", "PRODUCT", "WASH", 450, "ماركت مغسلة", None),
    ("ريشة نظافة", "PRODUCT", "WASH", 250, "ماركت مغسلة", None),
    ("لمع تابلوه كبير", "PRODUCT", "WASH", 125, "ماركت مغسلة", None),
    ("لمع تابلوه صغير", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("معطر إيري بخاخ", "PRODUCT", "WASH", 150, "ماركت مغسلة", None),
    ("معطر علبة باكت", "PRODUCT", "WASH", 275, "ماركت مغسلة", None),
    ("إيريون فواحات جديدة", "PRODUCT", "WASH", 75, "ماركت مغسلة", None),
    ("مبدلنا جلد جديدة", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("بارك بيج كود", "PRODUCT", "WASH", 120, "ماركت مغسلة", None),
    ("حامل موبايل", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("حامل موبايل بيتشحن", "PRODUCT", "WASH", 180, "ماركت مغسلة", None),
    ("بادة", "PRODUCT", "WASH", 150, "ماركت مغسلة", None),
    ("فجوة باب", "PRODUCT", "WASH", 150, "ماركت مغسلة", None),
    ("كسوة طارة في علبة", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("كسوة عربية 2 كرسي", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("فوطة", "PRODUCT", "WASH", 45, "ماركت مغسلة", None),
    ("كار كبر صالون قماش", "PRODUCT", "WASH", 750, "ماركت مغسلة", None),
    ("دواسات أكياس", "PRODUCT", "WASH", 20, "ماركت مغسلة", None),
    ("كود العربات", "PRODUCT", "WASH", 250, "ماركت مغسلة", None),
    ("طقم صالون شفاف", "PRODUCT", "WASH", 50, "ماركت مغسلة", None),
    ("طقم صالون قماش", "PRODUCT", "WASH", 100, "ماركت مغسلة", None),
    ("كابل صوت إم", "PRODUCT", "WASH", 220, "ماركت مغسلة", None),
    ("صالون كار كبر جلد", "PRODUCT", "WASH", 600, "ماركت مغسلة", None),

    // ============================================================
    // CAR WASH SERVICES (غسيل السيارات)
    // ============================================================
    ("غسيل داخلي خارجي سيدان", "SERVICE", "WASH", 85, "غسيل السيارات", None),
    ("تلميع مرحلة واحدة", "SERVICE", "WASH", 1200, "غسيل السيارات", None),
    ("تلميع مرحلتين", "SERVICE", "WASH", 1800, "غسيل السيارات", None),
    ("تلميع 3 مراحل", "SERVICE", "WASH", 2000, "غسيل السيارات", None),
    ("كار كبر داخلي كامل", "SERVICE", "WASH", 1000, "غسيل السيارات", None),
    ("كار كبر كامل مانور + شنطة + 4 حيوط", "SERVICE", "WASH", 1500, "غسيل السيارات", None),
    ("حبط كار كبر", "SERVICE", "WASH", 80, "غسيل السيارات", None),
    ("كرسي كار كبر", "SERVICE", "WASH", 150, "غسيل السيارات", None),
    ("سقف كار كبر", "SERVICE", "WASH", 350, "غسيل السيارات", None),
    ("باب كار كبر", "SERVICE", "WASH", 60, "غسيل السيارات", None),
    ("شنطة كار كبر", "SERVICE", "WASH", 100, "غسيل السيارات", None),
    ("أرضية كار كبر", "SERVICE", "WASH", 100, "غسيل السيارات", None),
    ("مانور كيماوي", "SERVICE", "WASH", 100, "غسيل السيارات", None),
    ("فواحة كبيرة", "SERVICE", "WASH", 45, "غسيل السيارات", None),
    ("مليكة معطر خو", "SERVICE", "WASH", 90, "غسيل السيارات", None),
    ("غسيل كامل نصف نقل", "SERVICE", "WASH", 200, "غسيل السيارات", None),
    ("غسيل غطاء السيارة", "SERVICE", "WASH", 50, "غسيل السيارات", None),
    ("دواسة 2", "SERVICE", "WASH", 10, "غسيل السيارات", None),
    ("غسيل سكوتر", "SERVICE", "WASH", 50, "غسيل السيارات", None),
    ("غسيل كامل (شركة)", "SERVICE", "WASH", 100, "غسيل السيارات", None),
    ("كسوة كاملة كار كبر", "SERVICE", "WASH", 300, "غسيل السيارات", None),
    ("غسيل موتوسيكل", "SERVICE", "WASH", 50, "غسيل السيارات", None),
    ("غسيل كامل (S.U.V)", "SERVICE", "WASH", 200, "غسيل السيارات", None),
    ("متر سجاد", "SERVICE", "WASH", 20, "غسيل السيارات", None),
    ("غسيل كامل (V.I.P)", "SERVICE", "WASH", 250, "غسيل السيارات", None),
    ("نانو تابلوه", "SERVICE", "WASH", 200, "غسيل السيارات", None),
    ("فواحة رحاج", "SERVICE", "WASH", 60, "غسيل السيارات", None),
    ("غسلة مجانية", "SERVICE", "WASH", 0, "غسيل السيارات", None),
    ("ميدلنا معدن", "SERVICE", "WASH", 90, "غسيل السيارات", None),
    ("سكانة", "SERVICE", "WASH", 100, "غسيل السيارات", None),
    ("واكس خارجي", "SERVICE", "WASH", 150, "غسيل السيارات", None),
    ("عرض غسيل خارجي في", "SERVICE", "WASH", 95, "غسيل السيارات", None),
    ("غسيل كامل سيدان", "SERVICE", "WASH", 175, "غسيل السيارات", None),
    ("فواحة ك 45", "SERVICE", "WASH", 45, "غسيل السيارات", None),
    ("كوفر طارة", "SERVICE", "WASH", 20, "غسيل السيارات", None),
    ("بطانية أطفال", "SERVICE", "WASH", 75, "غسيل السيارات", None),
    ("تنظيف شنطة عادي", "SERVICE", "WASH", 50, "غسيل السيارات", None),
    ("بطانية", "SERVICE", "WASH", 90, "غسيل السيارات", None),
];

pub fn run_if_empty(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [SEED_MARKER],
        |r| r.get(0),
    )?;

    // Fresh database: create users, catalog and tables.
    if done == 0 {
        conn.execute_batch("BEGIN IMMEDIATE;")?;

        let result = seed_content(conn).and_then(|_| {
            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, station_now())
                 ON CONFLICT(key) DO NOTHING",
                [SEED_MARKER],
            )?;

            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, station_now())
                 ON CONFLICT(key) DO NOTHING",
                [CATALOG_SEED_MARKER],
            )?;

            Ok(())
        });

        match result {
            Ok(_) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }

        log::info!("seed: fresh database initialized");
        return Ok(());
    }

    // Existing installation: synchronize the current catalog once.
    sync_catalog_if_needed(conn)?;

    // A starter account this application manufactured itself (rather than
    // seeded) must still hold its official credential. This is what unblocks an
    // installation whose developer reset ran against an earlier build: the
    // account is offered on the login screen, and without this it could never
    // sign in. Idempotent, and it never touches a seed-owned row or any
    // credential a person changed.
    reconcile_starter_credentials(conn)?;

    Ok(())
}

fn seed_content(conn: &Db) -> AppResult<()> {
    for (name, phone, role, password) in DEFAULT_USERS {
        let hash = auth::hash_password(password)?;

        let user_id = users::insert(
            conn,
            &users::NewUser {
                name,
                phone: *phone,
                role,
                password_hash: &hash,
                is_seed: true,
            },
        )?;
        // Every seeded login is a CASHIER employee. Migration 28 backfilled the
        // employees of an existing installation, but a FRESH database runs the
        // migration against an empty `users` table, so the starter seed creates
        // the link itself. A cashier is never seeded without it: the database
        // CHECK refuses a CASHIER with no login, so this is not optional.
        if let Some(user_id) = user_id {
            let created = employees::insert(
                conn,
                &employees::NewEmployee {
                    name,
                    phone: *phone,
                    employee_type: "CASHIER",
                    base_salary: 0,
                    notes: None,
                    user_id: Some(user_id),
                },
            )?;
            log::debug!("seed: employee {created} linked to user {user_id}");
        }
    }

    insert_default_products(conn)?;

    for n in 1..=12 {
        conn.execute(
            "INSERT INTO cafe_tables (label)
             VALUES (?1)
             ON CONFLICT(label) DO NOTHING",
            rusqlite::params![format!("طاولة {n:02}")],
        )?;
    }

    log::info!(
        "seed: users, {} catalog entries and tables created",
        DEFAULT_PRODUCTS.len()
    );

    Ok(())
}

/// Synchronize the current starter catalog on an existing installation.
///
/// Important:
/// - Historical rows are never deleted.
/// - Products referenced by order_lines, inventory_items or stock_movements
///   are retained and simply deactivated.
/// - Unreferenced old seed products are deleted.
/// - The current catalog is inserted as fresh seed rows.
fn sync_catalog_if_needed(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [CATALOG_SEED_MARKER],
        |r| r.get(0),
    )?;

    if done > 0 {
        return Ok(());
    }

    conn.execute_batch("BEGIN IMMEDIATE;")?;

    let result = sync_catalog(conn);

    match result {
        Ok(_) => {
            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, station_now())
                 ON CONFLICT(key) DO NOTHING",
                [CATALOG_SEED_MARKER],
            )?;

            conn.execute_batch("COMMIT;")?;

            log::info!("seed: catalog synchronized to v4");
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

fn sync_catalog(conn: &Db) -> AppResult<()> {
    // Existing seed products become inactive first.
    //
    // This guarantees that even if an old row is referenced by historical
    // transactions, it can no longer appear in the active catalog.
    conn.execute(
        "UPDATE products
         SET is_active = 0,
             updated_at = station_now()
         WHERE is_seed = 1",
        [],
    )?;

    // Delete old seed products only when absolutely nothing references them.
    //
    // Historical order_lines are snapshots, but their product_id FK still
    // references products, so referenced products must remain in the DB.
    conn.execute(
        "DELETE FROM products
         WHERE is_seed = 1
           AND NOT EXISTS (
               SELECT 1
               FROM order_lines
               WHERE order_lines.product_id = products.id
           )
           AND NOT EXISTS (
               SELECT 1
               FROM inventory_items
               WHERE inventory_items.product_id = products.id
           )
           AND NOT EXISTS (
               SELECT 1
               FROM stock_movements
               WHERE stock_movements.product_id = products.id
           )",
        [],
    )?;

    insert_default_products(conn)?;

    Ok(())
}

fn insert_default_products(conn: &Db) -> AppResult<()> {
    for (name, item_type, department, price_egp, category_name, stock_quantity) in DEFAULT_PRODUCTS
    {
        let price_minor = price_egp.checked_mul(100).ok_or_else(|| {
            crate::error::AppError::internal(format!(
                "price overflow while seeding product: {name}"
            ))
        })?;

        let category_id = catalog::ensure_category(conn, category_name)?;
        let track_inventory = stock_quantity.is_some();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor,
                 is_active, track_inventory, is_seed)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 1)",
            rusqlite::params![
                name,
                item_type,
                department,
                category_id,
                price_minor,
                track_inventory as i64
            ],
        )?;

        if let Some(quantity) = stock_quantity {
            let product_id = conn.last_insert_rowid();

            conn.execute(
                "INSERT INTO inventory_items (product_id, quantity)
                 VALUES (?1, ?2)",
                rusqlite::params![product_id, quantity],
            )?;

            if *quantity != 0 {
                // The opening movement is attributed to a real user, because
                // `stock_movements.user_id` is NOT NULL. An ADMIN is preferred,
                // but the official dataset no longer ships one: it holds the
                // café's own accounts, and a fresh installation therefore has
                // no ADMIN at all until a developer reset creates `Belly` or a
                // manager is promoted. Falling back to the lowest-id account —
                // and skipping the movement entirely on a database with no user
                // yet — keeps the catalog seedable in every one of those states
                // instead of aborting the whole seed on a NOT NULL constraint.
                let actor: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM users ORDER BY (role <> 'ADMIN'), id LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .ok();

                if let Some(user_id) = actor {
                    conn.execute(
                        "INSERT INTO stock_movements
                            (product_id, change, reason, note, ref_invoice_id, user_id)
                         VALUES (?1, ?2, 'ADJUSTMENT', 'initial_stock', NULL, ?3)",
                        rusqlite::params![product_id, quantity, user_id],
                    )?;
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::services::auth::login;
    use rusqlite::Connection;

    #[test]
    fn seed_runs_once_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        run_if_empty(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                [SEED_MARKER],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(marker_count, 1);

        let catalog_marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                [CATALOG_SEED_MARKER],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(catalog_marker_count, 1);

        let product_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(product_count, DEFAULT_PRODUCTS.len() as i64);
    }

    /// The starter catalog is authoritative source data, so this compares the
    /// DATABASE row-for-row against the tuple list instead of asserting a
    /// handful of names: a wrong price, a swapped department, a renamed
    /// category or a lost duplicate would all fail here.
    #[test]
    fn the_seeded_database_matches_the_authoritative_catalog_row_for_row() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT p.name, p.item_type, p.department, p.price_minor, c.name,
                        p.track_inventory, COALESCE(i.quantity, 0)
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 LEFT JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.is_seed = 1
                 ORDER BY p.id",
            )
            .unwrap();
        let rows: Vec<(String, String, String, i64, String, i64, i64)> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let expected: Vec<(String, String, String, i64, String, i64, i64)> = DEFAULT_PRODUCTS
            .iter()
            .map(|(name, item_type, department, price, category, stock)| {
                (
                    name.to_string(),
                    item_type.to_string(),
                    department.to_string(),
                    price * 100,
                    category.to_string(),
                    i64::from(stock.is_some()),
                    stock.unwrap_or(0),
                )
            })
            .collect();

        assert_eq!(rows.len(), expected.len(), "seeded row count");
        for (actual, wanted) in rows.iter().zip(expected.iter()) {
            assert_eq!(actual, wanted, "catalog entry mismatch");
        }
    }

    /// Duplicates in the supplied catalog are intentional and must survive the
    /// seed verbatim: the current catalog contains names that appear more than
    /// once with different types, departments or prices, and the seed keeps
    /// every one of those rows instead of collapsing them.
    #[test]
    fn intentional_duplicate_names_are_preserved_not_deduplicated() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        // Every name the catalog lists more than once is checked generically,
        // so the assertion follows the data instead of hardcoding entries.
        let mut duplicated: Vec<&str> = DEFAULT_PRODUCTS.iter().map(|row| row.0).collect();
        duplicated.sort_unstable();
        let duplicated: Vec<&str> = duplicated
            .windows(2)
            .filter(|pair| pair[0] == pair[1])
            .map(|pair| pair[0])
            .collect();

        assert!(
            !duplicated.is_empty(),
            "the catalog is expected to contain a duplicated name"
        );

        for name in duplicated {
            let seeded = DEFAULT_PRODUCTS.iter().filter(|row| row.0 == name).count() as i64;
            assert!(seeded > 1, "{name} is expected to appear more than once");
            let stored: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM products WHERE name = ?1 AND is_seed = 1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, seeded, "{name} must keep every source row");
        }
    }

    /// Item types, departments and categories are seeded exactly as supplied:
    /// no product leaks into WASH, no service into CAFE, and every category the
    /// catalog names resolves to a real category row.
    #[test]
    fn catalog_types_departments_and_categories_are_seeded_exactly() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        for (item_type, department) in [("PRODUCT", "CAFE"), ("SERVICE", "WASH")] {
            let stored: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM products
                     WHERE is_seed = 1 AND item_type = ?1 AND department = ?2",
                    [item_type, department],
                    |r| r.get(0),
                )
                .unwrap();
            let wanted = DEFAULT_PRODUCTS
                .iter()
                .filter(|row| row.1 == item_type && row.2 == department)
                .count() as i64;
            assert_eq!(stored, wanted, "{item_type}/{department} count");
        }

        let missing_category: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products p
                 LEFT JOIN categories c ON c.id = p.category_id
                 WHERE p.is_seed = 1 AND c.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(missing_category, 0);
    }

    /// `Some(0)` is an EXPLICIT opening stock of zero and stays distinct from
    /// `None`, which means the item is not stock-managed at all.
    #[test]
    fn explicit_zero_opening_stock_is_distinct_from_no_opening_stock() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let tracked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products WHERE is_seed = 1 AND track_inventory = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            tracked,
            DEFAULT_PRODUCTS
                .iter()
                .filter(|row| row.5.is_some())
                .count() as i64
        );

        // Explicit zero: tracked AND backed by a stored quantity row.
        let zero_stock: (i64, i64) = conn
            .query_row(
                "SELECT p.track_inventory, i.quantity
                 FROM products p
                 JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.name = 'شاي اسطف' AND p.is_seed = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(zero_stock, (1, 0));

        // No opening stock: untracked, with no quantity row at all.
        let untracked_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products p
                 JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.name = 'كابتشينو' AND p.is_seed = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untracked_rows, 0);
    }

    #[test]
    fn fresh_seed_contains_expected_catalog() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(count, DEFAULT_PRODUCTS.len() as i64);

        let cappuccino: (String, String, i64, i64) = conn
            .query_row(
                "SELECT item_type, department, price_minor, is_active
                 FROM products
                 WHERE name = 'كابتشينو'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();

        assert_eq!(
            cappuccino,
            ("PRODUCT".to_string(), "CAFE".to_string(), 8900, 1)
        );

        let wash: (String, String, i64) = conn
            .query_row(
                "SELECT item_type, department, price_minor
                 FROM products
                 WHERE name = 'كار كبر داخلي كامل'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        assert_eq!(wash, ("SERVICE".to_string(), "WASH".to_string(), 100000));
    }

    #[test]
    fn official_seed_maps_comments_to_categories_and_optional_inventory() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let hot_drink_category: i64 = conn
            .query_row(
                "SELECT category_id
                 FROM products
                 WHERE name = 'هوت شوكليت'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let hot_drink_name: String = conn
            .query_row(
                "SELECT c.name
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'هوت شوكليت'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(hot_drink_name, "مشروبات ساخنة");

        let water: (i64, String, i64) = conn
            .query_row(
                "SELECT p.id, c.name, i.quantity
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.name = 'مياه'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        // The opening stock is whatever the catalog lists for this name.
        let expected_quantity: i64 = DEFAULT_PRODUCTS
            .iter()
            .find(|row| row.0 == "مياه")
            .and_then(|row| row.5)
            .expect("مياه carries an opening stock in the catalog");
        assert_eq!(water, (water.0, "ثلاجة".to_string(), expected_quantity));

        let stock_visible: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM inventory_items i
                 JOIN products p ON p.id = i.product_id
                 WHERE p.track_inventory = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            stock_visible,
            DEFAULT_PRODUCTS
                .iter()
                .filter(|row| row.5.is_some())
                .count() as i64
        );

        let service_stock: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products
                 WHERE item_type = 'SERVICE'
                   AND track_inventory = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(service_stock, 0);

        let category_name: String = conn
            .query_row(
                "SELECT c.name
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'كار كبر داخلي كامل'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let expected_category: &str = DEFAULT_PRODUCTS
            .iter()
            .find(|row| row.0 == "كار كبر داخلي كامل")
            .map(|row| row.4)
            .expect("كار كبر داخلي كامل is part of the catalog");
        assert_eq!(category_name, expected_category);
        assert!(hot_drink_category > 0);
    }

    #[test]
    fn official_seed_categories_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();

        let products: i64 = conn
            .query_row("SELECT COUNT(*) FROM products", [], |row| row.get(0))
            .unwrap();

        run_if_empty(&conn).unwrap();

        let categories_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();

        let products_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM products", [], |row| row.get(0))
            .unwrap();

        assert_eq!(categories_after, categories);
        assert_eq!(products_after, products);
    }

    #[test]
    fn catalog_v4_replaces_old_unreferenced_seed_data() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        // Simulate an existing installation with the old seed marker.
        conn.execute(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, station_now())",
            [SEED_MARKER],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (
                'قهوة قديمة',
                'PRODUCT',
                'CAFE',
                (SELECT id FROM categories WHERE is_system = 1),
                3000,
                1,
                1
             )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (
                'مغسلة قديمة',
                'SERVICE',
                'WASH',
                (SELECT id FROM categories WHERE is_system = 1),
                5000,
                1,
                1
             )",
            [],
        )
        .unwrap();

        // The catalog carries opening stock, so the sync writes stock
        // movements; those need an ADMIN user to attribute the movement to.
        conn.execute(
            "INSERT INTO users (name, role, password_hash)
             VALUES ('seed-admin', 'ADMIN', 'x')",
            [],
        )
        .unwrap();

        run_if_empty(&conn).unwrap();

        let old_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products
                 WHERE name IN ('قهوة قديمة', 'مغسلة قديمة')",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(old_count, 0);

        let new_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(new_count, DEFAULT_PRODUCTS.len() as i64);
    }

    #[test]
    fn referenced_old_seed_product_is_preserved_but_deactivated() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        conn.execute(
            "INSERT INTO users (name, role, password_hash)
             VALUES ('legacy-user', 'STAFF', 'x')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO cafe_tables (label)
             VALUES ('Legacy Table')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (
                'Legacy Coffee',
                'PRODUCT',
                'CAFE',
                (SELECT id FROM categories WHERE is_system = 1),
                3000,
                1,
                1
             )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders
                (order_type, table_id, user_id, status)
             VALUES ('TABLE', 1, 1, 'CLOSED')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO order_lines
                (order_id, product_id, department, product_name,
                 unit_price, quantity, line_total)
             VALUES (1, 1, 'CAFE', 'Legacy Coffee', 3000, 1, 3000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, station_now())",
            [SEED_MARKER],
        )
        .unwrap();

        // The catalog carries opening stock, so the sync writes stock
        // movements; those need an ADMIN user to attribute the movement to.
        conn.execute(
            "INSERT INTO users (name, role, password_hash)
             VALUES ('seed-admin', 'ADMIN', 'x')",
            [],
        )
        .unwrap();

        run_if_empty(&conn).unwrap();

        let legacy: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(is_active), 0)
                 FROM products
                 WHERE name = 'Legacy Coffee'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        assert_eq!(legacy, (1, 0));

        let order_line_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM order_lines
                 WHERE product_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(order_line_count, 1);
    }

    // -----------------------------------------------------------------------
    // THE OFFICIAL DATASET IS PRODUCTION-SAFE — NO DEMO / SAMPLE RECORDS
    // -----------------------------------------------------------------------

    /// Every class of row that must be EMPTY after the official seed.
    ///
    /// The official dataset is baseline + catalog only. If any of these is
    /// non-zero, "Load Official Data" has leaked sample business data into a
    /// production installation, which is exactly the regression this file's
    /// header exists to prevent.
    const BUSINESS_DATA_TABLES: &[&str] = &[
        "customers",
        "cars",
        "orders",
        "order_lines",
        "invoices",
        "invoice_lines",
        "invoice_customers",
        "payments",
        "credit_accounts",
        "credit_payments",
        "wash_tickets",
        "shifts",
        "business_days",
        "expenses",
        "stock_movements",
        "table_sessions",
        "day_closings",
        "attendance_days",
        "employee_advances",
        "payroll_runs",
    ];

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn exists(conn: &Connection, sql: &str, arg: &str) -> bool {
        conn.query_row(sql, [arg], |r| r.get::<_, i64>(0)).unwrap() == 1
    }

    /// The official seed creates no demo account, and specifically none of the
    /// three that used to live in `DEFAULT_USERS`.
    #[test]
    fn the_official_seed_creates_no_demo_accounts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        for name in FORMER_DEMO_USERNAMES {
            assert!(
                !exists(&conn, "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)", name),
                "{name} is a DEMO account and must never be created by the official seed"
            );
        }
        // And the real business accounts ARE created.
        for (name, ..) in DEFAULT_USERS {
            assert!(
                exists(&conn, "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)", name),
                "{name} is a real starter account and must be seeded"
            );
        }
    }

    /// The official seed creates no sample BUSINESS record either.
    ///
    /// This is the whole point of the separation: an installation that only ever
    /// ran "Load Official Data" must hold the baseline and the catalog, and
    /// nothing that looks like trading history.
    #[test]
    fn the_official_seed_creates_no_sample_business_records() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        for table in BUSINESS_DATA_TABLES {
            assert_eq!(count(&conn, table), 0, "{table} must be empty after the official seed");
        }
        // The baseline that legitimately DOES exist.
        assert!(count(&conn, "products") > 0, "the official catalog is official data");
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert_eq!(count(&conn, "users"), DEFAULT_USERS.len() as i64);
    }

    /// The two owner ADMIN accounts the business asked for, verified through the
    /// REAL login path rather than by reading the row.
    ///
    /// Going through `auth::login` is the point: it proves the seeded Argon2
    /// hash really matches the documented PIN and that the resulting session
    /// really carries the ADMIN role, which is what authorizes the developer
    /// data actions. A row-level assertion would pass even if the password had
    /// been hashed from something else.
    #[test]
    fn the_owner_admin_accounts_sign_in_with_their_documented_pins() {
        use crate::services::auth::{self, LoginInput};

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        for (name, password) in [("Bassam", "55555"), ("Belly", "2214")] {
            let session = auth::login(
                &conn,
                &LoginInput {
                    name: name.into(),
                    password: password.into(),
                },
            )
            .unwrap_or_else(|e| panic!("{name} must be able to sign in: {e}"));

            assert_eq!(session.user.name, name);
            assert_eq!(
                session.user.role, "ADMIN",
                "{name} must hold the full ADMIN role"
            );
        }
    }

    /// A seeded credential must satisfy the ONE credential policy, on every row.
    ///
    /// Driven off the table rather than a list of literals, so adding an account
    /// with a six-digit or letter-bearing PIN fails here immediately instead of
    /// producing an account nobody can ever sign in to.
    #[test]
    fn every_seeded_credential_satisfies_the_credential_policy() {
        for (name, _, _, password) in DEFAULT_USERS {
            assert!(
                crate::services::auth::is_valid_password(password),
                "{name} has a PIN the login policy would refuse: {password:?}"
            );
        }
    }

    /// The account picker offers an account, and that account can actually sign
    /// in. This is the end-to-end statement of the bug this fixes.
    ///
    /// The failure it guards against was silent and total: the login screen
    /// listed the account, the owner typed the documented PIN, and
    /// authentication refused — with the account unreachable through the very
    /// developer tool whose purpose is to restore access. Every layer is the
    /// real one: the same `list_login_accounts` projection the picker renders
    /// and the same `auth::login` the submit button calls.
    ///
    /// The stale credential is written here directly, exactly as an earlier
    /// build's developer reset would have left it, so the test reproduces the
    /// real broken state rather than a simplified stand-in.
    #[test]
    fn an_offered_starter_account_can_actually_sign_in() {
        use crate::repositories::users::LoginAccount;
        use crate::services::auth::{self, LoginInput};

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        // Reproduce the broken state: the reset re-inserted this account with a
        // credential from an earlier build, so the seed skipped the existing
        // name and left the stale hash in place.
        conn.execute(
            "UPDATE users SET password_hash = ?1, is_seed = 0 WHERE name = 'Belly'",
            [&auth::hash_password("0000000").unwrap()],
        )
        .unwrap();
        assert!(
            login(
                &conn,
                &LoginInput {
                    name: "Belly".into(),
                    password: "2214".into(),
                }
            )
            .is_err(),
            "precondition: the stale credential must really not authenticate"
        );

        // Startup is what repairs it.
        run_if_empty(&conn).unwrap();

        // 1. The picker still offers it...
        let offered = users::list_login_accounts(&conn)
            .unwrap()
            .into_iter()
            .map(|a: LoginAccount| a.name)
            .collect::<Vec<_>>();
        assert!(
            offered.contains(&"Belly".to_string()),
            "the account must remain on the login screen"
        );

        // 2. ...and selecting it and typing the documented PIN now works.
        let session = login(
            &conn,
            &LoginInput {
                name: "Belly".into(),
                password: "2214".into(),
            },
        )
        .expect("the offered account must be able to authenticate");
        assert_eq!(session.user.name, "Belly");
        assert_eq!(session.user.role, "ADMIN");

        // 3. A wrong PIN is still refused. Repairing the credential must not
        //    weaken authentication in any way.
        assert!(
            login(
                &conn,
                &LoginInput {
                    name: "Belly".into(),
                    password: "9999".into(),
                }
            )
            .is_err(),
            "a wrong PIN must still be refused"
        );

        // 4. An ordinary seeded account is untouched and still signs in.
        let other = login(
            &conn,
            &LoginInput {
                name: "amira".into(),
                password: "20192".into(),
            },
        )
        .expect("an existing seeded account must still sign in");
        assert_eq!(other.user.role, "MANAGER");
    }

    /// The repair is driven by the seed TABLE and the `is_seed` flag, never by a
    /// name. Proven here for the two cases that make that safe.
    ///
    /// A credential a person changed on a SEED-owned account must survive
    /// startup untouched — that is a real password change, not drift, and
    /// silently reverting it would be a data-loss bug far worse than the one
    /// being fixed. And an account this application never seeded must be
    /// invisible to the repair.
    #[test]
    fn the_credential_repair_never_reverts_a_real_password_change() {
        use crate::services::auth::{self, LoginInput};

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        // The café's owner genuinely changes amira's PIN through the app.
        let amira = users::find_by_name(&conn, "amira").unwrap().unwrap();
        users::set_password(&conn, amira.user.id, &auth::hash_password("4321").unwrap()).unwrap();

        run_if_empty(&conn).unwrap();

        assert!(
            login(
                &conn,
                &LoginInput {
                    name: "amira".into(),
                    password: "4321".into(),
                }
            )
            .is_ok(),
            "a real password change on a seeded account must survive startup"
        );
        assert!(
            login(
                &conn,
                &LoginInput {
                    name: "amira".into(),
                    password: "20192".into(),
                }
            )
            .is_err(),
            "the seed must not silently restore the original PIN over a real change"
        );

        // An account the seed never created is not touched, even though the
        // repair runs. Its name appears nowhere in the starter table.
        conn.execute(
            "INSERT INTO users (name, phone, role, password_hash, is_seed)
             VALUES ('Temporary', NULL, 'STAFF', ?1, 0)",
            [&auth::hash_password("9090").unwrap()],
        )
        .unwrap();
        run_if_empty(&conn).unwrap();
        let after = users::find_by_name(&conn, "Temporary").unwrap().unwrap();
        assert!(
            auth::verify_password("9090", &after.password_hash),
            "an account the seed does not own must never be rewritten"
        );
    }

    /// Startup is idempotent: running it again changes nothing and keeps every
    /// starter account able to sign in.
    #[test]
    fn the_credential_repair_is_idempotent() {
        use crate::services::auth::{self, LoginInput};

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        conn.execute(
            "UPDATE users SET password_hash = ?1, is_seed = 0 WHERE name = 'Belly'",
            [&auth::hash_password("0000000").unwrap()],
        )
        .unwrap();

        run_if_empty(&conn).unwrap();
        let first = users::find_by_name(&conn, "Belly").unwrap().unwrap().user;
        run_if_empty(&conn).unwrap();
        let second = users::find_by_name(&conn, "Belly").unwrap().unwrap().user;

        assert_eq!(
            first.updated_at, second.updated_at,
            "a healthy database must not be rewritten on every launch"
        );
        assert!(
            login(
                &conn,
                &LoginInput {
                    name: "Belly".into(),
                    password: "2214".into(),
                }
            )
            .is_ok(),
            "the account must still authenticate after repeated startups"
        );
    }


    /// An existing employee is never promoted by re-running the seed.
    ///
    /// The seed inserts by name and is a no-op on a conflict, so a person the
    /// café has already re-roled keeps the role they were given. This is the
    /// guard on the requirement that adding the owner admins must not turn
    /// anybody else into one.
    #[test]
    fn re_running_the_seed_never_changes_an_existing_accounts_role() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        // The café demotes a starter manager to an ordinary cashier.
        let user_id: i64 = conn
            .query_row("SELECT id FROM users WHERE name = 'amira'", [], |r| r.get(0))
            .unwrap();
        conn.execute("UPDATE users SET role = 'STAFF' WHERE id = ?1", [user_id])
            .unwrap();

        // Forcing the seed body to run again — the marker normally stops it.
        conn.execute("DELETE FROM app_settings WHERE key = ?1", [SEED_MARKER])
            .unwrap();
        run_if_empty(&conn).unwrap();

        let role: String = conn
            .query_row("SELECT role FROM users WHERE id = ?1", [user_id], |r| r.get(0))
            .unwrap();
        assert_eq!(
            role, "STAFF",
            "the seed must never re-promote an account the café demoted"
        );
    }

    /// The opening stock is attributed to a real user even with NO admin present.
    ///
    /// Regression guard for the opening-stock movement, which used to be
    /// attributed to "the first ADMIN user" and therefore had no actor at all
    /// once that account was removed from the seed.
    ///
    /// The official dataset DOES ship the café's own ADMIN accounts now, so the
    /// guard can no longer assert their absence — that would be testing the
    /// dataset rather than the attribution rule. Instead every admin is removed
    /// first and the catalog synchronization is then forced, which is exactly
    /// the situation the original bug produced: a catalog landing on a database
    /// where nobody holds the strongest role.
    #[test]
    fn the_official_catalog_lands_with_no_admin_account_at_all() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        // Strip every admin, exactly as the dataset looked before the owner
        // accounts were added. The ROLE is demoted rather than the row deleted:
        // a login is referenced by its employee record, so deleting one would
        // trip a foreign key long before the catalog was ever reached.
        conn.execute("UPDATE users SET role = 'STAFF' WHERE role = 'ADMIN'", [])
            .unwrap();
        let admins: i64 = conn
            .query_row("SELECT COUNT(*) FROM users WHERE role = 'ADMIN'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(admins, 0, "this test is only meaningful with no admin at all");

        // Clear the seeded catalog, then re-run the synchronization an existing
        // installation performs.
        conn.execute("DELETE FROM stock_movements", []).unwrap();
        conn.execute("DELETE FROM inventory_items", []).unwrap();
        conn.execute("DELETE FROM products", []).unwrap();
        conn.execute("DELETE FROM app_settings WHERE key = ?1", [CATALOG_SEED_MARKER])
            .unwrap();

        run_if_empty(&conn).unwrap();

        // The catalog's opening stock still landed…
        let tracked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inventory_items i
                 JOIN products p ON p.id = i.product_id
                 WHERE p.track_inventory = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(tracked > 0, "the catalog must land even with no admin");

        // …and every movement it wrote names a real actor rather than a null.
        let orphan_movements: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM stock_movements WHERE user_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_movements, 0, "every movement needs a real actor");
    }
}
