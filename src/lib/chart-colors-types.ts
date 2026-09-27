/**
 * The shape of the centralized chart-colour configuration.
 *
 * It lives in its own tiny module so `lib/chart-colors.ts` (the roles, the CSS
 * variables, the ramp) and `lib/formatting.ts` (the one persisted settings
 * store) can both depend on it without importing each other.
 */
export const CHART_COLOR_ROLES = [
  'primary',
  'secondary',
  'tertiary',
  'quaternary',
  'sales',
  'expenses',
  // A day that carries MORE THAN ONE of the same thing: the same business, a
  // different reading of the day. It is a sibling of `expenses`, never a status
  // — a day with three expenses is a perfectly ordinary day — so it is a role of
  // its own that a developer can repaint, rather than a shade hardcoded into a
  // chart.
  'expensesMultiple',
] as const

/** A semantic bar-colour role. Semantic means "what the mark means", never
 * "which chart it is drawn in" — a future chart picks one, it does not add one. */
export type ChartColorRole = (typeof CHART_COLOR_ROLES)[number]

/** The saved chart colours: one entry per role, one entry per Dev Settings row. */
export type ChartColorSettings = Record<ChartColorRole, string>
