export const CURRENCY_CODES = Intl.supportedValuesOf('currency');
const currencyFormatting = {locale: 'fr', style: 'currency', missingDigits: 'Missing currency minor unit digits'} as const;
export const CURRENCY_METADATA = CURRENCY_CODES.map(code => {
  const minorUnitDigits = new Intl.NumberFormat(currencyFormatting.locale,
    {style: currencyFormatting.style, currency: code}).resolvedOptions().maximumFractionDigits;
  if (minorUnitDigits === undefined) throw new Error(currencyFormatting.missingDigits);
  return {code, minorUnitDigits};
});
