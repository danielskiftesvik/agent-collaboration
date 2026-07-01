export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD"];

export function isSupported(code) {
  return SUPPORTED_CURRENCIES.includes(code);
}
