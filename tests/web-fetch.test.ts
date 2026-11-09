import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WebFetchTool } from "../src/agents/tools/WebFetchTool.ts";

const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => {
  fetchSpy.mockReset();
});

function mockFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  fetchSpy.mockImplementation(implementation as unknown as typeof fetch);
}

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Fallback title</title>
    <meta property="og:title" content="Rust 1.90 released" />
  </head>
  <body>
    <script>alert("nope")</script>
    <style>.hidden { display: none }</style>
    <article>
      <h1>Rust 1.90 released</h1>
      <p>The Rust team shipped 1.90 with faster builds &amp; new features.</p>
      <p>Read the <a href="https://blog.rust-lang.org">announcement</a>.</p>
    </article>
  </body>
</html>`;

describe("WebFetchTool", () => {
  test("fetches a page and returns readable text plus a citable source", async () => {
    mockFetch(async () => new Response(PAGE, { headers: { "content-type": "text/html" } }));

    const result = await new WebFetchTool().execute({ url: "https://news.example.com/story" });

    expect(result.url).toBe("https://news.example.com/story");
    expect(result.title).toBe("Rust 1.90 released");
    expect(result.contentType).toBe("text/html");
    expect(result.text).toContain("The Rust team shipped 1.90");
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain(".hidden");
    expect(result.provider).toBe("web");
    expect(result.results).toEqual([
      {
        title: "Rust 1.90 released",
        url: "https://news.example.com/story",
        snippet: expect.any(String),
        source: "news.example.com",
      },
    ]);
  });

  test("truncates long text", async () => {
    mockFetch(
      async () =>
        new Response(`<html><body><p>${"word ".repeat(2000)}</p></body></html>`, {
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await new WebFetchTool().execute({
      url: "https://news.example.com/long",
      maxChars: 500,
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(500);
  });

  test("rejects non-public and non-http URLs", async () => {
    const tool = new WebFetchTool();

    await expect(tool.execute({ url: "http://localhost/admin" })).rejects.toThrow(/private/);
    await expect(tool.execute({ url: "http://127.0.0.1/x" })).rejects.toThrow(/private/);
    await expect(tool.execute({ url: "http://192.168.1.1/x" })).rejects.toThrow(/private/);
    await expect(tool.execute({ url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    await expect(tool.execute({ url: "not a url" })).rejects.toThrow(/absolute/);
  });

  test("rejects binary content types", async () => {
    mockFetch(
      async () =>
        new Response("pdf", { headers: { "content-type": "application/pdf" } }),
    );

    await expect(
      new WebFetchTool().execute({ url: "https://example.com/file.pdf" }),
    ).rejects.toThrow(/unsupported content type/);
  });
});
