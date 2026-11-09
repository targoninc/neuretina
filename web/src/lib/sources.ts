import type { ReportSource } from "./api";

export interface SourceGroup {
  /** Hostname without a leading www (or "other" for unparseable URLs). */
  domain: string;
  sources: ReportSource[];
  /** Distinct providers in the group, in first-seen order. */
  providers: string[];
}

/** Hostname used to group sources; strips a leading www. */
export function sourceDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || "other";
  } catch {
    return "other";
  }
}

/** Groups sources by domain, keeping the research order of first appearance. */
export function groupSourcesByDomain(sources: ReportSource[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const source of sources) {
    const domain = sourceDomain(source.url);
    let group = groups.get(domain);
    if (!group) {
      group = { domain, sources: [], providers: [] };
      groups.set(domain, group);
    }
    group.sources.push(source);
    if (!group.providers.includes(source.provider)) group.providers.push(source.provider);
  }
  return [...groups.values()];
}

/**
 * Case-insensitive filter over title, URL, snippet, provider and media alt
 * text. Multiple words must all match (AND), in any field.
 */
export function filterSources(sources: ReportSource[], query: string): ReportSource[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sources;

  return sources.filter((source) => {
    const haystack = [
      source.title,
      source.url,
      source.snippet ?? "",
      source.provider,
      ...(source.media ?? []).map((item) => item.alt ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

const PROVIDER_LABELS: Record<string, string> = {
  perplexity: "Perplexity",
  exa: "Exa",
  news: "News",
  yahoo: "Yahoo Finance",
  bluesky: "Bluesky",
};

export function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ??
    (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider)
  );
}

/** First letter shown in the domain monogram. */
export function domainInitial(domain: string): string {
  return (domain.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}

/** Favicon service URL for a domain. */
export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}
