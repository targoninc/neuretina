import { isoDate } from "../../core/dates.ts";
import type { ReportStore } from "../../domain/reports/ReportRepository.ts";
import { stripGenericSections } from "../../domain/reports/reportRevision.ts";
import type { Tool } from "../Tool.ts";

export interface PastReportsResult {
  reports: Array<{
    id: string;
    date: string;
    topics: string[];
    excerpt: string;
  }>;
  note?: string;
}

/**
 * Lets the research agent look up earlier briefings, so it can build on what
 * was already covered instead of repeating it.
 */
export class ReportSearchTool implements Tool<PastReportsResult> {
  readonly name = "past_reports";
  readonly description =
    "Search earlier briefing summaries by topic or keyword. Use this to see what was already covered and what has changed since, so your notes build on prior coverage instead of repeating it. Each result carries an id you can open in full with past_report.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to search in earlier reports. Omit to get the most recent reports.",
      },
      limit: {
        type: "integer",
        description: "How many earlier reports to return (default 3, max 10).",
        minimum: 1,
        maximum: 10,
      },
    },
    required: [],
  };

  constructor(
    private readonly reports: ReportStore,
    /** Only search reports from this context. */
    private readonly contextId?: string,
  ) {}

  async execute(args: Record<string, unknown>): Promise<PastReportsResult> {
    const query = typeof args.query === "string" ? args.query.trim() : undefined;
    const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.floor(args.limit), 1), 10) : 3;

    const found = this.reports.search(query || undefined, limit, this.contextId);
    if (found.length === 0) {
      return {
        reports: [],
        note: query
          ? `No earlier reports match "${query}".`
          : "No earlier reports are stored yet.",
      };
    }

    return {
      reports: found.map((report) => ({
        id: report.id,
        date: isoDate(report.createdAt),
        topics: report.topics,
        excerpt: stripGenericSections(report.markdown).slice(0, 800),
      })),
    };
  }
}
