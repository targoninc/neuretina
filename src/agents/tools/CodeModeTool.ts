import type { SearchMedia, SearchResult } from "../../capabilities/search/SearchProvider.ts";
import { dedupeBy } from "../../core/collections.ts";
import { createSubprocessExecutor } from "../codemode/executor.ts";
import type { CodeModeExecutor } from "../codemode/types.ts";
import type { Tool, ToolContext } from "../Tool.ts";

export interface CodeModeToolOptions {
  /** Tools the sandbox can call; each is exposed as an async function by name. */
  tools: Tool[];
  /** Absolute wall-clock limit for one program, tool calls included. */
  timeoutMs?: number;
  /** Killed when the program produces no activity for this long (runaway loops). */
  idleTimeoutMs?: number;
  /** Total sandbox stdout accepted before the program is killed. */
  maxOutputChars?: number;
  /** Upper bound on tool invocations inside one program. */
  maxToolCalls?: number;
  /** The returned value is clipped to this many characters of JSON. */
  maxResultChars?: number;
  /** Captured console output is clipped to this many characters. */
  maxLogChars?: number;
  /** Injectable for tests; defaults to the Bun subprocess sandbox. */
  executor?: CodeModeExecutor;
}

/** A search result plus the provider it came from, for report attribution. */
export interface CodeModeSource extends SearchResult {
  provider: string;
}

export interface CodeModeResult {
  /** Whatever the program returned. */
  result: unknown;
  logs: string[];
  toolCalls: number;
  /** Tool invocations inside the program, by tool name. */
  toolCallsByTool: Record<string, number>;
  /** Billing usage reported by tools inside the program (e.g. finance lookups). */
  toolUsages: Array<{ tool: string; usage: unknown }>;
  /** Every query/question the program passed to a tool. */
  queries: string[];
  /** Search sources gathered inside the sandbox, for the report's source list. */
  results: CodeModeSource[];
  durationMs: number;
}

const DESCRIPTION_INTRO = `Run JavaScript to do research in one step, instead of calling each tool separately. Write one async arrow function that plans and runs the whole lookup and returns only the findings you need. Inside the sandbox these async functions are available:

{{tools}}

The function must return a JSON-serializable value — that value is all you get back, so filter, merge and trim inside the code (Promise.all, loops, if-statements) and return compact findings rather than raw tool output. console.log is captured and returned with the result.

Tool calls never throw: a failed call resolves to { error: string, results: [], reports: [], data: [], answer: "" } instead of rejecting, so one flaky provider cannot abort your program. Check .error when it matters and carry on with the calls that succeeded.

Example:
async () => {
  const [web, social] = await Promise.all([
    search.perplexity({ query: "Rust 1.90 release", limit: 6 }),
    search.bluesky({ query: "Rust 1.90", limit: 10 }),
  ]);
  return {
    web: web.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet.slice(0, 200) })),
    social: social.results.slice(0, 5).map((p) => ({ source: p.source, text: p.snippet })),
  };
}

Only the functions above are available: no imports, no network, no filesystem. If a call fails, fix the code and run it again.`;

/** Model-facing docs per sandbox function; the description lists what is provided. */
const TOOL_DOCS: Record<string, string> = {
  "search.perplexity": `search.perplexity({ query, limit?, recency?, scope? }) -> { results: [{ title, url, snippet, publishedAt?, source }] }
  Web search via Perplexity. limit up to 20; recency is "hour" | "day" | "3days" | "week" | "month" | "year"; scope "open" drops the reputable-source allowlist (default: reputable).`,
  "search.exa": `search.exa({ query, limit?, recency? }) -> same shape
  Web search via Exa's neural/keyword index; a second, independent set of results.`,
  "search.bluesky": `search.bluesky({ query, limit?, recency? }) -> same shape
  Recent Bluesky posts, where hype, skepticism and disagreement show up.`,
  "search.news": `search.news({ query, limit?, recency?, scope? }) -> same shape
  Recent news coverage from major outlets, read from public news feeds. Use it when a web provider is unavailable or when the story is best followed in the press.`,
  "search.wikipedia": `search.wikipedia({ query, limit? }) -> same shape
  Wikipedia only (all language editions), for background, definitions and context.`,
  "web.fetch": `web.fetch({ url, maxChars? }) -> { url, title?, contentType, text, truncated, results: [{ title, url, snippet, source }] }
  Fetch one public web page and return its readable text. Use it to open a promising result, verify a primary source, or read a news site directly when search is unavailable.`,

  "finance.perplexity": `finance.perplexity({ question }) -> { answer, data: [{ category, tickers, content, sources }] }
  Perplexity's finance agent: a synthesized answer plus structured market and financial data for public companies and ETFs. Ask a business question naming the company or ticker.`,
  "finance.yahoo": `finance.yahoo({ question }) -> same shape
  Yahoo Finance quotes: latest price, change, day and 52-week ranges and volume for the tickers matched from the question.`,
  past_reports: `past_reports({ query?, limit? }) -> { reports: [{ id, date, topics, excerpt }] }
  Search earlier briefings by topic or keyword, to build on what was already covered.`,
  past_report: `past_report({ id }) -> { id, date, topics, markdown, sources: [{ title, url }] }
  Open one earlier briefing in full, using an id from past_reports.`,
};

