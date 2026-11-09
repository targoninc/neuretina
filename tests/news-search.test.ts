import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NewsSearchProvider } from "../src/providers/search/NewsSearchProvider.ts";

const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => {
  fetchSpy.mockReset();
});

function mockFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  fetchSpy.mockImplementation(implementation as unknown as typeof fetch);
}

function bingRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function googleRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:news="https://news.google.com/rss"><channel>${items}</channel></rss>`;
}

describe("NewsSearchProvider", () => {
  test("parses Bing news RSS and resolves direct article URLs", async () => {
    mockFetch(async () =>
      new Response(
        bingRss(`
          <item>
            <title>Rust 1.90 released</title>
            <link>https://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fwww.reuters.com%2ftechnology%2frust-1-90&amp;c=1</link>
            <description>Rust &amp; friends shipped a new release.</description>
            <pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate>
          </item>`),
      ),
    );

    const provider = new NewsSearchProvider();
    const response = await provider.search({
      query: "Rust 1.90",
      limit: 5,
      domains: ["reuters.com"],
    });

    expect(response.provider).toBe("news");
    expect(response.kind).toBe("news");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.title).toBe("Rust 1.90 released");
    expect(response.results[0]?.url).toBe("https://www.reuters.com/technology/rust-1-90");
    expect(response.results[0]?.source).toBe("www.reuters.com");
    expect(response.results[0]?.snippet).toBe("Rust & friends shipped a new release.");
    expect(response.results[0]?.publishedAt).toBe("2026-11-09T10:00:00.000Z");
  });

  test("filters results by the reputable-source allowlist", async () => {
    mockFetch(async () =>
      new Response(
        bingRss(`
          <item>
            <title>Allowed</title>
            <link>https://www.reuters.com/world/allowed</link>
            <description>ok</description>
          </item>
          <item>
            <title>Blocked</title>
            <link>https://random-blog.example/post</link>
            <description>nope</description>
          </item>`),
      ),
    );

    const response = await new NewsSearchProvider().search({
      query: "world",
      domains: ["reuters.com"],
    });

    expect(response.results.map((result) => result.title)).toEqual(["Allowed"]);
  });

  test("falls back to Google News RSS when Bing fails", async () => {
    mockFetch(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) return new Response("boom", { status: 500 });
      return new Response(
        googleRss(`
          <item>
            <title>Central banks hold rates</title>
            <link>https://news.google.com/rss/articles/abc</link>
            <source url="https://www.reuters.com">Reuters</source>
            <description>Policy &lt;b&gt;decision&lt;/b&gt; explained.</description>
            <pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate>
          </item>`),
      );
    });

    const response = await new NewsSearchProvider().search({
      query: "central banks",
      domains: ["reuters.com"],
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.title).toBe("Central banks hold rates");
    expect(response.results[0]?.source).toBe("www.reuters.com");
    expect(response.results[0]?.snippet).toBe("Policy decision explained.");
  });

  test("respects recency and limit", async () => {
    const now = Date.now();
    const item = (title: string, date: string) => `
      <item>
        <title>${title}</title>
        <link>https://www.reuters.com/world/${title}</link>
        <description>ok</description>
        <pubDate>${date}</pubDate>
      </item>`;
    mockFetch(async () =>
      new Response(
        bingRss(
          item("fresh-1", new Date(now - 60_000).toUTCString()) +
            item("fresh-2", new Date(now - 120_000).toUTCString()) +
            item("stale", new Date(now - 30 * 24 * 60 * 60 * 1000).toUTCString()),
        ),
      ),
    );

    const response = await new NewsSearchProvider().search({
      query: "world",
      recency: "week",
      limit: 1,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.title).toBe("fresh-1");
  });

  test("throws when both feeds fail", async () => {
    mockFetch(async () => new Response("down", { status: 503 }));

    await expect(new NewsSearchProvider().search({ query: "x" })).rejects.toThrow(
      /news search failed/,
    );
  });
});
