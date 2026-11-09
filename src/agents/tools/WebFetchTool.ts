import { requestRaw } from "../../infra/http/request.ts";
import { hostnameOf } from "../../providers/search/searchSupport.ts";
import type { Tool } from "../Tool.ts";

export interface WebFetchResult {
  url: string;
  title?: string;
  contentType: string;
  text: string;
  truncated: boolean;
  provider: "web";
  /** One-entry source list, so a fetched page can be cited like a search result. */
  results: Array<{ title: string; url: string; snippet: string; source: string }>;
}

const USER_AGENT = "Mozilla/5.0 (compatible; Neuretina/0.1)";
const DEFAULT_MAX_CHARS = 12_000;
const MAX_CHARS = 30_000;
const MIN_CHARS = 500;

/**
 * Fetch one public web page and return its readable text. It is always part of
 * the research toolbox: the agent can open a promising search result, verify a
 * primary source, or read a news site directly when search is unavailable.
 */
export class WebFetchTool implements Tool<WebFetchResult> {
  readonly name = "web.fetch";
  readonly description =
    "Fetch one public web page and return its readable text. Use it to open a search result, verify a primary source, or read a news site directly when search is unavailable.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute http(s) URL of the page to read.",
      },
      maxChars: {
        type: "integer",
        description: `Maximum characters of readable text to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_CHARS}).`,
        minimum: MIN_CHARS,
        maximum: MAX_CHARS,
      },
    },
    required: ["url"],
  };

  async execute(args: Record<string, unknown>): Promise<WebFetchResult> {
    const url = fetchableUrl(typeof args.url === "string" ? args.url.trim() : "");
    const maxChars = clamp(
      typeof args.maxChars === "number" ? Math.floor(args.maxChars) : DEFAULT_MAX_CHARS,
      MIN_CHARS,
      MAX_CHARS,
    );

    const response = await requestRaw(
      "web.fetch",
      url.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1",
        },
      },
      { timeoutMs: 20_000, retries: 1 },
    );

    const contentType = response.headers.get("content-type") ?? "";
    if (isBinaryContent(contentType)) {
      throw new Error(`unsupported content type: ${contentType}`);
    }

    const raw = await response.text();
    const text = /html|xml/i.test(contentType) || /^\s*</.test(raw) ? htmlToText(raw) : raw.trim();
    const finalUrl = response.url || url.toString();
    const title = /html|xml/i.test(contentType) || /^\s*</.test(raw) ? extractTitle(raw) : undefined;
    const truncated = text.length > maxChars;
    const clipped = text.slice(0, maxChars);

    return {
      url: finalUrl,
      ...(title ? { title } : {}),
      contentType,
      text: clipped,
      truncated,
      provider: "web",
      results: [
        {
          title: title || finalUrl,
          url: finalUrl,
          snippet: clipped.replace(/\s+/g, " ").slice(0, 300),
          source: hostnameOf(finalUrl),
        },
      ],
    };
  }
}

function fetchableUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("`url` must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("`url` must use http or https");
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error("refusing to fetch a private or local address");
  }
  return url;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  // IPv6 literals are unusual in fetched links; refuse rather than resolve
  // private ranges by hand.
  if (host.includes(":") || host.startsWith("[")) return true;

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBinaryContent(contentType: string): boolean {
  return (
    /^(?:image|audio|video)\//i.test(contentType) ||
    /application\/(?:pdf|zip|octet-stream)/i.test(contentType)
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function extractTitle(html: string): string | undefined {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim();

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title?.[1] ? decodeEntities(title[1]).replace(/\s+/g, " ").trim() : undefined;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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
