/**
 * Customer phone export builders — CSV and VCF for owner-controlled
 * communication workflows.
 *
 * The rows arrive from the MANAGER-gated `export_customer_phones` command
 * already ordered (`name, id`) and deduplicated by normalized `phone_key`,
 * so these builders own only the FILE encoding, never the data rules:
 *  - CSV: UTF-8 with BOM (so Excel opens Arabic/phones correctly), a single
 *    `phone` column, RFC-4180 escaping, and formula-injection guarding.
 *  - VCF: vCard 3.0 (the safest choice for modern Android/iPhone contacts
 *    apps — 4.0 support is still uneven on older handsets), CRLF line
 *    endings, backslash escaping of `\\`, `;`, `,` and newlines, UTF-8 names.
 */

export interface CustomerPhoneEntry {
  id: number
  name: string
  phone: string
}

/** Export file format. The extension/MIME is derived, never chosen by hand. */
export type CustomerPhoneFormat = 'csv' | 'vcf'

/** The single exported column — identity only, no financial metadata. */
export const CUSTOMER_PHONE_CSV_HEADER = 'phone'

const CSV_MIME = 'text/csv;charset=utf-8'
const VCF_MIME = 'text/vcard;charset=utf-8'

/**
 * Guard a CSV field against formula injection: a value starting with
 * `=`, `+`, `-` or `@` (after trim) is prefixed with a single quote so a
 * spreadsheet opens it as text rather than executing it. Phone numbers are
 * the common trigger (`+2010…`).
 */
export function guardCsvField(value: string): string {
  const text = value.trim()
  if (/^[=+\-@]/.test(text)) return `'${value}`
  // A tab/comma variant of the same attack after the quote is stripped.
  if (/^[\t,;]/.test(value)) return `'${value}`
  return value
}

/** RFC-4180 field escaping: quote when needed, double inner quotes. */
export function escapeCsvField(value: string): string {
  const guarded = guardCsvField(value)
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}

/**
 * Build the CSV payload: BOM + `phone` header + one phone per line.
 * CRLF keeps Excel and mobile sheet apps happy; LF alone mis-renders rows
 * in legacy Excel.
 */
export function buildCustomerPhonesCsv(entries: readonly CustomerPhoneEntry[]): string {
  const lines = [CUSTOMER_PHONE_CSV_HEADER]
  for (const entry of entries) lines.push(escapeCsvField(entry.phone.trim()))
  return `﻿${lines.join('\r\n')}\r\n`
}

/** Escape vCard 3.0 TEXT special characters (`\\`, `;`, `,`, newlines). */
export function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

/**
 * Build the VCF payload: one vCard 3.0 contact per entry, CRLF-separated.
 * `FN` carries the Arabic display name verbatim (UTF-8); `TEL;TYPE=CELL`
 * carries the raw stored phone. Deterministic: input order is preserved.
 */
export function buildCustomerPhonesVcf(entries: readonly CustomerPhoneEntry[]): string {
  return entries
    .map((entry) =>
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeVCardText(entry.name.trim() || entry.phone.trim())}`,
        `TEL;TYPE=CELL:${escapeVCardText(entry.phone.trim())}`,
        'END:VCARD',
      ].join('\r\n'),
    )
    .join('\r\n')
}

/** `station-customer-phones-YYYY-MM-DD.csv` (business wall-clock date). */
export function customerPhonesFilename(format: CustomerPhoneFormat, dateStamp: string): string {
  return format === 'csv'
    ? `station-customer-phones-${dateStamp}.csv`
    : `station-customer-contacts-${dateStamp}.vcf`
}

export function customerPhonesMime(format: CustomerPhoneFormat): string {
  return format === 'csv' ? CSV_MIME : VCF_MIME
}

export function buildCustomerPhonesFile(
  entries: readonly CustomerPhoneEntry[],
  format: CustomerPhoneFormat,
): { blob: Blob; filename: string } {
  const stamp = new Date().toISOString().slice(0, 10)
  const content =
    format === 'csv' ? buildCustomerPhonesCsv(entries) : buildCustomerPhonesVcf(entries)
  return {
    blob: new Blob([content], { type: customerPhonesMime(format) }),
    filename: customerPhonesFilename(format, stamp),
  }
}
