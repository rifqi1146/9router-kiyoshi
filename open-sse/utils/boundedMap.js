// Module-level caches keyed by rotating credentials (access tokens) grow forever
// unless bounded; evicting the oldest key is enough because a rotated token is
// never read again.
export function setBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

export function pruneExpired(map, now = Date.now()) {
  for (const [key, value] of map) {
    const expiresAt = value?.expiresAt;
    if (typeof expiresAt === "number" && expiresAt <= now) map.delete(key);
  }
}
