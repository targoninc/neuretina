import type { AgentRunResult } from "../../agents/Agent.ts";
import { finiteNumber } from "../records.ts";
import type { CostTracker, FinanceUsageSummary, SearchUsage } from "./CostTracker.ts";

/** Every cost-relevant tool is named `<kind>.<provider>`. */
const SEARCH_TOOL_PREFIX = "search.";
const FINANCE_TOOL_PREFIX = "finance.";

/** Social search and public news feeds are free, so they never become cost lines. */
const FREE_SEARCH_PROVIDERS = new Set(["bluesky", "news"]);

export interface ProviderSearchUsage extends SearchUsage {
  provider: string;
}

export interface ProviderFinanceUsage extends FinanceUsageSummary {
  provider: string;
}

/** Records an agent run's LLM usage, searches and finance lookups. */
export function addAgentCost(
  tracker: CostTracker | undefined,
  step: string,
  result: AgentRunResult,
): number {
  if (!tracker) return 0;
  let usd = tracker.addLlm(step, result.usage, Math.max(1, result.steps.length));

  for (const { provider, ...usage } of collectSearchUsage(result)) {
    usd += tracker.addSearch(step, provider, usage);
  }
  for (const { provider, ...usage } of collectFinanceUsage(result)) {
    usd += tracker.addFinance(step, provider, usage);
  }
  return usd;
}

/**
 * Attributes search calls to the provider that served them: the tool name
 * carries the provider (`search.<provider>`) and a direct response's
 * `provider` wins when present. Perplexity reports `usage.costUsd`, so its
 * calls are priced exactly while the rest (e.g. Exa, Wikipedia) are recorded
 * as unpriced; social search is free and skipped.
 */
export function collectSearchUsage(result: AgentRunResult): ProviderSearchUsage[] {
  return collectProviderUsage(result, SEARCH_TOOL_PREFIX, FREE_SEARCH_PROVIDERS).map(
    ({ provider, calls, priced, costUsd }) => ({
      provider,
      requests: calls,
      unpriced: Math.max(0, calls - priced),
      costUsd,
    }),
  );
}

/** Same attribution for finance lookups; Yahoo is unpriced, Perplexity carries usage. */
export function collectFinanceUsage(result: AgentRunResult): ProviderFinanceUsage[] {
  return collectProviderUsage(result, FINANCE_TOOL_PREFIX).map(
    ({ provider, calls, priced, costUsd, inputTokens, outputTokens }) => ({
      provider,
      lookups: calls,
      unpriced: Math.max(0, calls - priced),
      inputTokens,
      outputTokens,
      costUsd,
    }),
  );
}

export function countWebSearches(result: AgentRunResult): number {
  return collectSearchUsage(result).reduce((sum, usage) => sum + usage.requests, 0);
}

interface ProviderUsage {
  provider: string;
  /** Tool calls that ran. */
  calls: number;
  /** Calls whose provider reported a cost. */
  priced: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ToolInvocationResponse {
  provider?: unknown;
  usage?: unknown;
  toolCallsByTool?: unknown;
  toolUsages?: unknown;
}

/**
 * One pass over an agent run: sandboxed calls are counted per tool name,
 * direct calls per invocation, and every provider-reported usage is merged
 * into the same per-provider bucket.
 */
function collectProviderUsage(
  result: AgentRunResult,
  prefix: string,
  freeProviders: ReadonlySet<string> = new Set(),
): ProviderUsage[] {
  const byProvider = new Map<string, ProviderUsage>();
  const entry = (provider: string): ProviderUsage => {
    let usage = byProvider.get(provider);
    if (!usage) {
      usage = { provider, calls: 0, priced: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      byProvider.set(provider, usage);
    }
    return usage;
  };
  const resolve = (tool: unknown): string | undefined => {
    if (typeof tool !== "string" || !tool.startsWith(prefix)) return undefined;
    const provider = tool.slice(prefix.length);
    return provider && !freeProviders.has(provider) ? provider : undefined;
  };

  for (const step of result.steps) {
    for (const invocation of step.invocations) {
      const response = invocation.result as ToolInvocationResponse | undefined;
      const toolProvider = resolve(invocation.tool);
      const provider = providerOf(response) ?? toolProvider;

      const byTool = response?.toolCallsByTool;
      if (byTool && typeof byTool === "object") {
        for (const [tool, calls] of Object.entries(byTool)) {
          const callProvider = resolve(tool);
          if (callProvider && typeof calls === "number") entry(callProvider).calls += calls;
        }
      } else if (toolProvider) {
        entry(provider ?? toolProvider).calls += 1;
      }

      if (Array.isArray(response?.toolUsages)) {
        for (const record of toolUsages(response.toolUsages)) {
          const usageProvider = resolve(record.tool);
          if (usageProvider) collectUsage(record.usage, entry(usageProvider));
        }
      }

      if (toolProvider) collectUsage(response?.usage, entry(provider ?? toolProvider));
    }
  }

  return [...byProvider.values()];
}

function toolUsages(value: unknown): Array<{ tool?: unknown; usage?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is { tool?: unknown; usage?: unknown } => !!entry && typeof entry === "object",
  );
}

function providerOf(response: ToolInvocationResponse | undefined): string | undefined {
  const provider = response?.provider;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function collectUsage(usage: unknown, out: ProviderUsage): void {
  if (!usage || typeof usage !== "object") return;
  const record = usage as Record<string, unknown>;
  const inputTokens = finiteNumber(record.inputTokens);
  const outputTokens = finiteNumber(record.outputTokens);
  const costUsd = finiteNumber(record.costUsd);
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return;
  if (costUsd !== undefined) {
    out.priced += 1;
    out.costUsd += costUsd;
  }
  out.inputTokens += inputTokens ?? 0;
  out.outputTokens += outputTokens ?? 0;
}
