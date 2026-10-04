import type { TimelineEvent } from "./api";

/** One marker on the timeline: a single event or a cluster of close events. */
export interface TimelineGroup {
  key: string;
  /** Position along the axis, 0 (earliest) … 1 (latest); 0.5 when all share a time. */
  position: number;
  /** Cluster members, earliest first. */
  events: TimelineEvent[];
}

export interface TimelineGroupingOptions {
  /** Rendered axis length in pixels; 0 while the track is not measured yet. */
  length?: number;
  /** Minimum distance between two markers in pixels. */
  minGap?: number;
}

/** Markers closer than this are rendered as one group. */
export const MIN_MARKER_GAP_PX = 96;
const FALLBACK_LENGTH_PX = 900;

/** Midnight of an event's calendar day, in local time. */
export function eventTime(event: TimelineEvent): number {
  const parsed = Date.parse(`${event.date}T00:00:00`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** "12 Mar 2026" for popovers. */
export function formatEventWhen(event: TimelineEvent): string {
  const date = new Date(`${event.date}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? event.date
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Up to this many titles show per marker; the rest collapse into one row. */
export const MAX_STACKED_LABELS = 2;

/** One title (or the "+n more…" row) shown under a timeline marker. */
export interface TimelineLabelEntry {
  key: string;
  label: string;
  events: TimelineEvent[];
  more?: boolean;
}

/** At most two titles per marker; anything beyond becomes one "+n more…" row. */
export function timelineLabelEntries(group: {
  key: string;
  events: TimelineEvent[];
}): TimelineLabelEntry[] {
  const entries: TimelineLabelEntry[] = group.events
    .slice(0, MAX_STACKED_LABELS)
    .map((event) => ({ key: event.id, label: event.title, events: [event] }));
  const rest = group.events.slice(MAX_STACKED_LABELS);
  if (rest.length > 0) {
    entries.push({
      key: `${group.key}:more`,
      label: `+${rest.length} more…`,
      events: rest,
      more: true,
    });
  }
  return entries;
}

/** Number of label lines a marker stacks, for sizing the track. */
export function timelineLabelLines(group: { events: TimelineEvent[] }): number {
  return Math.min(group.events.length, MAX_STACKED_LABELS + 1);
}

/** Chronological order; events without a time sit at the start of their day. */
export function sortTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(
    (a, b) => eventTime(a) - eventTime(b) || a.id.localeCompare(b.id),
  );
}

/**
 * Places events on a 0..1 axis and merges ones that would sit closer than
 * `minGap` pixels into a single marker. A marker sits at the average of its
 * cluster, so two markers stay at least `minGap` apart along the supplied axis
 * length.
 *
 * Positions snap to the calendar day, on the same day-based domain the scale
 * marks use, so every marker sits exactly under its date mark; the time only
 * orders events within the day.
 */
export function groupTimelineEvents(
  events: TimelineEvent[],
  options: TimelineGroupingOptions = {},
): TimelineGroup[] {
  if (events.length === 0) return [];

  const sorted = sortTimelineEvents(events);
  const domain = timelineDomain(sorted);

  const length = options.length && options.length > 0 ? options.length : FALLBACK_LENGTH_PX;
  const gap = (options.minGap ?? MIN_MARKER_GAP_PX) / length;

  const clusters: Array<{ position: number; count: number; events: TimelineEvent[] }> = [];
  for (const event of sorted) {
    const position = domainPosition(startOfDay(eventTime(event)), domain);
    const current = clusters[clusters.length - 1];
    if (current && position - current.position < gap) {
      current.count += 1;
      current.position += (position - current.position) / current.count;
      current.events.push(event);
    } else {
      clusters.push({ position, count: 1, events: [event] });
    }
  }

  return clusters.map((cluster) => ({
    key: cluster.events.map((event) => event.id).join(":"),
    position: cluster.position,
    events: cluster.events,
  }));
}

/** One marker slot on the horizontal axis; keeps its titles readable. */
export const HORIZONTAL_SLOT_PX = 340;
/** Title column inside a slot. */
export const HORIZONTAL_LABEL_PX = 300;
/** Room left of the first marker for its centered date label. */
export const HORIZONTAL_EDGE_PX = 40;
const HORIZONTAL_EDGE_END_PX = HORIZONTAL_LABEL_PX + 12;

/** Usable axis length inside a horizontal content width, clear of the edges. */
export function horizontalAxisLength(contentWidth: number): number {
  return Math.max(0, contentWidth - HORIZONTAL_EDGE_PX - HORIZONTAL_EDGE_END_PX);
}

/**
 * Content width for the horizontal axis: every scale mark gets a full slot, so
 * markers stay readable; when there are few marks the box itself is the width.
 * A content wider than the viewport is meant to be scrolled.
 */
export function horizontalTimelineWidth(markCount: number, viewportWidth: number): number {
  const marks = Math.max(1, markCount);
  return Math.max(
    viewportWidth,
    HORIZONTAL_EDGE_PX +
      HORIZONTAL_EDGE_END_PX +
      (marks - 1) * HORIZONTAL_SLOT_PX,
  );
}

/** Maps a 0..1 time position onto a 0..1 horizontal content position. */
export function horizontalPosition(position: number, contentWidth: number): number {
  const axis = horizontalAxisLength(contentWidth);
  if (contentWidth <= 0 || axis <= 0) return position;
  return (HORIZONTAL_EDGE_PX + position * axis) / contentWidth;
}

/** One calendar day of the compact vertical layout, earliest event first. */
export interface TimelineDay {
  key: string;
  events: TimelineEvent[];
}

/**
 * Groups events into calendar days. The vertical layout stacks these days in
 * order with a fixed `--space-small` gap instead of stretching them apart by
 * their distance in time, so a handful of days never leaves empty stretches.
 */
export function groupTimelineDays(events: TimelineEvent[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  for (const event of sortTimelineEvents(events)) {
    const current = days.at(-1);
    if (current && current.key === event.date) current.events.push(event);
    else days.push({ key: event.date, events: [event] });
  }
  return days;
}

/** "28 Sep" for the day rail of the vertical layout. */
export function formatEventDay(event: TimelineEvent): string {
  return formatDay(eventTime(event));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A unit with more marks than this steps up to the next coarser one. */
export const MAX_SCALE_MARKS = 12;

export type TimelineScaleUnit = "date" | "week" | "month" | "year";

/** One tick label on the axis (a date, calendar week, month or year). */
export interface TimelineScaleMark {
  key: string;
  /** Position along the axis, 0 (first day) … 1 (last day). */
  position: number;
  label: string;
}

export interface TimelineScale {
  unit: TimelineScaleUnit;
  marks: TimelineScaleMark[];
}

interface RawMark {
  time: number;
  label: string;
}

interface TimelineDomain {
  start: number;
  end: number;
}

/**
 * Picks the axis scale from the spread of the events: direct dates while they
 * span at most 12 days, then ISO week numbers (1 … 53), months and finally
 * years. Whenever a unit would need more than {@link MAX_SCALE_MARKS} marks,
 * the next coarser unit is used.
 */
export function timelineScale(events: TimelineEvent[]): TimelineScale {
  if (events.length === 0) return { unit: "date", marks: [] };
  const domain = timelineDomain(events);
  const candidates: Array<{ unit: TimelineScaleUnit; marks: RawMark[] }> = [
    { unit: "date", marks: dateMarks(domain) },
    { unit: "week", marks: weekMarks(domain) },
    { unit: "month", marks: monthMarks(domain) },
    { unit: "year", marks: yearMarks(domain) },
  ];
  const chosen =
    candidates.find(
      (candidate) => candidate.marks.length > 0 && candidate.marks.length <= MAX_SCALE_MARKS,
    ) ??
    candidates.filter((candidate) => candidate.marks.length > 0).at(-1) ??
    candidates[0]!;

  return {
    unit: chosen.unit,
    marks: chosen.marks.map((mark) => ({
      key: `${chosen.unit}:${mark.time}`,
      position: domainPosition(mark.time, domain),
      label: mark.label,
    })),
  };
}

/** First and last day covered by the events (both at midnight). */
export function timelineDomain(events: TimelineEvent[]): TimelineDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const time = eventTime(event);
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { start: 0, end: 0 };
  return { start: startOfDay(min), end: startOfDay(max) };
}

function domainPosition(time: number, domain: TimelineDomain): number {
  const span = domain.end - domain.start;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (time - domain.start) / span));
}

function dateMarks(domain: TimelineDomain): RawMark[] {
  const marks: RawMark[] = [];
  const cursor = new Date(domain.start);
  while (cursor.getTime() <= domain.end) {
    marks.push({ time: cursor.getTime(), label: formatDay(cursor.getTime()) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return marks;
}

function weekMarks(domain: TimelineDomain): RawMark[] {
  const marks: RawMark[] = [];
  const cursor = new Date(domain.start);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  while (cursor.getTime() <= domain.end) {
    if (cursor.getTime() >= domain.start) {
      marks.push({ time: cursor.getTime(), label: `W${isoWeek(cursor)}` });
    }
    cursor.setDate(cursor.getDate() + 7);
  }
  return marks;
}

function monthMarks(domain: TimelineDomain): RawMark[] {
  const marks: RawMark[] = [];
  const withYear = new Date(domain.start).getFullYear() !== new Date(domain.end).getFullYear();
  const cursor = new Date(domain.start);
  cursor.setDate(1);
  while (cursor.getTime() <= domain.end) {
    if (cursor.getTime() >= domain.start) {
      marks.push({ time: cursor.getTime(), label: formatMonth(cursor.getTime(), withYear) });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return marks;
}

function yearMarks(domain: TimelineDomain): RawMark[] {
  const marks: RawMark[] = [];
  const cursor = new Date(domain.start);
  cursor.setMonth(0, 1);
  while (cursor.getTime() <= domain.end) {
    if (cursor.getTime() >= domain.start) {
      marks.push({ time: cursor.getTime(), label: String(cursor.getFullYear()) });
    }
    cursor.setFullYear(cursor.getFullYear() + 1);
  }
  return marks;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDay(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatMonth(time: number, withYear: boolean): string {
  const date = new Date(time);
  const label = date.toLocaleDateString(undefined, { month: "short" });
  if (!withYear) return label;
  return `${label} '${String(date.getFullYear() % 100).padStart(2, "0")}`;
}

/** ISO-8601 week number (1 … 53) of a local date. */
function isoWeek(date: Date): number {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}
