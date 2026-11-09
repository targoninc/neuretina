import { describe, expect, test } from "bun:test";
import { ReportGetTool } from "../src/agents/tools/ReportGetTool.ts";
import { ReportSearchTool } from "../src/agents/tools/ReportSearchTool.ts";
import { ArtifactRepository } from "../src/domain/artifacts/ArtifactRepository.ts";
import { ReportRepository } from "../src/domain/reports/ReportRepository.ts";
import { SqliteDatabase } from "../src/infra/db/SqliteDatabase.ts";

function setup(): ReportRepository {
  const db = new SqliteDatabase(":memory:");
  const reports = new ReportRepository(new ArtifactRepository(db));
  reports.create({
    topics: ["Rust"],
    markdown: "Rust 1.90 shipped with async closures.",
    narration: "",
    sources: [
      { title: "Rust blog", url: "https://blog.rust-lang.org/1.90", provider: "perplexity" },
    ],
  });
  reports.create({
    topics: ["AI regulation"],
    markdown: "The EU delayed its AI Act guidance.",
    narration: "",
    sources: [],
  });
  return reports;
}

describe("past report tools", () => {
  test("past_reports searches by topic and returns ids", async () => {
    const tool = new ReportSearchTool(setup());

    const result = await tool.execute({ query: "Rust" });

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.topics).toEqual(["Rust"]);
    expect(result.reports[0]?.excerpt).toContain("async closures");
    expect(result.reports[0]?.id).toBeTruthy();
  });

  test("past_reports matches multi-word queries across topics and text", async () => {
    const tool = new ReportSearchTool(setup());

    const result = await tool.execute({
      query: "geopolitics Rust supply chain AI regulation",
      limit: 8,
    });

    // Both reports match at least one term; the AI report matches more.
    expect(result.reports.map((report) => report.topics[0])).toEqual([
      "AI regulation",
      "Rust",
    ]);

    const none = await tool.execute({ query: "sports scores" });
    expect(none.reports).toEqual([]);
    expect(none.note).toContain("No earlier reports match");
  });

  test("past_report opens one report in full with its sources", async () => {
    const reports = setup();
    const found = await new ReportSearchTool(reports).execute({ query: "Rust" });
    const id = found.reports[0]!.id;

    const report = await new ReportGetTool(reports).execute({ id });

    expect(report.id).toBe(id);
    expect(report.topics).toEqual(["Rust"]);
    expect(report.markdown).toContain("async closures");
    expect(report.sources[0]?.url).toBe("https://blog.rust-lang.org/1.90");
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("past_report rejects unknown ids and missing arguments", async () => {
    const tool = new ReportGetTool(setup());

    await expect(tool.execute({ id: "missing" })).rejects.toThrow("No earlier report");
    await expect(tool.execute({})).rejects.toThrow("`id` is required");
  });

  test("hides legacy implications sections from earlier reports", async () => {
    const db = new SqliteDatabase(":memory:");
    const reports = new ReportRepository(new ArtifactRepository(db));
    reports.create({
      topics: ["Rust"],
      markdown:
        "# Morning report\n\n## Rust\nAll quiet.\n\n## Implications\nRust adoption keeps accelerating.",
      narration: "",
      sources: [],
    });

    const found = await new ReportSearchTool(reports).execute({ query: "Rust" });
    expect(found.reports[0]?.excerpt).toContain("All quiet");
    expect(found.reports[0]?.excerpt).not.toContain("## Implications");

    const report = await new ReportGetTool(reports).execute({ id: found.reports[0]!.id });
    expect(report.markdown).toContain("## Rust");
    expect(report.markdown).not.toContain("## Implications");
  });
});
