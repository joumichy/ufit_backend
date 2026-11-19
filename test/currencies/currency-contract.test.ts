import {describe, expect, it} from 'vitest';
import {CURRENCY_CODES, CURRENCY_METADATA, CURRENCY_MINOR_UNITS, CURRENCY_PRECISION_PROVENANCE,
  currencyMinorUnitDigits} from '../../src/shared/domain/currencies';

// The accepted catalogue is frozen independently from the platform's Intl data.
const acceptedCatalogue = ["AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XDR", "XOF", "XPF", "XSU", "YER", "ZAR", "ZMW", "ZWG", "ZWL"] as const;
const accountingCases = {
  CHF: 2, JPY: 0, ISK: 0, UGX: 0, HUF: 2, TWD: 2, BHD: 3, TND: 3,
  AFN: 2, ALL: 2, COP: 2, IDR: 2, IQD: 3, IRR: 2, KPW: 2, LAK: 2,
  LBP: 2, MGA: 0, MMK: 2, PKR: 2, RSD: 2, SOS: 2, SYP: 2, YER: 2,
  ANG: 2, BGN: 2, CUC: 2, HRK: 2, SLL: 2, ZWL: 2, XDR: 2, XSU: 2,
} as const;

describe('canonical currency accounting units', () => {
  it('preserves every accepted code without depending on the runtime currency list', () => {
    expect(CURRENCY_CODES).toEqual(acceptedCatalogue);
    expect(CURRENCY_CODES).toHaveLength(162);
    expect(new Set(CURRENCY_CODES).size).toBe(162);
  });
  it.each(Object.entries(accountingCases))('keeps %s accounting precision at %i independently of locale display rounding', (code, digits) => {
    expect(currencyMinorUnitDigits(code)).toBe(digits);
    expect(CURRENCY_METADATA.find(row => row.code === code)).toEqual({code, minorUnitDigits: digits});
  });
  it('exposes only canonical codes and integer accounting precision in transport metadata', () => {
    expect(CURRENCY_METADATA.map(row => row.code)).toEqual(acceptedCatalogue);
    for (const row of CURRENCY_METADATA) {
      expect(Object.keys(row)).toEqual(['code', 'minorUnitDigits']);
      expect(Number.isInteger(row.minorUnitDigits)).toBe(true);
      expect(row.minorUnitDigits).toBeGreaterThanOrEqual(0);
      expect(row.minorUnitDigits).toBeLessThanOrEqual(4);
      expect(row.minorUnitDigits).toBe(CURRENCY_MINOR_UNITS[row.code as keyof typeof CURRENCY_MINOR_UNITS]);
    }
  });
  it('documents retained catalogue precision without presenting N.A. as an ISO minor unit', () => {
    expect(CURRENCY_PRECISION_PROVENANCE.cataloguePrecision.codes).toEqual(['XDR', 'XSU']);
    expect(Object.keys(CURRENCY_PRECISION_PROVENANCE.historicalISO)).toEqual(['ANG', 'BGN', 'CUC', 'HRK', 'SLL', 'ZWL']);
    expect(CURRENCY_PRECISION_PROVENANCE.currentISO.sha256).toBe('33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff');
  });
  it('declares whole-ariary provider accounting separately from the ISO MGA minor unit', () => {
    expect(CURRENCY_PRECISION_PROVENANCE.providerAccountingPrecision).toMatchObject({MGA: {
      isoMinorUnitDigits: 2,
      accountingMinorUnitDigits: 0,
      sourceURL: 'https://docs.stripe.com/currencies#zero-decimal',
    }});
    expect(currencyMinorUnitDigits('MGA')).toBe(CURRENCY_PRECISION_PROVENANCE.providerAccountingPrecision.MGA.accountingMinorUnitDigits);
  });
  it.each(['', 'ZZZ', 'chf', ' CHF', 'constructor', 'toString', '__proto__'])('refuses an unknown canonical code %j', code => {
    expect(() => currencyMinorUnitDigits(code)).toThrow(RangeError);
  });
});
