import { wordCount } from "../core/text.ts";
import { Agent } from "../agents/Agent.ts";
import { SearchTool } from "../agents/tools/SearchTool.ts";
import { CodeModeTool } from "../agents/tools/CodeModeTool.ts";
import type { LlmProvider } from "../capabilities/llm/LlmProvider.ts";
import type { SearchProvider, SearchRecency } from "../capabilities/search/SearchProvider.ts";
import { addAgentCost } from "../core/cost/agentCosts.ts";
import { errorMessage } from "../core/errors.ts";
import { extractJson } from "../core/json.ts";
import { reportDiffDetail } from "../core/status/StatusHub.ts";
import type { WorkflowContext } from "../core/workflow/Workflow.ts";
import type { ReportSource } from "../domain/reports/ReportRepository.ts";
import { collectSources } from "./agentResults.ts";

export interface SourceUpgrade {
  /** 1-based number of the existing source this replaces. */
  for: number;
  title: string;
  url: string;
}

export interface SourceUpgradeInput {
  topics: string[];
  markdown: string;
  sources: ReportSource[];
}

export interface SourceUpgradeOutcome {
  markdown: string;
  sources: ReportSource[];
  upgraded: number;
}

export interface SourceUpgradesDeps {
  llm: LlmProvider;
  webSearch: SearchProvider;
  /** All configured web providers; one open-web search.<name> tool each. */
  searchProviders?: SearchProvider[];
  defaults: {
    recency: SearchRecency;
    resultsPerProvider: number;
    language: string;
  };
}

/** At most this many source replacements per briefing. */
export const MAX_SOURCE_UPGRADES = 5;

const SOURCE_UPGRADES_SYSTEM_PROMPT = `You run the source upgrades pass on a finished briefing. You receive the report and its numbered source list. Many claims are backed by secondary coverage — news articles about something. Your job is to trace those claims back to the PRIMARY source and, where the primary source is more precise, align the claim with it.

A primary source is where the information originated: an official announcement or press release, a company blog or investor-relations page, a filing, a regulator or government publication, the original dataset, documentation, or the announcement post itself. News coverage about the announcement is secondary; the announcement is primary.

You research by writing JavaScript through the run_code tool: one small async function per run that calls the web-search functions listed in the tool description and returns compact findings. Run independent calls in parallel with Promise.all.

Rules:
- Upgrade only claims that plausibly have a primary source: launches, releases, announcements, filings, official statistics, policy decisions.
- Search for the origin, not for more coverage: name the actor and the thing ("OpenAI Dots announcement", "Rust 1.90 release notes") and check the result sits on the origin's own domain.
- Use only URLs that appeared in your search results — never invent one.
- Verify the primary source actually supports the claim before using it; if it does not, leave the claim alone.
- Keep every citation number exactly as it is: you replace the SOURCE a number points to, and never renumber, add or remove markers. At most ${MAX_SOURCE_UPGRADES} upgrades, best first.
- Revise the wording only where the primary source is more precise or contradicts the secondary report. Keep the title, the paragraph shape, the "Implications" section and roughly the same length; change nothing else.
- Finding no primary source is a valid answer.

Finish with a single JSON object and nothing else:
{"markdown": "<the full report, revised only where required>", "upgrades": [{"for": 4, "title": "<primary source title>", "url": "<primary source URL>"}]}
Return the report text unchanged when no wording revision is needed.`;

/**
 * After the draft (and its implications) is settled, one more research agent
 * traces claims back to primary sources such as official announcements, and
 * replaces the matching entries in the report's source list. Citation numbers
 * stay stable, so the revised text keeps pointing at the right sources.
 */
export class SourceUpgrades {
  private readonly agent: Agent;

  constructor(private readonly deps: SourceUpgradesDeps) {
    const providers =
      deps.searchProviders && deps.searchProviders.length > 0
        ? deps.searchProviders
        : [deps.webSearch];
    this.agent = new Agent({
      name: "source-upgrades",
      description: "Traces briefing claims back to primary sources",
      systemPrompt: SOURCE_UPGRADES_SYSTEM_PROMPT,
      llm: deps.llm,
      tools: [
        new CodeModeTool({
          tools: providers.map(
            (provider) =>
              new SearchTool({
                provider,
                toolName: `search.${provider.name}`,
                description:
                  "Open web search for primary sources: official announcements, company blogs, filings, documentation and government publications.",
                defaultLimit: deps.defaults.resultsPerProvider,
                defaultRecency: deps.defaults.recency,
                defaultLanguage: deps.defaults.language,
              }),
          ),
          maxToolCalls: 8,
        }),
      ],
      maxSteps: 5,
      maxToolCalls: 3,
      temperature: 0.2,
    });
  }

