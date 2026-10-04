//! Expense persistence: dynamic categories, shift-scoped expenses, and the
//! category breakdown the closing reports consume.
//!
//! Expenses moved here from `repositories::ops` because they are now a
//! first-class financial concept tied to a shift and its drawer, not a day-level
//! bookkeeping row. `ops` keeps stock movements.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

/// A reusable expense category. Station names live in `name_ar` so the report
/// prints and renders the domain term without the UI hardcoding any string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseCategory {
    pub code: String,
    pub name_ar: String,
    pub is_system: bool,
    pub is_active: bool,
    /// Whether an expense in this category must name an employee.
    ///
    /// This is DATA, not a code the UI or the service recognises: a category
    /// carries the rule and the UI reads it from this payload, so a future
    /// employee-linked category needs no change in any caller. The seeded
    /// employee-linked categories are the advance and the salary.
    pub requires_employee: bool,
    /// Whether an expense in this category ALSO writes an advance ledger row.
    ///
    /// This is deliberately a SECOND fact rather than a consequence of
    /// `requires_employee`. Both mean "this spend is about a named person", but
    /// only an advance reduces that person's monthly pay — a salary payment does
    /// not. Conflating them would fabricate an advance for every salary and
    /// charge the payroll twice, so the two are stated separately and read
    /// separately.
    pub records_advance: bool,
}

/// Active categories, ordered for display. Inactive ones stay in the table so
/// historical expenses keep a resolvable label.
pub fn list_categories(conn: &Db, active_only: bool) -> AppResult<Vec<ExpenseCategory>> {
    let mut stmt = conn.prepare(
        "SELECT code, name_ar, is_system, is_active, requires_employee, records_advance
         FROM expense_categories
         WHERE (?1 = 0 OR is_active = 1)
         ORDER BY is_active DESC, id",
    )?;
    let rows = stmt.query_map([active_only as i64], |r| {
        Ok(ExpenseCategory {
            code: r.get(0)?,
            name_ar: r.get(1)?,
            is_system: r.get::<_, i64>(2)? != 0,
            is_active: r.get::<_, i64>(3)? != 0,
            requires_employee: r.get::<_, i64>(4)? != 0,
            records_advance: r.get::<_, i64>(5)? != 0,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// A category code is valid when it exists and is active. This is the single
/// gate the service uses, so a category can never be hardcoded in a caller.
///
/// A MISSING or inactive category reads as `None` — not as a database failure —
/// so the caller turns it into a validation error.
pub fn category_is_active(conn: &Db, code: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT is_active FROM expense_categories WHERE code = ?1",
            [code],
            |r| r.get::<_, i64>(0),
        )
        .map(|active| active == 1)
        .unwrap_or(false))
}

/// Whether an ACTIVE category demands an employee, or `None` when the category is
/// unknown or inactive.
///
/// This is the authoritative, database-driven form of the advance rule. The
/// service calls it exactly once, inside the creation transaction, and decides
/// from the RESULT rather than from any category code, so the same rule holds for
/// a category added later.
pub fn category_requires_employee(conn: &Db, code: &str) -> AppResult<Option<bool>> {
    Ok(conn
        .query_row(
            "SELECT requires_employee FROM expense_categories
             WHERE code = ?1 AND is_active = 1",
            [code],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .map(|flag| flag == 1))
}

/// Whether an expense in this category must ALSO write an advance ledger row.
///
/// `false` for every category that is unknown, inactive, or merely
/// employee-linked — a salary payment names its employee but is not an advance,
/// and must never reduce that person's monthly pay.
///
/// The service calls this exactly once, inside the creation transaction, and
/// decides from the RESULT rather than from any category code.
pub fn category_records_advance(conn: &Db, code: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT records_advance FROM expense_categories
             WHERE code = ?1 AND is_active = 1",
            [code],
            |r| r.get::<_, i64>(0),
        )
        .map(|flag| flag == 1)
        .unwrap_or(false))
}

/// The stored row behind a category, INCLUDING the system flag and the active
/// state — what a caller must read before it is allowed to rename or remove it.
#[derive(Debug, Clone)]
pub struct StoredCategory {
    pub code: String,
    pub name_ar: String,
    pub is_system: bool,
    pub is_active: bool,
}

pub fn get_category(conn: &Db, code: &str) -> AppResult<Option<StoredCategory>> {
    Ok(conn
        .query_row(
            "SELECT code, name_ar, is_system, is_active FROM expense_categories WHERE code = ?1",
            [code],
            |r| {
                Ok(StoredCategory {
                    code: r.get(0)?,
                    name_ar: r.get(1)?,
                    is_system: r.get::<_, i64>(2)? != 0,
                    is_active: r.get::<_, i64>(3)? != 0,
                })
            },
        )
        .optional()?)
}

/// Whether a DIFFERENT category already carries this Arabic name.
///
/// Case-insensitive, mirroring the `NOCASE` category name the catalog uses, and
/// it must ignore the row being saved: re-submitting a category's own unchanged
/// name is not a duplicate of itself. `None` is "no row is excluded", which is
/// what a creation asks.
pub fn category_name_exists(conn: &Db, name: &str, except_code: Option<&str>) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM expense_categories
          WHERE name_ar = ?1 COLLATE NOCASE AND (?2 IS NULL OR code != ?2))",
        params![name, except_code],
        |r| r.get(0),
    )?)
}

