import { isoDate } from "../../core/dates.ts";
import { NotFoundError } from "../../core/errors.ts";
import type { ReportStore } from "../../domain/reports/ReportRepository.ts";
import { stripGenericSections } from "../../domain/reports/reportRevision.ts";
import type { Tool } from "../Tool.ts";

export interface PastReportResult {
  id: string;
  date: string;
  topics: string[];
  markdown: string;
  sources: Array<{ title: string; url: string }>;
}

/**
 * Lets the research agent open one earlier briefing in full after finding it
 * with the past_reports search, so it can reference exactly what was reported
 * on a topic instead of guessing from an excerpt.
 */
export class ReportGetTool implements Tool<PastReportResult> {
  readonly name = "past_report";
  readonly description =
    "Get one earlier briefing in full by id: the complete text, its topics, date and sources. Use past_reports first to search earlier reports by topic and get an id.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Report id from a past_reports result.",
      },
    },
    required: ["id"],
  };

  constructor(private readonly reports: ReportStore) {}

  async execute(args: Record<string, unknown>): Promise<PastReportResult> {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) throw new Error("`id` is required");

    let report;
    try {
      report = this.reports.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new Error(`No earlier report with id "${id}"`);
      throw error;
    }

    return {
      id: report.id,
      date: isoDate(report.createdAt),
      topics: report.topics,
      markdown: stripGenericSections(report.markdown),
      sources: report.sources.map((source) => ({ title: source.title, url: source.url })),
    };
  }
}
