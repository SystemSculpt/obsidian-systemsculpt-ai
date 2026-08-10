export type LocalToolFailure = Readonly<{
  location: string;
  message: string;
}>;

export type LocalToolOutcomeSchema = "results" | "files" | "open";

export type LocalToolOutcomeAnalysis = Readonly<{
  completed: number;
  failures: readonly LocalToolFailure[];
}>;

const RESULT_BATCH_TOOLS: ReadonlySet<string> = new Set([
  "create_folders",
  "list_items",
  "move",
  "trash",
  "context",
  "multi_edit",
]);

export function localToolOutcomeSchema(
  canonicalName: string,
): LocalToolOutcomeSchema | null {
  if (canonicalName === "read") return "files";
  if (canonicalName === "open") return "open";
  return RESULT_BATCH_TOOLS.has(canonicalName) ? "results" : null;
}

export function localToolFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  if (record.error && typeof record.error === "object") {
    const nestedMessage = (record.error as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }
  if (record.success === false) return "Operation reported failure.";
  return null;
}

export function analyzeLocalToolOutcome(
  data: unknown,
  schema?: LocalToolOutcomeSchema,
): LocalToolOutcomeAnalysis {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { completed: 0, failures: [] };
  }
  const record = data as Record<string, unknown>;
  const failures: LocalToolFailure[] = [];
  let completed = 0;

  const inspectEntries = (key: "results" | "files"): void => {
    const entries = record[key];
    if (!Array.isArray(entries)) return;
    entries.forEach((entry, index) => {
      const failureMessage = localToolFailureMessage(entry);
      if (failureMessage) {
        const item = entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : {};
        const identity = item.path ?? item.source ?? item.file ?? index;
        failures.push({ location: `${key}[${String(identity)}]`, message: failureMessage });
      } else {
        completed += 1;
      }
    });
  };

  if (schema === undefined || schema === "results") inspectEntries("results");
  if (schema === undefined || schema === "files") inspectEntries("files");
  if (schema === undefined || schema === "open") {
    if (Array.isArray(record.opened)) {
      completed += record.opened.filter((entry) =>
        typeof entry === "string" && entry.trim().length > 0
      ).length;
    }
    if (Array.isArray(record.errors)) {
      record.errors.forEach((error, index) => {
        const message = typeof error === "string"
          ? error.trim()
          : localToolFailureMessage(error);
        if (message) failures.push({ location: `errors[${index}]`, message });
      });
    }
  }

  return { completed, failures };
}

export function countLocalToolOutcome(
  data: unknown,
  schema: LocalToolOutcomeSchema | null,
): Readonly<{ completed: number; failed: number }> {
  if (!schema) return { completed: 0, failed: 0 };
  const analysis = analyzeLocalToolOutcome(data, schema);
  return { completed: analysis.completed, failed: analysis.failures.length };
}
