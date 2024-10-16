export function prune(contentTypes: string[], result: { [contentType: string]: unknown }): { [contentType: string]: unknown } {
  return Object.fromEntries(Object.entries(result).filter(([key]) => contentTypes.includes(key)));
}