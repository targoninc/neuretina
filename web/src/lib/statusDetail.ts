/** A report-text revision a workflow step made, rendered as a diff. */
export interface ReportRevision {
  before: string;
  after: string;
}

/** Parsed entry detail: tool I/O (`{ input, output | error }`) or a report diff. */
export interface ToolDetail {
  input?: unknown;
  output?: unknown;
  error?: string;
  reportDiff?: ReportRevision;
}

/** Tool entries store `{ input, output|error }`; report revisions `{ reportDiff }`. */
export function parseToolDetail(detail: string | undefined): ToolDetail | null {
  if (!detail || !detail.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const hasReportDiff = typeof parsed.reportDiff === "object" && parsed.reportDiff !== null;
    if ("input" in parsed || "output" in parsed || "error" in parsed || hasReportDiff) {
      return parsed as ToolDetail;
    }
    return null;
  } catch {
    return null;
  }
}

/** The report revision in a parsed detail, when the entry carries one. */
export function reportRevision(detail: ToolDetail | null): ReportRevision | null {
  const value = detail?.reportDiff;
  if (!value || typeof value !== "object") return null;
  const before = typeof value.before === "string" ? value.before : "";
  const after = typeof value.after === "string" ? value.after : "";
  return before === after ? null : { before, after };
}

/** The code-mode program inside a `run_code` input, when present. */
export function codeOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const code = (input as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The tool input without the code, so it is not shown twice. */
export function restOfInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const { code: _code, ...rest } = input as Record<string, unknown>;
  return rest;
}

/** Pretty text for an arbitrary detail value. */
export function formatStatusValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Compact USD formatting for feed rows. */
export function formatStatusCost(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}
