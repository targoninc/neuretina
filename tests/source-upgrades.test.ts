import { describe, expect, test } from "bun:test";
import type { ReportSource } from "../src/domain/reports/ReportRepository.ts";
import {
  MAX_SOURCE_UPGRADES,
  applySourceUpgrades,
  parseSourceUpgrades,
} from "../src/workflows/SourceUpgrades.ts";
import { isAcceptableRevision } from "../src/domain/reports/reportRevision.ts";

describe("parseSourceUpgrades", () => {
  test("parses markdown and upgrades", () => {
    const parsed = parseSourceUpgrades(
      JSON.stringify({
        markdown: "# Report [1]",
        upgrades: [{ for: 2, title: "Official", url: "https://origin.example.com/a" }],
      }),
      2,
    );

    expect(parsed?.markdown).toBe("# Report [1]");
    expect(parsed?.upgrades).toEqual([
      { for: 2, title: "Official", url: "https://origin.example.com/a" },
    ]);
  });

  test("drops invalid upgrades and falls back to the url as title", () => {
    const parsed = parseSourceUpgrades(
      JSON.stringify({
        markdown: "# Report [1]",
        upgrades: [
          { for: 0, title: "Zero", url: "https://x.example/a" },
          { for: 9, title: "Out of range", url: "https://x.example/b" },
          { for: 1, title: "", url: "https://x.example/c" },
          { for: 1, title: "No url", url: "ftp://x.example/d" },
          { for: 1, title: 42, url: "not a url" },
        ],
      }),
      2,
    );

    expect(parsed?.upgrades).toEqual([
      { for: 1, title: "https://x.example/c", url: "https://x.example/c" },
    ]);
  });

  test("caps the number of upgrades", () => {
    const upgrades = Array.from({ length: MAX_SOURCE_UPGRADES + 3 }, (_, index) => ({
      for: 1,
      title: `T${index}`,
      url: `https://x.example/${index}`,
    }));

    const parsed = parseSourceUpgrades(JSON.stringify({ markdown: "# B [1]", upgrades }), 5);
    expect(parsed?.upgrades).toHaveLength(MAX_SOURCE_UPGRADES);
  });

  test("returns undefined when nothing usable came back", () => {
    expect(parseSourceUpgrades("no json here", 2)).toBeUndefined();
    expect(
      parseSourceUpgrades(JSON.stringify({ markdown: "", upgrades: [] }), 2),
    ).toBeUndefined();
  });
});

describe("applySourceUpgrades", () => {
  const sources: ReportSource[] = [
    {
      title: "Coverage",
      url: "https://news.example.org/a",
      provider: "perplexity",
      snippet: "old text",
    },
    { title: "Other", url: "https://example.com/b", provider: "perplexity" },
  ];

  test("replaces the source and keeps search metadata", () => {
    const found: ReportSource[] = [
      {
        title: "Official announcement",
        url: "https://origin.example.com/a",
        provider: "perplexity",
        snippet: "the announcement text",
      },
    ];
    const next = applySourceUpgrades(
      sources,
      [{ for: 1, title: "Origin: released", url: "https://origin.example.com/a" }],
      found,
    );

    expect(next[0]).toEqual({
      title: "Origin: released",
      url: "https://origin.example.com/a",
      provider: "perplexity",
      snippet: "the announcement text",
    });
    expect(next[1]).toBe(sources[1]);
    expect(sources[0]?.url).toBe("https://news.example.org/a");
  });

  test("drops stale snippet and media when the url was not in the search results", () => {
    const old: ReportSource[] = [
      {
        title: "Coverage",
        url: "https://news.example.org/a",
        provider: "perplexity",
        snippet: "old",
        media: [
          {
            type: "image",
            thumbUrl: "https://cdn.example/t.jpg",
            fullUrl: "https://cdn.example/f.jpg",
          },
        ],
      },
    ];
    const next = applySourceUpgrades(
      old,
      [{ for: 1, title: "Official", url: "https://origin.example.com/a" }],
      [],
    );

    expect(next[0]).toEqual({
      title: "Official",
      url: "https://origin.example.com/a",
      provider: "perplexity",
    });
  });
});

describe("isAcceptableRevision", () => {
  const original =
    "# Morning report\n\n## Rust\nAll quiet [1]. Adoption keeps accelerating [1].";

  test("accepts a faithful revision", () => {
    const revised =
      "# Morning report\n\n## Rust\nRust 1.90 shipped [1]. Adoption keeps accelerating [1].";
    expect(isAcceptableRevision(original, revised, 2)).toBe(true);
  });

  test("accepts a report without a separate section", () => {
    const revised = "# Morning report\n\n## Rust\nAll quiet [1].";
    expect(isAcceptableRevision(original, revised, 2)).toBe(true);
  });

  test("rejects empty, drastically shorter or longer rewrites", () => {
    expect(isAcceptableRevision(original, "", 2)).toBe(false);
    expect(isAcceptableRevision(original, "# Rewritten\n\nNope.", 2)).toBe(false);
    const filler = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
    expect(isAcceptableRevision(original, `# Rewritten\n\n${filler}`, 2)).toBe(false);
  });

  test("honors an absolute word ceiling", () => {
    const revised =
      "# Morning report\n\n## Rust\nRust 1.90 shipped with faster builds and new features [1].";
    expect(isAcceptableRevision(original, revised, 2, { maxWords: 8 })).toBe(false);
  });

  test("rejects unknown citation numbers", () => {
    const badMarker =
      "# Morning report\n\n## Rust\nAll quiet [9]. Adoption keeps accelerating [1].";
    expect(isAcceptableRevision(original, badMarker, 2)).toBe(false);
  });
});
