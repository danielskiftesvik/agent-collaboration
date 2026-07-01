export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY"];

export function isSupported(code) {
  return SUPPORTED_CURRENCIES.includes(code);
}