  async run(
    input: SourceUpgradeInput,
    context: WorkflowContext,
    parentId?: string,
  ): Promise<SourceUpgradeOutcome | undefined> {
    const status = context.statuses?.begin(
      `${context.correlationId}:upgrade`,
      "Hunting for primary sources",
      { correlationId: context.correlationId, parentId },
    );

    try {
      context.signal?.throwIfAborted();
      const result = await this.agent.run(buildSourceUpgradePrompt(input), {
        correlationId: context.correlationId,
        bus: context.bus,
        logger: context.logger,
        signal: context.signal,
        ...(context.statuses ? { statuses: context.statuses } : {}),
        ...(status ? { statusId: status.id } : {}),
      });
      status?.addCost(addAgentCost(context.cost, "Primary sources", result));

      const parsed = parseSourceUpgrades(result.text, input.sources.length);
      if (!parsed) {
        status?.done("No primary sources found");
        return undefined;
      }

      const found = collectSources(result);
      const sources = applySourceUpgrades(input.sources, parsed.upgrades, found);
      const upgraded = countReplacements(input.sources, sources);
      // Only a real text change is a revision; models often echo the report
      // back verbatim, which must not read as a change in the activity feed.
      const revision =
        parsed.markdown &&
        parsed.markdown.trimEnd() !== input.markdown.trimEnd() &&
        isAcceptableRevision(input.markdown, parsed.markdown, sources.length)
          ? parsed.markdown
          : undefined;

      if (upgraded === 0 && !revision) {
        status?.done("No primary sources found");
        return undefined;
      }

      status?.done(
        `Primary sources: ${upgraded} upgrade(s)${revision ? ", report revised" : ""}`,
        revision ? reportDiffDetail(input.markdown, revision) : undefined,
      );
      return { markdown: revision ?? input.markdown, sources, upgraded };
    } catch (error) {
      status?.failed(`Primary-source pass failed (${errorMessage(error)})`);
      context.logger.warn("primary-source pass failed; keeping the draft", {
        error: errorMessage(error),
      });
      return undefined;
    }
  }
}

function buildSourceUpgradePrompt(input: SourceUpgradeInput): string {
  return JSON.stringify({
    topics: input.topics,
    report: input.markdown,
    sources: input.sources.map((source, index) => ({
      n: index + 1,
      title: source.title,
      url: source.url,
      provider: source.provider,
    })),
  });
}

export function parseSourceUpgrades(
  text: string,
  sourceCount: number,
): { markdown: string; upgrades: SourceUpgrade[] } | undefined {
  const parsed = extractJson<{ markdown?: unknown; upgrades?: unknown }>(text);
  if (!parsed) return undefined;

  const markdown = typeof parsed.markdown === "string" ? parsed.markdown.trim() : "";
  const upgrades: SourceUpgrade[] = [];
  if (Array.isArray(parsed.upgrades)) {
    for (const item of parsed.upgrades) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const index = typeof record.for === "number" ? record.for : Number(record.for);
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!Number.isInteger(index) || index < 1 || index > sourceCount) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      upgrades.push({ for: index, title: title || url, url });
      if (upgrades.length >= MAX_SOURCE_UPGRADES) break;
    }
  }

  if (!markdown && upgrades.length === 0) return undefined;
  return { markdown, upgrades };
}

export function applySourceUpgrades(
  sources: ReportSource[],
  upgrades: SourceUpgrade[],
  found: ReportSource[],
): ReportSource[] {
  if (upgrades.length === 0) return sources;

  const byUrl = new Map(found.map((source) => [source.url, source]));
  const next = [...sources];
  for (const upgrade of upgrades) {
    const index = upgrade.for - 1;
    const previous = next[index];
    if (!previous) continue;
    const match = byUrl.get(upgrade.url);
    next[index] = {
      title: upgrade.title || match?.title || upgrade.url,
      url: upgrade.url,
      provider: match?.provider ?? previous.provider,
      ...(match?.snippet ? { snippet: match.snippet } : {}),
      ...(match?.media && match.media.length > 0 ? { media: match.media } : {}),
    };
  }
  return next;
}

function countReplacements(previous: ReportSource[], next: ReportSource[]): number {
  let count = 0;
  for (let index = 0; index < next.length; index++) {
    if (previous[index]?.url !== next[index]?.url) count++;
  }
  return count;
}

export function isAcceptableRevision(
  original: string,
  revised: string,
  sourceCount: number,
): boolean {
  const revisedWords = wordCount(revised);
  const originalWords = wordCount(original);
  if (revisedWords < Math.max(5, Math.ceil(originalWords * 0.5))) return false;
  if (revisedWords > Math.ceil(originalWords * 1.5) + 20) return false;
  if (original.includes("## Implications") && !revised.includes("Implications")) return false;
  for (const match of revised.matchAll(/\[(\d+)\]/g)) {
    const number = Number(match[1]);
    if (number < 1 || number > sourceCount) return false;
  }
  return true;
}

