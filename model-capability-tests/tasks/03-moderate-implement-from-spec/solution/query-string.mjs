export function parseQueryString(str) {
  if (!str) return {};
  const result = {};
  for (const pair of str.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      result[decodeURIComponent(pair)] = "true";
    } else {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1));
      result[key] = value;
    }
  }
  return result;
}
