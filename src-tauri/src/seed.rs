//! Deterministic seed infrastructure.
//!
//! - Runs the full starter seed only on a fresh database.
//! - Catalog v4 is synchronized once for existing installations.
//! - Seed catalog entries are flagged (`is_seed = 1`).
//! - Historical transaction data is never deleted.
//! - Old catalog rows that are referenced by history are deactivated;
//!   unreferenced old seed rows can be removed safely.
//! - Categories are required for every catalog row; existing rows were
//!   backfilled to a seeded system category during migration 14.

use crate::db::Db;
use crate::error::AppResult;
use crate::repositories::{catalog, employees, users};
use crate::services::auth;

/// Marker written into `app_settings` after the initial seed completes.
const SEED_MARKER: &str = "seed.completed_at";

/// Marker for the current starter catalog version.
const CATALOG_SEED_MARKER: &str = "seed.catalog.v4.completed_at";

/// Default starter accounts.
///
/// Public so the developer-reset test can assert the re-seeded account count
/// against the real list instead of a hardcoded number that silently rots the
/// next time a starter account is added.
pub const DEFAULT_USERS: &[(&str, Option<&str>, &str, &str)] = &[
    ("admin", None, "ADMIN", "admin123"),
    ("manager", None, "MANAGER", "manager123"),
    ("amira", None, "MANAGER", "20192"),
    ("cashier", None, "STAFF", "cashier123"),
    ("momo", None, "STAFF", "11111"),
    ("foly", None, "STAFF", "22222"),
];

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
    ("كوب لوتس", "PRODUCT", "CAFE", 75, "ديزارت", None),
    ("كوب بستاشيو", "PRODUCT", "CAFE", 80, "ديزارت", None),
    ("ميني تورتة روشيه", "PRODUCT", "CAFE", 80, "ديزارت", None),
    ("ديزرت مع نسكافيه", "PRODUCT", "CAFE", 100, "ديزارت", None),
    ("ديزرت مع كاتر", "PRODUCT", "CAFE", 100, "ديزارت", None),
    ("كاب ريد فيلفت", "PRODUCT", "CAFE", 75, "ديزارت", None),
    ("كاب نوتيلا", "PRODUCT", "CAFE", 80, "ديزارت", None),

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
    ("كيوي", "PRODUCT", "CAFE", 50, "عصائر فريشات", None),
    ("تين شوكي", "PRODUCT", "CAFE", 75, "عصائر فريشات", None),
    ("فريش ميكس", "PRODUCT", "CAFE", 110, "عصائر فريشات", None),
    ("ليمون (عرض)", "PRODUCT", "CAFE", 20, "عصائر فريشات", Some(0)),
    ("بطيخ (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("تفاح أخضر (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("أناناس (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("جوافة بالنعناع (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("سمورى بطيخ (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("سمورى تفاح أخضر (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("سمورى أناناس (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("سمورى جوافة نعناع (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("سمورى بلوبيري (عرض)", "PRODUCT", "CAFE", 30, "عصائر فريشات", Some(0)),
    ("عصير رمان", "PRODUCT", "CAFE", 50, "عصائر فريشات", None),
    ("فلوريدا", "PRODUCT", "CAFE", 75, "عصائر فريشات", None),
    ("مانجا باشون فروت", "PRODUCT", "CAFE", 120, "عصائر فريشات", None),

    // ============================================================
    // SMOOTHIE (اسموري)
    // ============================================================
    ("اسموري جوافة نعناع", "PRODUCT", "CAFE", 65, "اسموري", None),
    ("اسموري تفاح أخضر", "PRODUCT", "CAFE", 79, "اسموري", None),
    ("اسموري توت", "PRODUCT", "CAFE", 65, "اسموري", None),
    ("اسموري خوخ", "PRODUCT", "CAFE", 65, "اسموري", None),
    ("اسموري جوافة", "PRODUCT", "CAFE", 60, "اسموري", None),
    ("اسموري رمان", "PRODUCT", "CAFE", 50, "اسموري", None),
    ("اسموري باشون فروت", "PRODUCT", "CAFE", 99, "اسموري", None),
    ("اسموري فراولة نعناع", "PRODUCT", "CAFE", 50, "اسموري", None),
    ("اسموري بطيخ", "PRODUCT", "CAFE", 90, "اسموري", None),
    ("اسموري مانجو", "PRODUCT", "CAFE", 90, "اسموري", None),
    ("اسموري بطيخ نعناع", "PRODUCT", "CAFE", 70, "اسموري", None),
    ("اسموري كيوي", "PRODUCT", "CAFE", 50, "اسموري", None),
    ("اسموري ليمون نعناع", "PRODUCT", "CAFE", 69, "اسموري", None),
    ("سبانيش لاتيه (اسموري)", "PRODUCT", "CAFE", 60, "اسموري", None),
    ("اسموري ميكس", "PRODUCT", "CAFE", 90, "اسموري", None),
    ("موهيتو بلوبيري", "PRODUCT", "CAFE", 87, "موهيتو", None),
    ("بلوبيري", "PRODUCT", "CAFE", 88, "موهيتو", None),
    ("سموري ليمون نعناع", "PRODUCT", "CAFE", 69, "اسموري", None),
    ("مانجا باشون", "PRODUCT", "CAFE", 120, "موهيتو", None),
    ("سموري فراولة", "PRODUCT", "CAFE", 87, "اسموري", None),
    ("اسموري بلوبيري", "PRODUCT", "CAFE", 88, "اسموري", None),
    ("اسموري مور باللبن", "PRODUCT", "CAFE", 90, "اسموري", None),

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
    ("ميلك شيك فانيليا", "PRODUCT", "CAFE", 87, "ميلك شيك", None),
    ("ميلك شيك موكا", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("بانا سيلايت", "PRODUCT", "CAFE", 75, "ميلك شيك", None),
    ("ميلك شيك أوريو", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("شوكليت موكنسيو", "PRODUCT", "CAFE", 65, "ميلك شيك", None),
    ("ميلك شيك فراولة", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك مانجا", "PRODUCT", "CAFE", 90, "ميلك شيك", None),
    ("ميلك شيك", "PRODUCT", "CAFE", 75, "ميلك شيك", None),
    ("ميلك شيك بلوبيري", "PRODUCT", "CAFE", 99, "ميلك شيك", None),
    ("ميلك شيك هوهور", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك نسكافيه", "PRODUCT", "CAFE", 85, "ميلك شيك", None),
    ("ميلك شيك لوتس", "PRODUCT", "CAFE", 87, "ميلك شيك", None),
    ("ميلك شيك بستاشيو", "PRODUCT", "CAFE", 99, "ميلك شيك", None),

    // ============================================================
    // FRIDGE & REFRESHMENTS (ثلاجة ومشروبات غازية)
    // ============================================================
    ("مياه", "PRODUCT", "CAFE", 10, "ثلاجة", Some(0)),
    ("دبل دير", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("موس ديو", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("بريل", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("بربيكان", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("موسى", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("فيروز", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("سبايدر", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("ريد بول", "PRODUCT", "CAFE", 90, "ثلاجة", Some(0)),
    ("سيبيح", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("شوببس", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("سيسي", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("كولا", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("ميرندا", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("كاتر مناسبات", "PRODUCT", "CAFE", 25, "ثلاجة", Some(0)),
    ("امسنل", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("ميرندا تفاح", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("نوبست", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("فروتر", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("فيروز", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("سبرايت", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("فاينا", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("في سفن", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("ساسس", "PRODUCT", "CAFE", 30, "ثلاجة", Some(0)),
    ("راني", "PRODUCT", "CAFE", 35, "ثلاجة", Some(0)),
    ("فاينا برتقال", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("باور هورس مشروب طاقة", "PRODUCT", "CAFE", 60, "ثلاجة", Some(0)),
    ("سفن أب", "PRODUCT", "CAFE", 40, "ثلاجة", Some(0)),
    ("أسس كولا", "PRODUCT", "CAFE", 25, "ثلاجة", Some(0)),

    // ============================================================
    // MARKET & ACCESSORIES (ماركت)
    // ============================================================
    ("حافظة 2 في 3", "PRODUCT", "WASH", 55, "ماركت", None),
    ("لحاف فيبر", "PRODUCT", "WASH", 50, "ماركت", None),
    ("عرض غسلة", "PRODUCT", "WASH", 100, "ماركت", None),
    ("عرض غسلة مع قهوة فري", "PRODUCT", "WASH", 100, "ماركت", None),
    ("عرض غسلة عرض", "PRODUCT", "WASH", 120, "ماركت", None),
    ("عرض غسلة", "PRODUCT", "WASH", 120, "ماركت", None),
    ("تلميع باب", "PRODUCT", "WASH", 200, "ماركت", None),
    ("راسبين ملاكي", "PRODUCT", "WASH", 110, "ماركت", None),
    ("عرض 400", "PRODUCT", "WASH", 400, "ماركت", None),
    ("كسوة طارة جلد", "PRODUCT", "WASH", 300, "ماركت", None),
    ("ثلاثة إم طفاية", "PRODUCT", "WASH", 200, "ماركت", None),
    ("وصلة صوت", "PRODUCT", "WASH", 220, "ماركت", None),
    ("طفاية كربون", "PRODUCT", "WASH", 220, "ماركت", None),
    ("وصلة إس إيه 45", "PRODUCT", "WASH", 175, "ماركت", None),
    ("وصلة أول إس", "PRODUCT", "WASH", 150, "ماركت", None),
    ("رأس شاحن دبليو 105", "PRODUCT", "WASH", 450, "ماركت", None),
    ("رأس شاحن دبليو 30", "PRODUCT", "WASH", 350, "ماركت", None),
    ("وصلة لينو صوت", "PRODUCT", "WASH", 150, "ماركت", None),
    ("رأس شاحن 45", "PRODUCT", "WASH", 450, "ماركت", None),
    ("كابل بطارية", "PRODUCT", "WASH", 450, "ماركت", None),
    ("ريشة نظافة", "PRODUCT", "WASH", 250, "ماركت", None),
    ("لمع تابلوه كبير", "PRODUCT", "WASH", 125, "ماركت", None),
    ("لمع تابلوه صغير", "PRODUCT", "WASH", 100, "ماركت", None),
    ("معطر إيري بخاخ", "PRODUCT", "WASH", 150, "ماركت", None),
    ("معطر علبة باكت", "PRODUCT", "WASH", 275, "ماركت", None),
    ("إيريون فواحات جديدة", "PRODUCT", "WASH", 75, "ماركت", None),
    ("مبدلنا جلد جديدة", "PRODUCT", "WASH", 100, "ماركت", None),
    ("بارك بيج كود", "PRODUCT", "WASH", 120, "ماركت", None),
    ("حامل موبايل", "PRODUCT", "WASH", 100, "ماركت", None),
    ("حامل موبايل بيتشحن", "PRODUCT", "WASH", 180, "ماركت", None),
    ("بادة", "PRODUCT", "WASH", 150, "ماركت", None),
    ("فجوة باب", "PRODUCT", "WASH", 150, "ماركت", None),
    ("كسوة طارة في علبة", "PRODUCT", "WASH", 100, "ماركت", None),
    ("طعم ناره", "PRODUCT", "WASH", 15, "ماركت", None),
    ("كسوة عربية 2 كرسي", "PRODUCT", "WASH", 100, "ماركت", None),
    ("فوطة", "PRODUCT", "WASH", 45, "ماركت", None),
    ("فواحة 30", "PRODUCT", "WASH", 30, "ماركت", None),
    ("كار كبر صالون قماش", "PRODUCT", "WASH", 750, "ماركت", None),
    ("دواسات أكياس", "PRODUCT", "WASH", 20, "ماركت", None),
    ("كود العربات", "PRODUCT", "WASH", 250, "ماركت", None),
    ("طقم صالون شفاف", "PRODUCT", "WASH", 50, "ماركت", None),
    ("طقم صالون قماش", "PRODUCT", "WASH", 100, "ماركت", None),
    ("بادة عربية", "PRODUCT", "WASH", 150, "ماركت", None),
    ("كابل صوت إم", "PRODUCT", "WASH", 220, "ماركت", None),
    ("صالون كار كبر جلد", "PRODUCT", "WASH", 600, "ماركت", None),

    // ============================================================
    // CAR WASH & CARE SERVICES (خدمات غسيل السيارات)
    // ============================================================
    ("غسيل داخلي خارجي سيدان", "SERVICE", "WASH", 85, "خدمات غسيل السيارات", None),
    ("تلميع مرحلة واحدة", "SERVICE", "WASH", 1200, "خدمات غسيل السيارات", None),
    ("تلميع مرحلتين", "SERVICE", "WASH", 1800, "خدمات غسيل السيارات", None),
    ("تلميع 3 مراحل", "SERVICE", "WASH", 2000, "خدمات غسيل السيارات", None),
    ("كار كبر داخلي كامل", "SERVICE", "WASH", 1000, "خدمات غسيل السيارات", None),
    ("كار كبر كامل مانور + شنطة + 4 حيوط", "SERVICE", "WASH", 1500, "خدمات غسيل السيارات", None),
    ("حبط كار كبر", "SERVICE", "WASH", 80, "خدمات غسيل السيارات", None),
    ("كرسي كار كبر", "SERVICE", "WASH", 150, "خدمات غسيل السيارات", None),
    ("سقف كار كبر", "SERVICE", "WASH", 350, "خدمات غسيل السيارات", None),
    ("باب كار كبر", "SERVICE", "WASH", 60, "خدمات غسيل السيارات", None),
    ("شنطة كار كبر", "SERVICE", "WASH", 100, "خدمات غسيل السيارات", None),
    ("أرضية كار كبر", "SERVICE", "WASH", 100, "خدمات غسيل السيارات", None),
    ("مانور كيماوي", "SERVICE", "WASH", 100, "خدمات غسيل السيارات", None),
    ("فواحة كبيرة", "SERVICE", "WASH", 45, "خدمات غسيل السيارات", None),
    ("فواحة صغيرة", "SERVICE", "WASH", 25, "خدمات غسيل السيارات", None),
    ("مليكة معطر خو", "SERVICE", "WASH", 90, "خدمات غسيل السيارات", None),
    ("غسيل كامل نصف نقل", "SERVICE", "WASH", 200, "خدمات غسيل السيارات", None),
    ("غسيل غطاء السيارة", "SERVICE", "WASH", 50, "خدمات غسيل السيارات", None),
    ("دواسة 2", "SERVICE", "WASH", 10, "خدمات غسيل السيارات", None),
    ("غسيل سكوتر", "SERVICE", "WASH", 50, "خدمات غسيل السيارات", None),
    ("غسيل كامل (شركة)", "SERVICE", "WASH", 100, "خدمات غسيل السيارات", None),
    ("تلميع فانوس", "SERVICE", "WASH", 200, "خدمات غسيل السيارات", None),
    ("فوطة", "SERVICE", "WASH", 25, "خدمات غسيل السيارات", None),
    ("كسوة كاملة كار كبر", "SERVICE", "WASH", 300, "خدمات غسيل السيارات", None),
    ("غسيل موتوسيكل", "SERVICE", "WASH", 50, "خدمات غسيل السيارات", None),
    ("غسيل كامل (S.U.V)", "SERVICE", "WASH", 200, "خدمات غسيل السيارات", None),
    ("متر سجاد", "SERVICE", "WASH", 20, "خدمات غسيل السيارات", None),
    ("غسيل كامل (V.I.P)", "SERVICE", "WASH", 250, "خدمات غسيل السيارات", None),
    ("نانو تابلوه", "SERVICE", "WASH", 200, "خدمات غسيل السيارات", None),
    ("فواحة رحاج", "SERVICE", "WASH", 60, "خدمات غسيل السيارات", None),
    ("غسلة مجانية", "SERVICE", "WASH", 0, "خدمات غسيل السيارات", None),
    ("ميدلنا معدن", "SERVICE", "WASH", 90, "خدمات غسيل السيارات", None),
    ("سكانة", "SERVICE", "WASH", 100, "خدمات غسيل السيارات", None),
    ("واكس خارجي", "SERVICE", "WASH", 150, "خدمات غسيل السيارات", None),
    ("عرض غسيل خارجي في", "SERVICE", "WASH", 95, "خدمات غسيل السيارات", None),
    ("غسيل كامل سيدان", "SERVICE", "WASH", 175, "خدمات غسيل السيارات", None),
    ("فواحة ك 45", "SERVICE", "WASH", 45, "خدمات غسيل السيارات", None),
    ("فواحة 25", "SERVICE", "WASH", 25, "خدمات غسيل السيارات", None),
    ("فواحة 15", "SERVICE", "WASH", 15, "خدمات غسيل السيارات", None),
    ("كوفر طارة", "SERVICE", "WASH", 20, "خدمات غسيل السيارات", None),
    ("بطانية أطفال", "SERVICE", "WASH", 75, "خدمات غسيل السيارات", None),
    ("تلميع شنطة", "SERVICE", "WASH", 300, "خدمات غسيل السيارات", None),
    ("تلميع", "SERVICE", "WASH", 400, "خدمات غسيل السيارات", None),
    ("تنظيف شنطة عادي", "SERVICE", "WASH", 50, "خدمات غسيل السيارات", None),
    ("بطانية", "SERVICE", "WASH", 90, "خدمات غسيل السيارات", None),
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
                conn.execute(
                    "INSERT INTO stock_movements
                        (product_id, change, reason, note, ref_invoice_id, user_id)
                     VALUES (?1, ?2, 'ADJUSTMENT', 'initial_stock', NULL,
                        (SELECT id FROM users
                         WHERE role = 'ADMIN'
                         ORDER BY id
                         LIMIT 1))",
                    rusqlite::params![product_id, quantity],
                )?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
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
    /// seed verbatim: "عرض غسلة", "فيروز" and "فوطة" each appear more than once
    /// with different types, departments or prices.
    #[test]
    fn intentional_duplicate_names_are_preserved_not_deduplicated() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        for name in ["عرض غسلة", "فيروز", "فوطة"] {
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

        assert_eq!(water, (water.0, "ثلاجة".to_string(), 0));

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

        assert_eq!(category_name, "خدمات غسيل السيارات");
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
}
