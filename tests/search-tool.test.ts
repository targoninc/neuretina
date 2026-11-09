import { describe, expect, test } from "bun:test";
import { SearchTool } from "../src/agents/tools/SearchTool.ts";
import type { SearchProvider, SearchQuery } from "../src/capabilities/search/SearchProvider.ts";

function recordingProvider(): { provider: SearchProvider; queries: SearchQuery[] } {
  const queries: SearchQuery[] = [];
  return {
    queries,
    provider: {
      name: "perplexity",
      kind: "web",
      search: async (query) => {
        queries.push(query);
        return { query: query.query, provider: "perplexity", kind: "web", results: [] };
      },
    },
  };
}

function schemaProperties(tool: SearchTool): Record<string, unknown> {
  return tool.parameters.properties as Record<string, unknown>;
}

describe("SearchTool domain allowlist", () => {
  test("passes the reputable domains by default", async () => {
    const { provider, queries } = recordingProvider();
    const tool = new SearchTool({ provider, domains: ["wikipedia.org", "reuters.com"] });

    await tool.execute({ query: "climate policy" });

    expect(queries[0]?.domains).toEqual(["wikipedia.org", "reuters.com"]);
    expect(schemaProperties(tool).scope).toBeDefined();
    expect(tool.description).toContain("reputable");
  });

  test("scope open searches without the allowlist", async () => {
    const { provider, queries } = recordingProvider();
    const tool = new SearchTool({ provider, domains: ["wikipedia.org"] });

    await tool.execute({ query: "rust release notes", scope: "open" });

    expect(queries[0]?.domains).toBeUndefined();
  });

  test("no domains configured means no filter and no scope parameter", async () => {
    const { provider, queries } = recordingProvider();
    const tool = new SearchTool({ provider, domains: [] });

    await tool.execute({ query: "x", scope: "open" });

    expect(queries[0]?.domains).toBeUndefined();
    expect(schemaProperties(tool).scope).toBeUndefined();
    expect(tool.description).not.toContain("reputable");
  });

  test("applies the default recency and language to every query", async () => {
    const { provider, queries } = recordingProvider();
    const tool = new SearchTool({ provider, defaultRecency: "3days", defaultLanguage: "en" });

    await tool.execute({ query: "x" });

    expect(queries[0]?.recency).toBe("3days");
    expect(queries[0]?.language).toBe("en");
  });
});

describe("SearchTool fallback", () => {
  test("uses the fallback provider when the primary fails", async () => {
    const fallbackQueries: SearchQuery[] = [];
    const primary: SearchProvider = {
      name: "perplexity",
      kind: "web",
      search: async () => {
        throw new Error("provider down");
      },
    };
    const fallback: SearchProvider = {
      name: "news",
      kind: "news",
      search: async (query) => {
        fallbackQueries.push(query);
        return {
          query: query.query,
          provider: "news",
          kind: "news",
          results: [
            {
              title: "Fallback story",
              url: "https://news.example.com/story",
              snippet: "read",
              source: "news.example.com",
            },
          ],
        };
      },
    };
    const tool = new SearchTool({ provider: primary, fallback, domains: ["news.example.com"] });

    const response = await tool.execute({ query: "x" });

    expect(response.provider).toBe("news");
    expect(response.results[0]?.title).toBe("Fallback story");
    expect(fallbackQueries[0]?.domains).toEqual(["news.example.com"]);
    expect(tool.description).toContain("recent news coverage");
  });

  test("reports both failures when the fallback also fails", async () => {
    const failing = (name: string, error: string): SearchProvider => ({
      name,
      kind: name === "news" ? "news" : "web",
      search: async () => {
        throw new Error(error);
      },
    });
    const tool = new SearchTool({
      provider: failing("perplexity", "primary down"),
      fallback: failing("news", "fallback down"),
    });

    await expect(tool.execute({ query: "x" })).rejects.toThrow(
      /perplexity search failed.*primary down.*news fallback failed.*fallback down/,
    );
  });
});