/// Create a category and return its `code`.
///
/// The key is generated from the row's OWN id rather than from the Arabic name,
/// so it is unique for the life of the table and — the reason it matters — a
/// later rename can never invalidate an expense that already points at it:
/// expenses store the code, never the label.
///
/// The two statements run in one transaction because the first reserves the row
/// with a placeholder key the schema allows only transiently; the single
/// application connection means that reservation is never contended.
pub fn insert_category(conn: &Db, name: &str) -> AppResult<String> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO expense_categories (code, name_ar) VALUES ('CAT_NEW', ?1)",
        [name],
    )?;
    let id = tx.last_insert_rowid();
    let code = format!("CAT_{id}");
    tx.execute(
        "UPDATE expense_categories SET code = ?2 WHERE id = ?1",
        params![id, code],
    )?;
    tx.commit()?;
    Ok(code)
}

/// Rename a category. Returns `false` for a code that is not there, so the
/// service can answer "not found" instead of reporting a silent success.
pub fn update_category_name(conn: &Db, code: &str, name: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE expense_categories SET name_ar = ?2 WHERE code = ?1",
        params![code, name],
    )?;
    Ok(changed > 0)
}

/// Remove a category row. The caller owns the rules that make it safe —
/// existence, the system flag and the usage count — see
/// [`crate::services::ops::delete_category`].
pub fn delete_category(conn: &Db, code: &str) -> AppResult<bool> {
    let deleted = conn.execute("DELETE FROM expense_categories WHERE code = ?1", [code])?;
    Ok(deleted > 0)
}

/// Every expense still pointing at the category, HISTORICAL rows INCLUDED.
///
/// The count is deliberately taken over the whole `expenses` table: an expense
/// booked last month keeps its `category` key exactly like one booked today, so
/// counting only recent rows would let the service remove a category the
/// database would then refuse — and would strand a spend that really happened.
pub fn category_expense_count(conn: &Db, code: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM expenses WHERE category = ?1",
        [code],
        |r| r.get(0),
    )?)
}

