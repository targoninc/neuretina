import { describe, expect, test } from "bun:test";
import { reportTitle } from "../web/src/lib/reports.ts";

describe("reportTitle", () => {
  test("prefers the first level-1 heading", () => {
    expect(reportTitle({ markdown: "# Real title\n\nBody", topics: ["a"] })).toBe("Real title");
  });

  test("accepts a bold title line", () => {
    expect(reportTitle({ markdown: "**Briefing: bold title**\n\nBody", topics: ["a"] })).toBe(
      "Briefing: bold title",
    );
  });

  test("never mistakes a section heading for the title", () => {
    const markdown = "**Actual title**\n\nBody\n\n## Background\n\nMore";
    expect(reportTitle({ markdown, topics: ["a"] })).toBe("Actual title");
    expect(reportTitle({ markdown: "Body only\n\n## Background", topics: ["a", "b"] })).toBe(
      "a, b",
    );
  });

  test("falls back to topics, then a placeholder", () => {
    expect(reportTitle({ markdown: "", topics: ["a", "b"] })).toBe("a, b");
    expect(reportTitle({ markdown: "", topics: [] })).toBe("Untitled report");
  });
});
