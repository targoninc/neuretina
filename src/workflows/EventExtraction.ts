import type { LlmProvider } from "../capabilities/llm/LlmProvider.ts";
import type { CostTracker } from "../core/cost/CostTracker.ts";
import { isoDate } from "../core/dates.ts";
import { errorMessage } from "../core/errors.ts";
import { extractJson } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { textSimilarity, tokenSimilarity, wordCount } from "../core/text.ts";
import type { DecisionModelRegistry } from "../capabilities/decision/DecisionModel.ts";
import type { ReportSource } from "../domain/reports/ReportRepository.ts";
import type { EventStore, TimelineEvent } from "../domain/events/EventRepository.ts";

/** Title similarity at which two events are treated as potential duplicates. */
const DUPLICATE_THRESHOLD = 0.6;
/** On the same day a looser title match is enough to review. */
const SAME_DAY_THRESHOLD = 0.45;
/** Close days use a looser match than unrelated dates (reworded coverage). */
const NEAR_DAY_THRESHOLD = 0.5;
const NEAR_DAY_WINDOW_DAYS = 2;
/** Most existing duplicate pairs one extraction may review; bounds LLM cost. */
const MAX_DEDUPE_REVIEWS = 8;
/** Confidence a selected tag must reach to be applied. */
const TAG_CONFIDENCE = 0.5;
/** Most events one report may contribute. */
const MAX_EVENTS_PER_REPORT = 8;
/** Hard cap on title length; the prompts ask the model for 4-5 words. */
const MAX_TITLE_WORDS = 7;
/** A clause before a colon/dash is kept only when it is at least this long. */
const MIN_TITLE_CLAUSE = 2;
/** Function words that make a poor end to a shortened title. */
const TRAILING_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on",
  "or", "over", "the", "to", "with",
]);

export interface EventSuggestion {
  date: string;
  entities: string[];
  title: string;
  description: string;
}

export interface ExtractionResult {
  /** Events inserted or updated, in suggestion order. */
  events: TimelineEvent[];
  /** Tags invented during this extraction. */
  newTags: string[];
  /** Stored duplicates that were merged away during this extraction. */
  merged: number;
}

export interface EventExtractorDeps {
  llm: LlmProvider;
  events: EventStore;
  logger: Logger;
  /** Model used for the tag decision step; defaults to the provider's model. */
  tagModel?: string;
  /** Local decision models (Laya) for the tag choice; optional. */
  decisions?: DecisionModelRegistry;
  /** Selected hosted decision-model connection id; empty uses the local model. */
  decisionModel?: string;
  /** Minimum confidence before the decision model's pick is used. */
  decisionConfidence?: number;
  cost?: CostTracker;
  sessionId?: string;
  signal?: AbortSignal;
}

interface Candidate {
  event: TimelineEvent;
  score: number;
}

interface ReviewedEvent {
  id: string;
  date: string;
  entities: string[];
  title: string;
  description: string;
}

/**
 * Turns a finished report into dated events:
 * suggestions → potential duplicates (edit distance + shared key terms,
 * thresholded) → LLM review of the candidates → upsert.
 *
 * Tags come from a decision step over the existing tag list plus "other".
 * "other" (or no confident match) asks the LLM for a new tag, which joins the
 * list for the following events — so the list stays small and reusable.
 */
export class EventExtractor {
  constructor(private readonly deps: EventExtractorDeps) {}

