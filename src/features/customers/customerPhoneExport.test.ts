/**
 * Customer phone export builders — pure file encoding, no IPC.
 *
 * Every case here was a real export defect class: a missing header, a raw
 * newline splitting a row, a `+20…` phone executing as a formula, an Arabic
 * name mangled or a shared phone producing two vCards.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCustomerPhonesCsv,
  buildCustomerPhonesVcf,
  customerPhonesFilename,
  escapeCsvField,
  escapeVCardText,
  guardCsvField,
  type CustomerPhoneEntry,
} from './customerPhoneExport'

function entry(over: Partial<CustomerPhoneEntry> = {}): CustomerPhoneEntry {
  return { id: 1, name: 'أحمد سيد', phone: '01001234567', ...over }
}

describe('customer phone CSV', () => {
  it('starts with a BOM + phone header so Excel reads Arabic/phones correctly', () => {
    const csv = buildCustomerPhonesCsv([entry()])
    expect(csv.startsWith('﻿phone\r\n')).toBe(true)
  })

  it('writes one phone per line with CRLF endings', () => {
    const csv = buildCustomerPhonesCsv([
      entry({ phone: '01001234567' }),
      entry({ phone: '01111111111' }),
    ])
    expect(csv).toBe('﻿phone\r\n01001234567\r\n01111111111\r\n')
  })

  it('quotes fields containing commas, quotes or newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('a\nb')).toBe('"a\nb"')
    expect(escapeCsvField('01001234567')).toBe('01001234567')
  })

  it('guards formula-injection prefixes including the + of intl numbers', () => {
    expect(guardCsvField('+201001234567')).toBe("'+201001234567")
    expect(guardCsvField('=1+1')).toBe("'=1+1")
    expect(guardCsvField('-5')).toBe("'-5")
    expect(guardCsvField('@cmd')).toBe("'@cmd")
    expect(guardCsvField('01001234567')).toBe('01001234567')
  })

  it('produces a header-only file for an empty selection', () => {
    expect(buildCustomerPhonesCsv([])).toBe('﻿phone\r\n')
  })
})

describe('customer phone VCF', () => {
  it('writes one valid vCard 3.0 block per contact with CRLF', () => {
    const vcf = buildCustomerPhonesVcf([entry()])
    expect(vcf).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:أحمد سيد\r\nTEL;TYPE=CELL:01001234567\r\nEND:VCARD',
    )
    expect(vcf).not.toContain('\n\n')
  })

  it('preserves Arabic names verbatim', () => {
    const vcf = buildCustomerPhonesVcf([entry({ name: 'محمد عبد الله' })])
    expect(vcf).toContain('FN:محمد عبد الله')
  })

  it('escapes vCard special characters in names and phones', () => {
    expect(escapeVCardText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d')
    expect(escapeVCardText('a\nb')).toBe('a\\nb')
    const vcf = buildCustomerPhonesVcf([entry({ name: 'عميل; خاص, جديد' })])
    expect(vcf).toContain('FN:عميل\\; خاص\\, جديد')
  })

  it('falls back to the phone when the name is blank', () => {
    const vcf = buildCustomerPhonesVcf([entry({ name: '   ' })])
    expect(vcf).toContain('FN:01001234567')
  })

  it('joins multiple contacts without blank-line drift', () => {
    const vcf = buildCustomerPhonesVcf([entry(), entry({ id: 2, name: 'كريم', phone: '0111' })])
    expect(vcf.split('BEGIN:VCARD')).toHaveLength(3)
    expect(vcf).not.toContain('\r\n\r\n')
  })
})

describe('customer phone filenames', () => {
  it('uses the station convention with the right extension per format', () => {
    expect(customerPhonesFilename('csv', '2026-10-05')).toBe(
      'station-customer-phones-2026-10-05.csv',
    )
    expect(customerPhonesFilename('vcf', '2026-10-05')).toBe(
      'station-customer-contacts-2026-10-05.vcf',
    )
  })
})
