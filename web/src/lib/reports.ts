import type { Report } from "./api";

/**
 * The report's markdown title: its first `#` heading or bold line. Section
 * headings must never win, hence no `##` fallback.
 */
export function reportTitle(report: Pick<Report, "markdown" | "topics">): string {
  const heading = report.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const bold = report.markdown.match(/^\*\*(.+?)\*\*\s*$/m)?.[1]?.trim();
  return heading || bold || report.topics.join(", ") || "Untitled report";
}
