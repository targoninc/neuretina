import { errorMessage } from "../../core/errors.ts";
import { requestRaw } from "../../infra/http/request.ts";
import { hostnameOf, recencySinceIso } from "./searchSupport.ts";
import type {
  SearchProvider,
  SearchQuery,
  SearchRecency,
  SearchResponse,
  SearchResult,
} from "../../capabilities/search/SearchProvider.ts";

export interface NewsSearchOptions {
  defaultLimit?: number;
  /** ISO 639-1 language code, e.g. "en". */
  language?: string;
  /** Overridable for tests and self-hosted mirrors. */
  bingBaseUrl?: string;
  googleBaseUrl?: string;
}

const BING_NEWS_URL = "https://www.bing.com/news/search";
const GOOGLE_NEWS_URL = "https://news.google.com/rss/search";
const USER_AGENT = "Mozilla/5.0 (compatible; Neuretina/0.1)";

/**
 * Keyless news search used when a configured web provider fails. It reads the
 * public Bing News and Google News RSS feeds, so research keeps working when
 * API keys expire, a provider is down or no web provider is configured.
 */
export class NewsSearchProvider implements SearchProvider {
  readonly name = "news";
  readonly kind = "news" as const;

  constructor(private readonly options: NewsSearchOptions = {}) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const limit = query.limit ?? this.options.defaultLimit ?? 8;
    const language = query.language ?? this.options.language ?? "en";
    const failures: string[] = [];
    let reachedAFeed = false;

    for (const feed of [this.bing.bind(this), this.google.bind(this)]) {
      try {
        const items = await feed(query, language);
        reachedAFeed = true;
        const results = filterResults(items, query.domains, query.recency).slice(0, limit);
        if (results.length > 0) {
          return { query: query.query, provider: this.name, kind: this.kind, results };
        }
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }

    if (!reachedAFeed) {
      throw new Error(`news search failed: ${failures.join("; ")}`);
    }
    return { query: query.query, provider: this.name, kind: this.kind, results: [] };
  }

  private async bing(query: SearchQuery, language: string): Promise<SearchResult[]> {
    const url = new URL(this.options.bingBaseUrl ?? BING_NEWS_URL);
    url.searchParams.set("q", query.query);
    url.searchParams.set("format", "RSS");
    url.searchParams.set("setlang", language);
    const xml = await this.fetchFeed(url);
    return parseRssItems(xml, "bing");
  }

  private async google(query: SearchQuery, language: string): Promise<SearchResult[]> {
    const url = new URL(this.options.googleBaseUrl ?? GOOGLE_NEWS_URL);
    url.searchParams.set("q", `${query.query}${recencyOperator(query.recency)}`);
    const locale = googleLocale(language);
    url.searchParams.set("hl", locale.hl);
    url.searchParams.set("gl", locale.gl);
    url.searchParams.set("ceid", locale.ceid);
    const xml = await this.fetchFeed(url);
    return parseRssItems(xml, "google");
  }

  private async fetchFeed(url: URL): Promise<string> {
    const response = await requestRaw(
      this.name,
      url.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1",
        },
      },
      { timeoutMs: 15_000, retries: 0 },
    );
    return response.text();
  }
}

function parseRssItems(xml: string, source: "bing" | "google"): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const title = textOf(block, "title");
    const rawLink = textOf(block, "link");
    if (!title || !rawLink) continue;

    const link = source === "bing" ? directBingUrl(rawLink) : rawLink;
    const publisherUrl = sourceTagUrl(block);
    const publisher = publisherUrl ? hostnameOf(publisherUrl) : hostnameOf(link);
    const publishedAt = isoDate(textOf(block, "pubDate"));
    const snippet = htmlToText(textOf(block, "description")).slice(0, 500);

    results.push({
      title,
      url: link,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
      source: publisher || source,
    });
  }
  return results;
}

function textOf(block: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,
    "i",
  );
  const match = pattern.exec(block);
  return match?.[1] ? decodeEntities(stripCdata(match[1])).trim() : "";
}

function sourceTagUrl(block: string): string | undefined {
  const match = /<source\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  return match?.[1] && /^https?:\/\//i.test(match[1]) ? match[1] : undefined;
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1").trim();
}

function directBingUrl(link: string): string {
  try {
    const url = new URL(link);
    if (!/(^|\.)bing\.com$/i.test(url.hostname)) return link;
    const target = url.searchParams.get("url");
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch {
    // Not an absolute URL; leave it unchanged.
  }
  return link;
}

function filterResults(
  results: SearchResult[],
  domains: string[] | undefined,
  recency: SearchRecency | undefined,
): SearchResult[] {
  const cutoff = recencySinceIso(recency);
  const cutoffMs = cutoff ? Date.parse(cutoff) : undefined;
  return results.filter((result) => {
    if (domains && domains.length > 0) {
      const publisher = publisherHost(result);
      if (!publisher || !domains.some((domain) => matchesDomain(publisher, domain))) return false;
    }
    if (cutoffMs !== undefined && result.publishedAt) {
      const published = Date.parse(result.publishedAt);
      if (!Number.isNaN(published) && published < cutoffMs) return false;
    }
    return true;
  });
}

function publisherHost(result: SearchResult): string | undefined {
  const host = result.source && result.source.includes(".") ? result.source : hostnameOf(result.url);
  return host || undefined;
}

function matchesDomain(hostname: string, domain: string): boolean {
  const clean = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  if (!clean) return false;
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (clean.startsWith(".")) return host.endsWith(clean);
  return host === clean || host.endsWith(`.${clean}`);
}

function recencyOperator(recency: SearchRecency | undefined): string {
  switch (recency) {
    case "hour":
      return " when:1h";
    case "day":
      return " when:1d";
    case "3days":
      return " when:3d";
    case "week":
      return " when:7d";
    case "month":
      return " when:30d";
    case "year":
      return " when:1y";
    default:
      return "";
  }
}

function googleLocale(language: string): { hl: string; gl: string; ceid: string } {
  const code = language.toLowerCase().split("-")[0] || "en";
  if (code === "en") return { hl: "en-US", gl: "US", ceid: "US:en" };
  const country = code.toUpperCase();
  return { hl: code, gl: country, ceid: `${country}:${code}` };
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function htmlToText(value: string): string {
  return decodeEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => codePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function codePoint(value: number): string {
  try {
    return Number.isFinite(value) ? String.fromCodePoint(value) : "";
  } catch {
    return "";
  }
}