function describeTools(tools: Tool[]): string {
  return tools
    .map((tool) => {
      const docs = TOOL_DOCS[tool.name];
      if (docs) return docs;
      const signature = tool.name.includes(".")
        ? `${tool.name}({ query, limit?, recency? }) -> tool result`
        : `${tool.name}({ ... }) -> tool result`;
      return `${signature}\n  ${tool.description}`;
    })
    .join("\n\n");
}

/**
 * Code mode: the model gets one tool, writes a program that calls the real
 * tools inside a sandbox, and only the program's return value and captured
 * logs come back — intermediate results never round-trip through the model.
 */
export class CodeModeTool implements Tool<CodeModeResult> {
  readonly name = "run_code";
  readonly description: string;
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "An async arrow function, e.g. async () => { const r = await search.perplexity({ query: \"...\" }); return { ... }; }",
      },
    },
    required: ["code"],
  };

  private readonly tools: Tool[];
  private readonly maxToolCalls: number;
  private readonly maxResultChars: number;
  private readonly maxLogChars: number;
  private readonly executor: CodeModeExecutor;

  constructor(options: CodeModeToolOptions) {
    if (options.tools.length === 0) throw new Error("CodeModeTool needs at least one tool");
    this.tools = options.tools;
    this.description = DESCRIPTION_INTRO.replace("{{tools}}", describeTools(this.tools));
    this.maxToolCalls = options.maxToolCalls ?? 12;
    this.maxResultChars = options.maxResultChars ?? 4000;
    this.maxLogChars = options.maxLogChars ?? 1500;
    this.executor =
      options.executor ??
      createSubprocessExecutor({
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        maxOutputChars: options.maxOutputChars,
      });
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<CodeModeResult> {
    const code = typeof args.code === "string" ? args.code.trim() : "";
    if (!code) throw new Error("`code` is required");

    const violation = screen(code);
    if (violation) {
      throw new Error(
        `Code rejected (${violation} is not available in the sandbox). Use only the tool functions from the description.`,
      );
    }

    const started = Date.now();
    const outcome = await this.executor.run({
      code,
      tools: new Map(this.tools.map((tool) => [tool.name, tool])),
      context,
      maxToolCalls: this.maxToolCalls,
    });

    const queries: string[] = [];
    const results: CodeModeSource[] = [];
    const toolCallsByTool: Record<string, number> = {};
    const toolUsages: Array<{ tool: string; usage: unknown }> = [];
    for (const call of outcome.toolCalls) {
      toolCallsByTool[call.tool] = (toolCallsByTool[call.tool] ?? 0) + 1;
      const usage = (call.result as { usage?: unknown } | undefined)?.usage;
      if (usage && typeof usage === "object") toolUsages.push({ tool: call.tool, usage });

      const query = call.args.query ?? call.args.question;
      if (typeof query === "string" && query.trim()) queries.push(query.trim());

      if (!call.result || typeof call.result !== "object") continue;
      const response = call.result as { results?: unknown; provider?: unknown };
      if (!Array.isArray(response.results)) continue;
      const provider = typeof response.provider === "string" ? response.provider : call.tool;
      for (const item of response.results) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.url !== "string" || !record.url) continue;
        const media = Array.isArray(record.media) ? (record.media as SearchMedia[]) : undefined;
        results.push({
          title: typeof record.title === "string" && record.title ? record.title : record.url,
          url: record.url,
          snippet: typeof record.snippet === "string" ? record.snippet : "",
          source: typeof record.source === "string" ? record.source : provider,
          provider,
          ...(media && media.length > 0 ? { media } : {}),
        });
      }
    }

    return {
      result: clipResult(outcome.result, this.maxResultChars),
      logs: clipLogs(outcome.logs, this.maxLogChars),
      toolCalls: outcome.toolCalls.length,
      toolCallsByTool,
      toolUsages,
      queries,
      results: dedupeBy(results, (source) => source.url),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The sandbox worker removes these globals, and the host screens the code for
 * obvious references so a clear error comes back instead of a ReferenceError.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bimport\s*\(/, "dynamic import"],
  [/\bimport\.meta\b/, "import.meta"],
  [/\brequire\s*\(/, "require"],
  [/\bglobalThis\b/, "globalThis"],
  [/\bprocess\s*[.[]/, "process"],
  [/\bBun\s*[.[]/, "Bun"],
  [/\bDeno\s*[.[]/, "Deno"],
  [/(?<![\w.])fetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b|\bWebSocket\b/, "network APIs"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "the Function constructor"],
];

function screen(code: string): string | undefined {
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(code)) return label;
  }
  return undefined;
}

function clipResult(result: unknown, maxChars: number): unknown {
  try {
    const text = JSON.stringify(result ?? null);
    if (text === undefined) return null;
    if (text.length <= maxChars) return JSON.parse(text);
    return `${text.slice(0, maxChars)}…[truncated]`;
  } catch {
    return null;
  }
}

function clipLogs(logs: string[], maxChars: number): string[] {
  const clipped: string[] = [];
  let budget = maxChars;
  for (const log of logs.slice(0, 20)) {
    if (budget <= 0) break;
    const line = log.slice(0, 300);
    clipped.push(line);
    budget -= line.length;
  }
  return clipped;
}


