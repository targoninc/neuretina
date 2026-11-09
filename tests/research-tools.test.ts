import { describe, expect, test } from "bun:test";
import type { SearchProvider } from "../src/capabilities/search/SearchProvider.ts";
import type { ReportStore } from "../src/domain/reports/ReportRepository.ts";
import { createResearchTools } from "../src/workflows/researchTools.ts";

function provider(name: string, kind: SearchProvider["kind"]): SearchProvider {
  return {
    name,
    kind,
    search: async (query) => ({ query: query.query, provider: name, kind, results: [] }),
  };
}

describe("createResearchTools", () => {
  test("always includes news search and the web fetch tool", () => {
    const tools = createResearchTools(
      {
        webSearch: provider("perplexity", "web"),
        socialSearch: provider("bluesky", "social"),
        reports: {} as ReportStore,
        defaults: {
          resultsPerProvider: 5,
          recency: "day",
          language: "en",
          searchDomains: [],
        },
      },
      { contextId: "ctx" },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "search.perplexity",
      "search.news",
      "web.fetch",
      "search.bluesky",
      "past_reports",
    ]);
  });
});
