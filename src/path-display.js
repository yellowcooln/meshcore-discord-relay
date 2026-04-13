export function normalizeRoutePath(path) {
  if (!Array.isArray(path)) {
    return [];
  }

  return path
    .map((hop) => String(hop || '').trim().toLowerCase())
    .filter((hop) => /^[0-9a-f]{2}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$/.test(hop));
}

export function formatPathSuffix(path, enabled = false, maxObservers = 8) {
  if (!enabled || !Array.isArray(path) || path.length === 0) {
    return '';
  }

  const shown = path.slice(0, Math.max(1, maxObservers));
  const hiddenCount = path.length - shown.length;
  const formatted = shown.map((hop) => {
    const value = /^[0-9a-f]{2}$/i.test(hop) || /^[0-9a-f]{4}$/i.test(hop) || /^[0-9a-f]{6}$/i.test(hop)
      ? hop.toUpperCase()
      : hop;
    return `\`${String(value).replace(/`/g, '\\`')}\``;
  });

  return `[${formatted.join(',')}${hiddenCount > 0 ? `,+${hiddenCount}` : ''}]`;
}