/// Human label for a category, resolved from the table. Falls back to the raw
/// code only if the category is missing, so a broken row still prints.
pub fn category_name(conn: &Db, code: &str) -> AppResult<String> {
    Ok(conn
        .query_row(
            "SELECT name_ar FROM expense_categories WHERE code = ?1",
            [code],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| code.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expense {
    pub id: i64,
    pub category: String,
    pub category_name: String,
    pub amount: i64,
    pub description: Option<String>,
    pub expense_date: String,
    pub is_recurring: bool,
    pub recurrence: Option<String>,
    pub business_day_id: Option<i64>,
    pub shift_id: Option<i64>,
    pub paid_from_cash: bool,
    /// The employee this spend is FOR, when its category requires one (an
    /// advance). `None` for every ordinary expense — and for every expense that
    /// predates employee-linked categories, which is not a gap but history.
    pub employee_id: Option<i64>,
    pub user_name: Option<String>,
    pub user_role: Option<String>,
    pub created_at: String,
}

const EXPENSE_SELECT: &str = "SELECT e.id, e.category, c.name_ar, e.amount, e.description,
        e.expense_date, e.is_recurring, e.recurrence, e.business_day_id, e.shift_id,
        e.paid_from_cash, e.employee_id, u.name, u.role, e.created_at
 FROM expenses e
 LEFT JOIN users u ON u.id = e.user_id
 LEFT JOIN expense_categories c ON c.code = e.category";

fn expense_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Expense> {
    let category: String = r.get(1)?;
    Ok(Expense {
        id: r.get(0)?,
        category: category.clone(),
        category_name: r.get::<_, Option<String>>(2)?.unwrap_or(category),
        amount: r.get(3)?,
        description: r.get(4)?,
        expense_date: r.get(5)?,
        is_recurring: r.get::<_, i64>(6)? != 0,
        recurrence: r.get(7)?,
        business_day_id: r.get(8)?,
        shift_id: r.get(9)?,
        paid_from_cash: r.get::<_, i64>(10)? != 0,
        employee_id: r.get(11)?,
        user_name: r.get(12)?,
        user_role: r.get(13)?,
        created_at: r.get(14)?,
    })
}

/// Insert one expense row and return its id.
///
/// `employee_id` is the linkage for an employee-linked category (an advance) and
/// is `None` for every other spend. The service decides it from the CATEGORY, so
/// no caller can attach an employee to a spend that is not about an employee.
#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Db,
    category: &str,
    amount: i64,
    description: Option<&str>,
    expense_date: &str,
    is_recurring: bool,
    recurrence: Option<&str>,
    business_day_id: Option<i64>,
    shift_id: Option<i64>,
    paid_from_cash: bool,
    user_id: i64,
    employee_id: Option<i64>,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO expenses (category, amount, description, expense_date, is_recurring,
            recurrence, business_day_id, shift_id, paid_from_cash, user_id, employee_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            category,
            amount,
            description,
            expense_date,
            is_recurring as i64,
            recurrence,
            business_day_id,
            shift_id,
            paid_from_cash as i64,
            user_id,
            employee_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
    recurring_only: bool,
) -> AppResult<Vec<Expense>> {
    let mut sql = format!("{EXPENSE_SELECT} WHERE 1=1");
    let mut args: Vec<String> = Vec::new();
    if let Some(f) = from {
        args.push(f.to_string());
        sql.push_str(&format!(" AND e.expense_date >= ?{}", args.len()));
    }
    if let Some(t) = to {
        args.push(t.to_string());
        sql.push_str(&format!(" AND e.expense_date <= ?{}", args.len()));
    }
    if recurring_only {
        sql.push_str(" AND e.is_recurring = 1");
    }
    sql.push_str(" ORDER BY e.expense_date DESC, e.id DESC LIMIT 500");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), expense_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Every expense booked to one shift, oldest first. This is the ONLY source of
/// a shift's expenses: reconciliation reads the shift's own rows, so an expense
/// can never be counted against a shift it was not recorded during.
pub fn list_for_shift(conn: &Db, shift_id: i64) -> AppResult<Vec<Expense>> {
    let mut stmt = conn.prepare(&format!(
        "{EXPENSE_SELECT} WHERE e.shift_id = ?1 ORDER BY e.id"
    ))?;
    let rows = stmt.query_map([shift_id], expense_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Expenses of a day that belong to NO shift (general manager expenses).
///
/// These are deliberately separate from shift expenses: a day-level expense is
/// not part of any drawer's reconciliation, so it must not silently reduce the
/// expected cash of whichever shift happened to be open.
pub fn list_for_day_without_shift(conn: &Db, business_day_id: i64) -> AppResult<Vec<Expense>> {
    let mut stmt = conn.prepare(&format!(
        "{EXPENSE_SELECT} WHERE e.business_day_id = ?1 AND e.shift_id IS NULL ORDER BY e.id"
    ))?;
    let rows = stmt.query_map([business_day_id], expense_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// One line of the expense breakdown shown on a closing document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakdownRow {
    pub category: String,
    pub category_name: String,
    pub count: i64,
    pub amount: i64,
}

/// Serialize a resolved breakdown for storage in a closing snapshot.
///
/// The snapshot keeps the RESOLVED rows — including the Arabic label read from
/// `expense_categories` at closing time — so a later rename or deactivation of
/// a category cannot rewrite a document that was already issued.
pub fn encode_breakdown(rows: &[BreakdownRow]) -> String {
    // A `Vec<BreakdownRow>` of plain strings and integers always serializes;
    // an empty list is the correct value for a closing with no expenses.
    serde_json::to_string(rows).unwrap_or_else(|_| "[]".to_string())
}

/// Read a stored breakdown back. An absent or unreadable value is an empty
/// breakdown rather than a failure: the closing snapshot's own `expenses`
/// total is the authoritative figure, and the breakdown only elaborates it.
pub fn decode_breakdown(json: &str) -> Vec<BreakdownRow> {
    serde_json::from_str(json).unwrap_or_default()
}

/// Group a shift's expenses by category.
///
/// Grouping is done in SQL so the report, the printer and the screen read the
/// same numbers, and the totals can be asserted against one query.
pub fn breakdown_for_shift(conn: &Db, shift_id: i64) -> AppResult<Vec<BreakdownRow>> {
    breakdown(
        conn,
        "SELECT e.category, COUNT(*), COALESCE(SUM(e.amount), 0)
         FROM expenses e WHERE e.shift_id = ?1
         GROUP BY e.category ORDER BY 3 DESC, e.category",
        [shift_id],
    )
}

fn breakdown<P: rusqlite::Params>(conn: &Db, sql: &str, args: P) -> AppResult<Vec<BreakdownRow>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(args, |r| {
        let code: String = r.get(0)?;
        Ok((code, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (code, count, amount) = row?;
        out.push(BreakdownRow {
            category_name: category_name(conn, &code)?,
            category: code,
            count,
            amount,
        });
    }
    Ok(out)
}

/// Total expenses booked to a shift, and the part of it paid from the drawer.
///
/// Both come from the SAME filtered query, so a cash expense is always a subset
/// of the shift's expenses and can never be reported twice or as more than was
/// actually booked.
pub fn shift_totals(conn: &Db, shift_id: i64) -> AppResult<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount), 0),
                COALESCE(SUM(CASE WHEN paid_from_cash = 1 THEN amount ELSE 0 END), 0)
         FROM expenses WHERE shift_id = ?1",
        [shift_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// Total of the expenses matching a period — used by the expenses screen so its
/// period total is aggregated in SQL over EVERY matching row instead of being
/// summed in React over a page-capped list.
pub fn total(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
    recurring_only: bool,
) -> AppResult<i64> {
    let mut sql = String::from("SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE 1=1");
    let mut args: Vec<String> = Vec::new();
    if let Some(f) = from {
        args.push(f.to_string());
        sql.push_str(&format!(" AND e.expense_date >= ?{}", args.len()));
    }
    if let Some(t) = to {
        args.push(t.to_string());
        sql.push_str(&format!(" AND e.expense_date <= ?{}", args.len()));
    }
    if recurring_only {
        sql.push_str(" AND e.is_recurring = 1");
    }
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    Ok(conn.query_row(&sql, refs.as_slice(), |r| r.get(0))?)
}

/// Total (and cash part) of a business day's expenses that belong to NO shift.
///
/// A manager may record a spend that belongs to the DAY rather than to a till
/// (rent, a supplier bill). Such an expense is part of the day's expense total,
/// so a day closing must report it — but it belongs to no drawer, so it must
/// never reduce a shift's expected cash. That is exactly the split this function
/// and [`day_level_breakdown`] make explicit, and it is the same rule
/// [`list_for_day_without_shift`] documents.
pub fn day_level_totals(conn: &Db, business_day_id: i64) -> AppResult<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount), 0),
                COALESCE(SUM(CASE WHEN paid_from_cash = 1 THEN amount ELSE 0 END), 0)
         FROM expenses WHERE business_day_id = ?1 AND shift_id IS NULL",
        [business_day_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// Category breakdown of a business day's shift-less expenses, so the day
/// closing's breakdown still sums to its expense total.
pub fn day_level_breakdown(conn: &Db, business_day_id: i64) -> AppResult<Vec<BreakdownRow>> {
    breakdown(
        conn,
        "SELECT e.category, COUNT(*), COALESCE(SUM(e.amount), 0)
         FROM expenses e WHERE e.business_day_id = ?1 AND e.shift_id IS NULL
         GROUP BY e.category ORDER BY 3 DESC, e.category",
        [business_day_id],
    )
}

/// Merge two category breakdowns into one, summing count and amount per
/// category. Used to add the day-level expense rows to the shift rows without
/// counting either set twice: the two inputs are disjoint by construction (one
/// covers `shift_id IN (...)`, the other `shift_id IS NULL` for the same day).
pub fn merge_breakdowns(a: Vec<BreakdownRow>, b: Vec<BreakdownRow>) -> Vec<BreakdownRow> {
    merge_breakdown_sets(vec![a, b])
}

/// Fold any number of disjoint breakdown sets into one, summing count and amount
/// per category. The inputs must be disjoint by construction (here: one set per
/// included shift), so a category can never be counted twice.
pub fn merge_breakdown_sets<I>(sets: I) -> Vec<BreakdownRow>
where
    I: IntoIterator<Item = Vec<BreakdownRow>>,
{
    let mut a: Vec<BreakdownRow> = Vec::new();
    for set in sets {
        for row in set {
            match a.iter_mut().find(|r| r.category == row.category) {
                Some(existing) => {
                    existing.count += row.count;
                    existing.amount += row.amount;
                }
                None => a.push(row),
            }
        }
    }
    // Same ordering rule as the SQL: largest amount first, then the category
    // code, so the printed and on-screen breakdowns stay deterministic.
    a.sort_by(|x, y| {
        y.amount
            .cmp(&x.amount)
            .then_with(|| x.category.cmp(&y.category))
    });
    a
}

// --------------------------------------------------------------- analytics

/// One category's share of a period of spending.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseCategoryTotal {
    pub category: String,
    /// Resolved from `expense_categories`, exactly like [`Expense::category_name`].
    pub category_name: String,
    pub count: i64,
    pub amount: i64,
    /// Whole percent of the period's spend, rounded the same way for every row
    /// and derived ONCE server-side from the same total the KPI band shows — so
    /// the bar and the figure beside it can never disagree. `0` for an empty
    /// period; the rows are not re-scaled to force them to 100%.
    pub share: i64,
}

/// One business day's spending inside the period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseDayTotal {
    pub day_date: String,
    pub count: i64,
    pub amount: i64,
}

/// Everything the expenses workspace needs to describe ONE period, in one read.
///
/// # Why one payload
///
/// The KPIs, the trend, the category breakdown and the list must always describe
/// the same set of expenses. Computing them in one repository call — against one
/// shared `WHERE` clause — is what makes that structural rather than a
/// convention: there is no second window to fall out of sync, and changing the
/// period costs one round trip instead of four.
///
/// Every figure is an aggregate over the real `expenses` table. Nothing here is
/// derived from a page of rows, and nothing is invented: a period with no
/// expenses returns zeroes and two empty vectors, never `None`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExpenseOverview {
    /// `SUM(amount)` over the period, in piasters.
    pub total_amount: i64,
    pub expenses_count: i64,
    /// The part of the spend that physically left the drawer
    /// (`paid_from_cash = 1`) — the figure a closing reconciles against.
    pub cash_amount: i64,
    pub cash_count: i64,
    /// The part of the spend flagged as a repeating commitment, so an operator
    /// can see the fixed baseline separately from one-off buys.
    pub recurring_amount: i64,
    pub recurring_count: i64,
    /// The single largest expense of the period; `0` when there is none.
    pub largest_amount: i64,
    /// Integer piasters (`total / count`); `0` for an empty period.
    pub average_amount: i64,
    /// Largest amount first, so the ranking is the report's ranking.
    pub categories: Vec<ExpenseCategoryTotal>,
    /// Oldest day first — the order a time axis needs.
    pub days: Vec<ExpenseDayTotal>,
}

/// One `YYYY-MM` × category cell of the monthly comparison.
///
/// The `month` key is the STABLE `YYYY-MM` form produced by SQLite, never a
/// display name: grouping by it is what keeps January 2025 and January 2026 in
/// two different buckets instead of merging them into one "يناير". `category` is
/// the domain code (the `expense_categories.code` key), never the Arabic label,
/// so the identity of a series never depends on a localizable string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseMonthRow {
    /// `YYYY-MM`, the grouping key and the chart's category identity.
    pub month: String,
    /// The domain category code — the stable series key.
    pub category: String,
    /// The Arabic label resolved from `expense_categories`, for display only.
    pub category_name: String,
    /// Expenses recorded in that month under that category.
    pub count: i64,
    /// `SUM(amount)` in piasters.
    pub amount: i64,
}

/// Spend aggregated by calendar month AND by expense category.
///
/// Deliberately NOT built on the page's period: this report is a monthly series
/// over the window configured in Dev Settings, so it can never be narrowed by
/// the Expenses page's own date range picker — exactly like the sales monthly
/// report it parallels.
///
/// The month spine is the `business_days` table, the same one the sales monthly
/// report uses: a month that has a business day but no expense is KEPT as a
/// zero cell, so a quiet month reads as zero instead of vanishing from the
/// series. A month with no business day at all is not a trading month and is
/// correctly absent.
///
/// Rows come back ascending by `month`, so the latest month is always last.
pub fn monthly(conn: &Db, from: &str, to: &str) -> AppResult<Vec<ExpenseMonthRow>> {
    let mut stmt = conn.prepare(
        "WITH spine AS (
             SELECT DISTINCT strftime('%Y-%m', d.day_date) AS month
             FROM business_days d
             WHERE d.day_date >= ?1 AND d.day_date <= ?2
         )
         SELECT spine.month, COALESCE(e.category, ''), COALESCE(SUM(e.amount), 0),
                COUNT(e.id), COALESCE(c.name_ar, '')
         FROM spine
         LEFT JOIN expenses e
           ON strftime('%Y-%m', e.expense_date) = spine.month
          AND e.expense_date >= ?1 AND e.expense_date <= ?2
         LEFT JOIN expense_categories c ON c.code = e.category
         GROUP BY spine.month, e.category
         ORDER BY spine.month, e.category",
    )?;
    let rows = stmt.query_map(rusqlite::params![from, to], |r| {
        let category: String = r.get(1)?;
        let name: String = r.get(4)?;
        Ok(ExpenseMonthRow {
            month: r.get(0)?,
            // A month with no expense at all arrives as one row with no
            // category: the marker that keeps the month in the series.
            category: category.clone(),
            category_name: if category.is_empty() {
                String::new()
            } else if name.is_empty() {
                // A hard-deleted category still prints something honest, exactly
                // like its row in the list beside it.
                category
            } else {
                name
            },
            amount: r.get(2)?,
            count: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// One expense category as a chart series.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseMonthlyCategory {
    /// The domain code — the stable series key.
    pub code: String,
    /// The Arabic label from the category table.
    pub name_ar: String,
    /// `SUM(amount)` for the whole window, used to order the series.
    pub total: i64,
}

/// One calendar month of the monthly expenses comparison, plus its series.
///
/// The `categories` list is the report's own statement of WHICH series exist:
/// the real `expense_categories` rows that carry spend inside the window. The
/// chart plots from it, so the series are always derived from the domain and
/// never from a hardcoded list in the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExpenseMonthlyReport {
    /// `YYYY-MM` × category cells, ascending by month.
    pub months: Vec<ExpenseMonthRow>,
    /// The categories carrying spend, largest total first.
    pub categories: Vec<ExpenseMonthlyCategory>,
}

/// The monthly series AND the calendar window it describes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpenseMonthlyWindow {
    pub from: String,
    pub to: String,
    pub report: ExpenseMonthlyReport,
}

/// The monthly expense aggregation for one explicit window.
///
/// The series are derived from the data: every category that carries spend,
/// ordered by what it cost over the window so the busiest category leads, with
/// the stable code breaking ties. A category with no spend inside the window is
/// not a series — a flat zero bar would say nothing.
pub fn monthly_report(conn: &Db, from: &str, to: &str) -> AppResult<ExpenseMonthlyReport> {
    let rows = monthly(conn, from, to)?;
    let mut totals: Vec<(String, String, i64)> = Vec::new();
    for row in &rows {
        if row.category.is_empty() {
            continue;
        }
        match totals.iter_mut().find(|(code, _, _)| *code == row.category) {
            Some((_, name, total)) => {
                *total += row.amount;
                if name.is_empty() {
                    *name = row.category_name.clone();
                }
            }
            None => totals.push((row.category.clone(), row.category_name.clone(), row.amount)),
        }
    }
    totals.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));
    let categories = totals
        .into_iter()
        .map(|(code, name_ar, total)| ExpenseMonthlyCategory {
            code,
            name_ar,
            total,
        })
        .collect();
    Ok(ExpenseMonthlyReport {
        months: rows,
        categories,
    })
}

/// The shared filter every analytics query below uses.
///
/// Written once so the totals, the category ranking and the daily trend can
/// never describe different windows, and so the window matches [`list`] and
/// [`total`] exactly: the same inclusive business-date bounds.
fn scoped_where(from: Option<&str>, to: Option<&str>) -> (String, Vec<String>) {
    let mut sql = String::from(" WHERE 1=1");
    let mut args: Vec<String> = Vec::new();
    if let Some(f) = from {
        args.push(f.to_string());
        sql.push_str(&format!(" AND e.expense_date >= ?{}", args.len()));
    }
    if let Some(t) = to {
        args.push(t.to_string());
        sql.push_str(&format!(" AND e.expense_date <= ?{}", args.len()));
    }
    (sql, args)
}

fn refs(args: &[String]) -> Vec<&dyn rusqlite::ToSql> {
    args.iter().map(|s| s as &dyn rusqlite::ToSql).collect()
}

/// Aggregate one period of expenses. Three grouped SQL passes over the SAME
/// filter: the KPIs, the category ranking and the daily trend.
///
/// The label of a category is read from `expense_categories` through
/// [`category_name`], which falls back to the raw code — so an expense whose
/// category was hard-deleted still appears, labelled honestly, exactly like its
/// row in the list beside it.
pub fn overview(conn: &Db, from: Option<&str>, to: Option<&str>) -> AppResult<ExpenseOverview> {
    let (filter, args) = scoped_where(from, to);
    let bound = refs(&args);

    // Integer arithmetic only: money is ALWAYS piasters, never a float, so the
    // average is a truncated piaster figure and never 12.4999999.
    let totals: (i64, i64, i64, i64, i64, i64, i64, i64) = conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(e.amount), 0),
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN e.paid_from_cash = 1 THEN e.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN e.paid_from_cash = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN e.is_recurring = 1 THEN e.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN e.is_recurring = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(MAX(e.amount), 0),
                    CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(e.amount), 0) / COUNT(*) ELSE 0 END
             FROM expenses e{filter}"
        ),
        bound.as_slice(),
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        },
    )?;

    let mut category_stmt = conn.prepare(&format!(
        "SELECT e.category, COUNT(*), COALESCE(SUM(e.amount), 0)
         FROM expenses e{filter}
         GROUP BY e.category
         ORDER BY 3 DESC, e.category"
    ))?;
    let grouped = category_stmt
        .query_map(bound.as_slice(), |r| {
            let code: String = r.get(0)?;
            Ok((code, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(category_stmt);
    let categories = grouped
        .into_iter()
        .map(|(category, count, amount)| ExpenseCategoryTotal {
            category_name: category_name(conn, &category).unwrap_or_else(|_| category.clone()),
            // Integer math against the period total already computed above. A
            // zero total is a real state (an empty period), never a divide-by-zero.
            share: if totals.0 > 0 {
                (amount * 100).div_euclid(totals.0)
            } else {
                0
            },
            category,
            count,
            amount,
        })
        .collect();

    let mut day_stmt = conn.prepare(&format!(
        "SELECT e.expense_date, COUNT(*), COALESCE(SUM(e.amount), 0)
         FROM expenses e{filter}
         GROUP BY e.expense_date
         ORDER BY e.expense_date"
    ))?;
    let days = day_stmt
        .query_map(bound.as_slice(), |r| {
            Ok(ExpenseDayTotal {
                day_date: r.get(0)?,
                count: r.get(1)?,
                amount: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ExpenseOverview {
        total_amount: totals.0,
        expenses_count: totals.1,
        cash_amount: totals.2,
        cash_count: totals.3,
        recurring_amount: totals.4,
        recurring_count: totals.5,
        largest_amount: totals.6,
        average_amount: totals.7,
        categories,
        days,
    })
}
