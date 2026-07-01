// Parses a URL query string (without leading "?") into a plain object.
// - Keys/values are separated by "="
// - Pairs are separated by "&"
// - Both keys and values must be URI-decoded
// - A key with no "=" (e.g. "flag") maps to the string "true"
// - An empty string input returns an empty object
export function parseQueryString(str) {
  throw new Error("not implemented");
}
