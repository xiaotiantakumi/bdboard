/**
 * Memoized `Intl.DateTimeFormat` factory (bdboard-k99x).
 *
 * `new Intl.DateTimeFormat(...)` is expensive (~80µs measured — it clones ICU
 * locale data such as SimpleDateFormat/DateFormatSymbols/DecimalFormat on
 * every call) while a cached instance's `.format()`/`.formatToParts()` is
 * ~30x faster. `Intl.DateTimeFormat` instances are immutable, so sharing one
 * instance across calls with an identical `(locale, options)` pair is safe
 * and changes no observable behavior.
 *
 * Before this cache existed, `board-date-time.ts` alone constructed a new
 * formatter on every call — 170k+ constructions (~19s) for a single
 * `getThroughputStats` request with a few thousand tickets over 8 weeks,
 * because week-boundary math re-derives calendar days for every
 * ticket/week pair. See bdboard-k99x / bdboard-himp for the profiling data.
 *
 * Cache key: `locale` plus the option entries sorted by key (not by
 * insertion order, so call sites that build the options object with keys in
 * a different order still hit the same cache entry) and JSON-serialized.
 * `undefined`-valued entries are dropped first so `{ foo: undefined }` and
 * `{}` key identically, matching how `Intl.DateTimeFormat` itself treats
 * them.
 *
 * Cache size stays bounded in practice: one entry per distinct
 * `(locale, options)` pair the process actually uses. Call sites pass a
 * small number of hard-coded option shapes (single digits, across
 * board-date-time.ts / defer.ts / hygiene/shared.ts), and `timeZone` is one
 * of a bounded set of IANA zones (board config can change it at runtime, but
 * still from that same bounded set). So the map holds at most
 * `(distinct timeZones seen) x (distinct option shapes)` entries — never
 * proportional to ticket or request count.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function buildCacheKey(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const sortedEntries = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${locale}\0${JSON.stringify(sortedEntries)}`;
}

/**
 * Returns a shared `Intl.DateTimeFormat` for the given `(locale, options)`,
 * constructing it once and reusing it for every subsequent call with an
 * equivalent (not necessarily identical-by-reference) `options` object.
 */
export function getCachedDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = buildCacheKey(locale, options);
  const cached = formatterCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(key, formatter);
  return formatter;
}