  async extract(input: {
    reportId?: string;
    report: string;
    sources: ReportSource[];
  }): Promise<ExtractionResult> {
    const suggestions = await this.suggest(input);
    const known = this.deps.events.list({ limit: 500 });
    const tagOptions = this.deps.events.tags();
    const events: TimelineEvent[] = [];
    const newTags: string[] = [];

    for (const suggestion of suggestions) {
      const candidates = findCandidates(suggestion, known);
      const reviewed = candidates.length > 0 ? await this.review(suggestion, candidates) : undefined;
      const tags = await this.categorize(suggestion, tagOptions, newTags);
      const target = reviewed ? known.find((event) => event.id === reviewed.id) : undefined;
      const event = this.deps.events.upsert({
        id: target?.id,
        date: reviewed?.date ?? suggestion.date,
        entities: reviewed?.entities ?? suggestion.entities,
        tags: mergeTags(target?.tags, tags),
        title: reviewed?.title ?? suggestion.title,
        description: reviewed?.description ?? suggestion.description,
        sourceReportId: input.reportId,
      });

      events.push(event);
      const index = known.findIndex((entry) => entry.id === event.id);
      if (index >= 0) known[index] = event;
      else known.unshift(event);
    }

    // Duplicates that slipped through earlier runs (or were extracted before
    // this pass existed) are merged here, so timelines stay readable.
    const merged = await this.dedupeExisting();

    return { events, newTags, merged };
  }

  /**
   * Reviews and merges duplicates among the stored events themselves. Each
   * event takes part in at most one merge per run, and the number of LLM
   * reviews is capped. Returns how many duplicates were merged away.
   */
  private async dedupeExisting(): Promise<number> {
    const pairs = findDuplicatePairs(this.deps.events.list({ limit: 500 })).slice(
      0,
      MAX_DEDUPE_REVIEWS,
    );
    let merged = 0;

    for (const { keep, drop, score } of pairs) {
      // An earlier merge may already have removed one of the pair.
      if (!this.exists(keep.id) || !this.exists(drop.id)) continue;
      const reviewed = await this.review(
        {
          date: drop.date,
          entities: drop.entities,
          title: drop.title,
          description: drop.description,
        },
        [{ event: keep, score }],
      );
      if (!reviewed) continue;

      const target = this.deps.events.get(reviewed.id);
      this.deps.events.upsert({
        id: target.id,
        date: reviewed.date,
        entities: [...target.entities, ...reviewed.entities, ...drop.entities],
        tags: mergeTags(target.tags, drop.tags),
        title: reviewed.title,
        description: reviewed.description,
        sourceReportId: target.sourceReportId ?? drop.sourceReportId,
      });
      this.deps.events.remove(drop.id);
      merged += 1;
    }

    return merged;
  }

  private exists(id: string): boolean {
    try {
      this.deps.events.get(id);
      return true;
    } catch {
      return false;
    }
  }

