import type { Tool } from "../agents/Tool.ts";
import { createSocialSearchTool, createWebSearchTools } from "../agents/tools/searchTools.ts";
import { ReportSearchTool } from "../agents/tools/ReportSearchTool.ts";
import { SearchTool } from "../agents/tools/SearchTool.ts";
import type { SearchProvider, SearchRecency } from "../capabilities/search/SearchProvider.ts";
import type { ReportStore } from "../domain/reports/ReportRepository.ts";

export interface ResearchToolDefaults {
  resultsPerProvider: number;
  recency: SearchRecency;
  language: string;
  searchDomains: string[];
}

export interface ResearchToolDeps {
  webSearch: SearchProvider;
  /** All configured web providers; one `search.<name>` tool each. */
  searchProviders?: SearchProvider[];
  socialSearch: SearchProvider;
  reports: ReportStore;
  defaults: ResearchToolDefaults;
}

/**
 * The shared research toolbox: optional Wikipedia, one `search.<provider>` tool
 * per configured web provider, social search and past reports. Callers add
 * their own extras (finance, report lookup) and wrap the list in code mode
 * where useful.
 */
export function createResearchTools(
  deps: ResearchToolDeps,
  options: {
    contextId?: string;
    wikipedia?: boolean;
    extra?: Tool[];
    language?: string;
  } = {},
): Tool[] {
  const providers =
    deps.searchProviders && deps.searchProviders.length > 0
      ? deps.searchProviders
      : [deps.webSearch];
  const { defaults } = deps;

  return [
    ...(options.wikipedia
      ? [
          new SearchTool({
            provider: deps.webSearch,
            toolName: "search.wikipedia",
            description:
              "Search Wikipedia (all language editions) for background, definitions and context.",
            domains: ["wikipedia.org"],
            allowScope: false,
            defaultLimit: 5,
          }),
        ]
      : []),
    ...createWebSearchTools(providers, {
      limit: defaults.resultsPerProvider,
      recency: defaults.recency,
      language: options.language ?? defaults.language,
      domains: defaults.searchDomains,
    }),
    createSocialSearchTool(deps.socialSearch, {
      limit: defaults.resultsPerProvider,
      recency: defaults.recency,
    }),
    new ReportSearchTool(deps.reports, options.contextId),
    ...(options.extra ?? []),
  ];
}
