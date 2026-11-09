import type { SearchProvider, SearchResponse } from "../../capabilities/search/SearchProvider.ts";
import { errorMessage } from "../../core/errors.ts";
import type { Tool } from "../Tool.ts";

export interface SearchToolOptions {
  provider: SearchProvider;
  /** Used when the primary provider fails, e.g. a keyless news search. */
  fallback?: SearchProvider;
  toolName?: string;
  description?: string;
  defaultLimit?: number;
  defaultRecency?: "hour" | "day" | "3days" | "week" | "month" | "year";
  /** ISO 639-1 language code applied to every query (e.g. "en"). */
  defaultLanguage?: string;
  /** Reputable-source allowlist applied by default (empty = no filter). */
  domains?: string[];
  /** When false the domains are a hard restriction and no scope override is offered. */
  allowScope?: boolean;
}

export class SearchTool implements Tool<SearchResponse> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  private readonly provider: SearchProvider;
  private readonly fallback?: SearchProvider;
  private readonly defaultLimit: number;
  private readonly defaultRecency?: SearchToolOptions["defaultRecency"];
  private readonly defaultLanguage?: string;
  private readonly domains: string[];
  private readonly allowScope: boolean;

  constructor(options: SearchToolOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback;
    this.name = options.toolName ?? `${options.provider.name}_search`;
    this.defaultLimit = options.defaultLimit ?? 6;
    this.defaultRecency = options.defaultRecency;
    this.defaultLanguage = options.defaultLanguage;
    this.domains = options.domains ?? [];
    this.allowScope = options.allowScope ?? true;

    const base = options.description ?? describeKind(this.provider);
    const fallbackNote = this.fallback
      ? " If the provider is unavailable, recent news coverage is searched instead."
      : "";
    this.description =
      this.domains.length > 0 && this.allowScope
        ? `${base} Results are limited to a curated allowlist of reputable sources (established outlets, Wikipedia, primary .gov sources) by default; pass scope "open" only when you need an official or niche page that the allowlist cannot cover, such as release notes or documentation.${fallbackNote}`
        : `${base}${fallbackNote}`;

    const properties: Record<string, unknown> = {
      query: {
        type: "string",
        description: "The search query. Plain keywords or a short phrase work best.",
      },
      limit: {
        type: "integer",
        description: `Maximum number of results to return (default ${this.defaultLimit}).`,
        minimum: 1,
        maximum: this.provider.kind === "social" ? 100 : 20,
      },
      recency: {
        type: "string",
        enum: ["hour", "day", "3days", "week", "month", "year"],
        description: `Only return results from this time window (default: ${this.defaultRecency ?? "day"}).`,
      },
    };
    if (this.domains.length > 0 && this.allowScope) {
      properties.scope = {
        type: "string",
        enum: ["reputable", "open"],
        description:
          '"reputable" (default) keeps results on the reputable-source allowlist; "open" searches the whole web.',
      };
    }

    this.parameters = { type: "object", properties, required: ["query"] };
  }

  async execute(args: Record<string, unknown>): Promise<SearchResponse> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("`query` is required");

    const limit = typeof args.limit === "number" ? args.limit : this.defaultLimit;
    const recency = isRecency(args.recency) ? args.recency : this.defaultRecency;
    const open = this.allowScope && args.scope === "open";
    const domains = open || this.domains.length === 0 ? undefined : this.domains;
    const search = { query, limit, recency, language: this.defaultLanguage, domains };

    try {
      return await this.provider.search(search);
    } catch (error) {
      if (!this.fallback) throw error;
      try {
        return await this.fallback.search(search);
      } catch (fallbackError) {
        throw new Error(
          `${this.provider.name} search failed (${errorMessage(error)}); ${this.fallback.name} fallback failed (${errorMessage(fallbackError)})`,
        );
      }
    }
  }
}

function describeKind(provider: SearchProvider): string {
  switch (provider.kind) {
    case "web":
      return "Search the public web for recent articles and pages. Returns ranked results with title, URL, snippet and publication date.";
    case "social":
      return "Search social media posts (Bluesky / AT Protocol). Returns recent public posts with author, text, permalink and engagement.";
    case "news":
      return "Search recent news coverage. Returns articles with title, URL, snippet and publication date.";
  }
}

function isRecency(value: unknown): value is NonNullable<SearchToolOptions["defaultRecency"]> {
  return (
    value === "hour" ||
    value === "day" ||
    value === "3days" ||
    value === "week" ||
    value === "month" ||
    value === "year"
  );
}