  /** One LLM call: dated events learned from the report and its sources. */
  private async suggest(input: {
    report: string;
    sources: ReportSource[];
  }): Promise<EventSuggestion[]> {
    const parsed = (await this.complete(SUGGEST_PROMPT, {
      today: isoDate(),
      report: input.report,
      sources: input.sources.map((source) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
      })),
    })) as { events?: unknown } | undefined;

    if (!Array.isArray(parsed?.events)) return [];
    const suggestions: EventSuggestion[] = [];
    for (const entry of parsed.events) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const date = typeof record.date === "string" ? record.date.trim() : "";
      const title = shortenTitle(typeof record.title === "string" ? record.title : "");
      if (!isIsoDate(date) || !title) continue;
      suggestions.push({
        date,
        entities: stringList(record.entities),
        title,
        description: typeof record.description === "string" ? record.description.trim() : "",
      });
      if (suggestions.length >= MAX_EVENTS_PER_REPORT) break;
    }
    return suggestions;
  }

  /** LLM review of the potential duplicates: same event (update) or new? */
  private async review(
    suggestion: EventSuggestion,
    candidates: Candidate[],
  ): Promise<ReviewedEvent | undefined> {
    const parsed = (await this.complete(REVIEW_PROMPT, {
      suggestion,
      candidates: candidates.map(({ event, score }) => ({
        id: event.id,
        date: event.date,
        title: event.title,
        description: event.description,
        entities: event.entities,
        similarity: Math.round(score * 100) / 100,
      })),
    })) as Record<string, unknown> | undefined;

    if (parsed?.action !== "update" || typeof parsed.id !== "string") return undefined;
    const candidate = candidates.find(({ event }) => event.id === parsed.id);
    if (!candidate) return undefined;

    const date = typeof parsed.date === "string" && isIsoDate(parsed.date.trim())
      ? parsed.date.trim()
      : suggestion.date;
    return {
      id: candidate.event.id,
      date,
      entities: Array.isArray(parsed.entities)
        ? stringList(parsed.entities)
        : suggestion.entities,
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? shortenTitle(parsed.title)
          : suggestion.title,
      description:
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description.trim()
          : suggestion.description,
    };
  }

  /**
   * Tag decision: pick existing tags with confidence, or ask for a new one
   * when "other" wins (or nothing does). New tags extend the option list.
   * The local decision model (Laya) classifies first when it is available;
   * "other" or low confidence falls back to the LLM feedback loop.
   */
  private async categorize(
    suggestion: EventSuggestion,
    options: string[],
    newTags: string[],
  ): Promise<string[]> {
    const local = await this.categorizeWithDecisionModel(suggestion, options);
    if (local !== undefined) {
      if (local.length > 0) return local;
      const generated = await this.generateTag(suggestion, options);
      if (!generated) return [];
      options.push(generated);
      newTags.push(generated);
      return [generated];
    }

    const parsed = (await this.complete(
      CATEGORIZE_PROMPT,
      {
        event: {
          date: suggestion.date,
          title: suggestion.title,
          description: suggestion.description,
          entities: suggestion.entities,
        },
        options: [...options, "other"],
      },
      this.deps.tagModel,
    )) as { tags?: unknown } | undefined;

    const chosen: string[] = [];
    let wantsOther = false;
    if (Array.isArray(parsed?.tags)) {
      for (const entry of parsed.tags) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const tag = typeof record.tag === "string" ? record.tag.trim() : "";
        const confidence = typeof record.confidence === "number" ? record.confidence : 0;
        if (!tag || confidence < TAG_CONFIDENCE) continue;
        if (tag.toLowerCase() === "other") {
          wantsOther = true;
          continue;
        }
        const match = options.find((option) => option.toLowerCase() === tag.toLowerCase());
        if (match && !chosen.includes(match)) chosen.push(match);
      }
    }

    if (!wantsOther && chosen.length > 0) return chosen;

    const generated = await this.generateTag(suggestion, options);
    if (!generated) return chosen;
    options.push(generated);
    newTags.push(generated);
    return [...chosen, generated];
  }

  /**
   * Local/hosted decision model pass. Returns the chosen tags, `[]` when the
   * model says "other"/is unsure (the caller then asks the LLM for a new
   * tag), or undefined when no decision model is available (pure LLM path).
   * The selected hosted connection wins; otherwise the local Laya model runs.
   */
  private async categorizeWithDecisionModel(
    suggestion: EventSuggestion,
    options: string[],
  ): Promise<string[] | undefined> {
    const registry = this.deps.decisions;
    const model =
      (this.deps.decisionModel ? registry?.get(this.deps.decisionModel) : undefined) ??
      registry?.get("laya");
    if (!model || options.length < 2) return undefined;
    try {
      if (!(await model.available())) return undefined;
      const answer = await model.choose(
        [
          suggestion.title,
          suggestion.description,
          suggestion.entities.length > 0 ? `Entities: ${suggestion.entities.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          instructions: "Pick the category tag that best fits the event.",
          options: {
            ...Object.fromEntries(options.map((tag) => [tag, `events about ${tag}`])),
            other: "none of the existing tags fits",
          },
        },
      );
      const threshold = this.deps.decisionConfidence ?? 0.55;
      if (answer.choice === "other" || answer.confidence < threshold) return [];
      const match = options.find(
        (option) => option.toLowerCase() === answer.choice.toLowerCase(),
      );
      return match ? [match] : [];
    } catch {
      return undefined;
    }
  }

  /** "Other" fallback: invent one reusable tag, checked against the options. */
  private async generateTag(
    suggestion: EventSuggestion,
    options: string[],
  ): Promise<string | undefined> {
    const parsed = (await this.complete(
      GENERATE_TAG_PROMPT,
      {
        event: { title: suggestion.title, description: suggestion.description },
        existing: options,
      },
      this.deps.tagModel,
    )) as { tag?: unknown } | undefined;

    const tag = normalizeTag(typeof parsed?.tag === "string" ? parsed.tag : "");
    if (!tag) return undefined;
    if (options.some((option) => option.toLowerCase() === tag.toLowerCase())) return undefined;
    return tag;
  }

  private async complete(
    system: string,
    user: unknown,
    model?: string,
  ): Promise<unknown> {
    const completion = await this.deps.llm.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      responseFormat: "json",
      temperature: 0,
      ...(model ? { model } : {}),
      ...(this.deps.sessionId ? { sessionId: this.deps.sessionId } : {}),
      signal: this.deps.signal,
    });
    this.deps.cost?.addLlm("Events", completion.usage);
    this.deps.logger.debug("event extraction call", {
      characters: completion.text.length,
    });
    return extractJson(completion.text);
  }
}

/**
 * Potential duplicates for a suggestion, best match first. Headlines about the
 * same happening get worded differently ("Google challenges EU DMA orders in
 * court" / "Google asks EU court to suspend DMA search-data order"), so the
 * score is the better of edit distance and shared content words.
 */
export function findCandidates(
  suggestion: EventSuggestion,
  known: TimelineEvent[],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const event of known) {
    const score = titleScore(suggestion.title, event.title);
    const days = daysApart(event.date, suggestion.date);
    if (
      score >= DUPLICATE_THRESHOLD ||
      (days === 0 && score >= SAME_DAY_THRESHOLD) ||
      (days <= NEAR_DAY_WINDOW_DAYS && score >= NEAR_DAY_THRESHOLD)
    ) {
      candidates.push({ event, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

export interface DuplicatePair {
  /** Older event kept (its id survives in timelines and shares). */
  keep: TimelineEvent;
  /** Later event merged into `keep` and removed. */
  drop: TimelineEvent;
  score: number;
}

/**
 * Potential duplicate pairs among the stored events themselves, strongest
 * first. Each event appears in at most one pair so one pass cannot chain
 * merges; the caller reviews them with the LLM.
 */
export function findDuplicatePairs(events: TimelineEvent[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i]!;
      const b = events[j]!;
      const score = titleScore(a.title, b.title);
      const days = daysApart(a.date, b.date);
      if (
        score < DUPLICATE_THRESHOLD &&
        !(days === 0 && score >= SAME_DAY_THRESHOLD) &&
        !(days <= NEAR_DAY_WINDOW_DAYS && score >= NEAR_DAY_THRESHOLD)
      ) {
        continue;
      }
      const [keep, drop] = compareEvents(a, b) <= 0 ? [a, b] : [b, a];
      pairs.push({ keep, drop, score });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const picked: DuplicatePair[] = [];
  for (const pair of pairs) {
    if (used.has(pair.keep.id) || used.has(pair.drop.id)) continue;
    used.add(pair.keep.id);
    used.add(pair.drop.id);
    picked.push(pair);
  }
  return picked;
}

function titleScore(a: string, b: string): number {
  return Math.max(textSimilarity(a, b), tokenSimilarity(a, b));
}

/** Chronological tie-break: earlier date wins, then earlier creation. */
function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

function daysApart(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

/**
 * Deterministic guard for the "4-5 word headline" rule: strips dates,
 * markdown, quotes and trailing parentheticals, prefers the clause before a
 * colon/dash, drops trailing function words and caps the title length. The
 * model is still prompted to compress; this only trims obvious excess.
 */
export function shortenTitle(title: string): string {
  let text = title
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  text = text.replace(/^\(?\d{4}-\d{2}-\d{2}\)?[\s:–—-]+/, "");
  text = text.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const clause = text.split(/\s*[:;—–]\s*/)[0]?.trim() ?? "";
  if (clause !== text && wordCount(clause) >= MIN_TITLE_CLAUSE) text = clause;
  text = text.replace(/[.,;:!?]+$/, "").trim();

  const words = text.split(/\s+/).filter(Boolean);
  while (words.length > MAX_TITLE_WORDS && TRAILING_STOPWORDS.has(words.at(-1)!.toLowerCase())) {
    words.pop();
  }
  if (words.length > MAX_TITLE_WORDS) {
    words.length = MAX_TITLE_WORDS;
    while (words.length > 0 && TRAILING_STOPWORDS.has(words.at(-1)!.toLowerCase())) words.pop();
  }
  return words.join(" ");
}

export function mergeTags(existing: string[] | undefined, fresh: string[]): string[] {
  const merged = [...(existing ?? [])];
  for (const tag of fresh) {
    if (!merged.some((entry) => entry.toLowerCase() === tag.toLowerCase())) merged.push(tag);
  }
  return merged;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function normalizeTag(value: string): string | undefined {
  const tag = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return tag.length >= 2 ? tag : undefined;
}

const SUGGEST_PROMPT = `You extract dated events from a briefing and its sources.

An event is anything learned from the material that is attributable to a specific calendar date: a release, a deal, a ruling, an earnings report, a statement, a market move. Skip facts that carry no date.

Rules:
- Resolve relative dates ("today", "yesterday") against the provided date; use the sources to confirm dates.
- One event per real-world happening: when several sources describe the same happening in different words, merge them into a single event.
- title: 4-5 words, headline style, the core action and its subject (e.g. "Gemini 4 Argon launches", "Google appeals DMA orders"). No dates, no filler, no full sentences, never more than 6 words; put the details in the description.
- description: one or two plain sentences with concrete facts (numbers, names, outcomes).
- entities are the people, companies, products, places or organizations the event is about, under their common names.
- Never invent material: if the date is unclear, leave the event out.
- At most 8 events; keep the most significant ones.

Finish with a single JSON object and nothing else:
{"events": [{"date": "YYYY-MM-DD", "title": "<4-5 word headline>", "description": "<1-2 sentences>", "entities": ["<entity>"]}]}`;

const REVIEW_PROMPT = `You review a newly suggested event against existing stored events that may describe the same real-world happening.

Decide:
- "update": the suggestion and a candidate describe the same real-world happening, even when worded differently or when only one of them carries a detail (e.g. same company, body, product or decision). Return that candidate's id and the merged fields, preferring the most specific date and the most complete description.
- "add": a genuinely different happening, even if it is related, by the same company, or about the same product line. Sharing a company or a model family is not enough.

Reworded coverage of one happening is still one event: "Google challenges EU DMA orders in court", "Google appeals two EU Digital Markets Act orders" and "Google asks EU court to suspend DMA search-data order" all describe the same challenge — update.

Always merge the title down to 4-5 words (never more than 6), the sharpest shared phrasing, e.g. "Google appeals DMA orders", "Anthropic releases Sonnet 5.5".

Finish with a single JSON object and nothing else:
{"action": "update"|"add", "id": "<candidate id when updating>", "date": "YYYY-MM-DD", "title": "…", "description": "…", "entities": ["<entity>"]}`;

const CATEGORIZE_PROMPT = `You are a strict categorizer for timeline events. You receive one event and the list of existing category tags (plus "other").

Select every existing tag that clearly applies to the event, with a confidence between 0 and 1. Only tags reaching 0.5 are kept, so score obvious fits high and omit tags that are merely plausible. Prefer existing tags; never invent a tag yourself. If no existing tag fits, select "other".

Finish with a single JSON object and nothing else:
{"tags": [{"tag": "<existing tag or other>", "confidence": 0.0}]}`;

const GENERATE_TAG_PROMPT = `The existing category tags do not cover this event. Invent ONE short, reusable category tag that will group this event with others like it.

Rules:
- lowercase, one to three words joined by hyphens (e.g. "ai-regulation", "semiconductors")
- a durable category, never a one-off headline, company or person
- must not duplicate an existing tag

Finish with a single JSON object and nothing else:
{"tag": "<tag>"}`;
