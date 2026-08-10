export const MAX_SERVER_TIMING_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

type ServerTimingOptions<Field extends string> = Readonly<{
  fields: Readonly<Record<string, Field>>;
  maximumHeaderLength: number;
  maximumEntries: number;
}>;

/** Parse only explicitly allowed, bounded Server-Timing duration fields. */
export function parseBoundedServerTiming<Field extends string>(
  header: string | null,
  options: ServerTimingOptions<Field>,
): Partial<Record<Field, number>> | undefined {
  if (!header || header.length > options.maximumHeaderLength) return undefined;
  const timing: Partial<Record<Field, number>> = {};
  for (const entry of header.split(",").slice(0, options.maximumEntries)) {
    const [rawName, ...rawParameters] = entry.split(";");
    const field = options.fields[rawName.trim().toLowerCase()];
    if (!field || timing[field] !== undefined) continue;
    const durationParameter = rawParameters.find((parameter) =>
      /^\s*dur\s*=/iu.test(parameter));
    if (!durationParameter) continue;
    const rawDuration = durationParameter.replace(/^\s*dur\s*=\s*/iu, "").trim();
    const normalizedDuration = rawDuration.startsWith('"') && rawDuration.endsWith('"')
      ? rawDuration.slice(1, -1).trim()
      : rawDuration;
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalizedDuration)) continue;
    const duration = Number(normalizedDuration);
    if (!Number.isFinite(duration) || duration > MAX_SERVER_TIMING_DURATION_MS) continue;
    timing[field] = Math.round(duration * 1_000) / 1_000;
  }
  return Object.keys(timing).length > 0 ? timing : undefined;
}
