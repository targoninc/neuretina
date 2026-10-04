import { escapeHtml } from "../core/markdown.ts";
import type { TimelineEvent } from "../domain/events/EventRepository.ts";

/** Tag matches count as related only within this many days. */
const RELATED_WINDOW_DAYS = 30;
const MAX_TIMELINE_EVENTS = 60;
/** Most events a delivered text timeline lists; the rest is summarized. */
const MAX_TEXT_EVENTS = 40;
/** Line width the delivered text timeline targets inside a code block. */
const TEXT_WIDTH = 92;

/**
 * The timeline for freshly extracted events: the events themselves plus the
 * stored events they are related to — sharing an entity, or sharing a tag
 * within a month. Newest first.
 */
export function selectTimelineEvents(
  fresh: TimelineEvent[],
  all: TimelineEvent[],
): TimelineEvent[] {
  const selected = new Map<string, TimelineEvent>();
  for (const event of fresh) selected.set(event.id, event);

  for (const event of all) {
    if (selected.has(event.id)) continue;
    if (fresh.some((anchor) => related(anchor, event))) selected.set(event.id, event);
  }

  return [...selected.values()]
    .sort((a, b) =>
      a.date === b.date
        ? a.createdAt - b.createdAt || a.id.localeCompare(b.id)
        : b.date.localeCompare(a.date),
    )
    .slice(0, MAX_TIMELINE_EVENTS);
}

/** Markdown rendering of a timeline artifact. */
export function renderTimelineMarkdown(events: TimelineEvent[]): string {
  const lines: string[] = ["## Timeline", ""];
  let currentDate = "";
  for (const event of events) {
    if (event.date !== currentDate) {
      currentDate = event.date;
      lines.push(`### ${event.date}`, "");
    }
    lines.push(`**${event.title}**`);
    if (event.description) lines.push(event.description);
    const meta = [
      ...event.tags.map((tag) => `#${tag}`),
      ...event.entities,
    ].join(" · ");
    if (meta) lines.push(`*${meta}*`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Plain-text rendering of a timeline for chat code blocks: one line per event
 * with a date column, long titles wrapped with a hanging indent. Newest first;
 * at most {@link MAX_TEXT_EVENTS} events are listed.
 */
export function renderTimelineText(events: TimelineEvent[]): string {
  if (events.length === 0) return "";
  const earliest = events.at(-1)!.date;
  const latest = events[0]!.date;
  const count = `${events.length} event${events.length === 1 ? "" : "s"}`;
  const range = earliest === latest ? earliest : `${earliest} → ${latest}`;
  const lines: string[] = [`Timeline · ${count} · ${range}`, ""];

  const shown = events.slice(0, MAX_TEXT_EVENTS);
  for (const event of shown) {
    lines.push(...wrapTitle(`${event.date}  `, event.title));
  }
  const hidden = events.length - shown.length;
  if (hidden > 0) lines.push(`… and ${hidden} more`);
  return lines.join("\n");
}

/** HTML code block for {@link renderTimelineText} (Matrix formatted_body, email). */
export function renderTimelineHtml(text: string): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

/** Wraps one title to the text width, indenting continuations to the prefix. */
function wrapTitle(prefix: string, title: string): string[] {
  const width = Math.max(24, TEXT_WIDTH - prefix.length);
  const words = title.split(/\s+/).filter(Boolean);
  const wrapped: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) wrapped.push(current);
  if (wrapped.length === 0) wrapped.push("");

  const indent = " ".repeat(prefix.length);
  return wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `${indent}${line}`));
}

function related(a: TimelineEvent, b: TimelineEvent): boolean {
  const entities = new Set(a.entities.map((entity) => entity.toLowerCase()));
  if (b.entities.some((entity) => entities.has(entity.toLowerCase()))) return true;

  const tags = new Set(a.tags.map((tag) => tag.toLowerCase()));
  if (!b.tags.some((tag) => tags.has(tag.toLowerCase()))) return false;
  return withinDays(a.date, b.date, RELATED_WINDOW_DAYS);
}

function withinDays(a: string, b: string, days: number): boolean {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return Math.abs(left - right) <= days * 24 * 60 * 60 * 1000;
}
