import { describe, expect, test } from "bun:test";
import type { TimelineEvent } from "../web/src/lib/api.ts";
import {
  HORIZONTAL_SLOT_PX,
  MAX_SCALE_MARKS,
  MIN_MARKER_GAP_PX,
  formatEventDay,
  formatEventWhen,
  groupTimelineDays,
  groupTimelineEvents,
  horizontalAxisLength,
  horizontalPosition,
  horizontalTimelineWidth,
  timelineScale,
} from "../web/src/lib/timeline.ts";

function event(partial: Partial<TimelineEvent> & { id: string; date: string }): TimelineEvent {
  return {
    entities: [],
    tags: [],
    title: partial.id,
    description: "",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("groupTimelineEvents", () => {
  test("returns nothing for an empty timeline", () => {
    expect(groupTimelineEvents([])).toEqual([]);
  });

  test("centers a single event regardless of its date", () => {
    const groups = groupTimelineEvents([event({ id: "a", date: "2026-01-01" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.position).toBe(0.5);
    expect(groups[0]?.events.map((entry) => entry.id)).toEqual(["a"]);
  });

  test("orders by date from earliest to latest", () => {
    const groups = groupTimelineEvents(
      [
        event({ id: "late", date: "2026-01-31" }),
        event({ id: "b", date: "2026-01-01" }),
        event({ id: "a", date: "2026-01-01" }),
      ],
      { length: 1000 },
    );
    expect(groups.flatMap((group) => group.events.map((entry) => entry.id))).toEqual([
      "a",
      "b",
      "late",
    ]);
    expect(groups[0]?.events[0]?.id).toBe("a");
    expect(groups[0]!.position).toBeLessThan(groups[1]?.position ?? 1);
    expect(groups.at(-1)?.events.at(-1)?.id).toBe("late");
    expect(groups.at(-1)?.position).toBe(1);
  });

  test("merges events that would overlap on the rendered axis", () => {
    const groups = groupTimelineEvents(
      [
        event({ id: "a", date: "2026-03-01" }),
        event({ id: "b", date: "2026-03-01" }),
        event({ id: "c", date: "2026-03-02" }),
        event({ id: "d", date: "2026-04-01" }),
      ],
      { length: 600 },
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.events.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(groups[1]?.events.map((entry) => entry.id)).toEqual(["d"]);
  });

  test("keeps markers on the same day grid as the scale marks", () => {
    const events = [
      event({ id: "a", date: "2026-03-01" }),
      event({ id: "b", date: "2026-03-02" }),
      event({ id: "c", date: "2026-03-03" }),
    ];
    const groups = groupTimelineEvents(events, { length: 3000, minGap: 1 });
    const scale = timelineScale(events);

    expect(groups.map((group) => group.position)).toEqual(
      scale.marks.map((mark) => mark.position),
    );
  });

  test("keeps markers at least minGap pixels apart on dense timelines", () => {
    const length = 400;
    const events = Array.from({ length: 40 }, (_, index) =>
      event({ id: `e${index}`, date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}` }),
    );
    const groups = groupTimelineEvents(events, { length, minGap: MIN_MARKER_GAP_PX });
    expect(groups.length).toBeGreaterThan(1);
    for (let index = 1; index < groups.length; index += 1) {
      const distance = groups[index]!.position - groups[index - 1]!.position;
      expect(distance * length).toBeGreaterThanOrEqual(MIN_MARKER_GAP_PX - 1e-9);
    }
    // Every event still appears exactly once across the groups.
    const ids = groups.flatMap((group) => group.events.map((entry) => entry.id));
    expect(ids).toHaveLength(events.length);
    expect(new Set(ids).size).toBe(events.length);
  });
});

describe("horizontal layout", () => {
  test("gives every scale mark a slot, falling back to the viewport width", () => {
    expect(horizontalTimelineWidth(2, 900)).toBe(900);
    const width = horizontalTimelineWidth(6, 900);
    expect(width).toBeGreaterThan(900);
    expect(width - horizontalTimelineWidth(5, 0)).toBe(HORIZONTAL_SLOT_PX);
  });

  test("keeps the first and last positions clear of the edges", () => {
    const width = horizontalTimelineWidth(6, 900);
    const first = horizontalPosition(0, width) * width;
    const last = horizontalPosition(1, width) * width;
    // Room for the centered date label on the left and the title column right.
    expect(first).toBeGreaterThanOrEqual(30);
    expect(width - last).toBeGreaterThanOrEqual(300);
    expect(horizontalAxisLength(width)).toBeGreaterThan(0);
    expect(horizontalPosition(0.5, 0)).toBe(0.5);
  });
});

describe("groupTimelineDays", () => {
  test("groups by calendar day, oldest first", () => {
    const days = groupTimelineDays([
      event({ id: "late", date: "2026-03-02" }),
      event({ id: "b", date: "2026-03-01" }),
      event({ id: "a", date: "2026-03-01" }),
      event({ id: "other", date: "2026-03-02" }),
    ]);

    expect(days.map((day) => day.key)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(days[0]?.events.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(days[1]?.events.map((entry) => entry.id)).toEqual(["late", "other"]);
    expect(groupTimelineDays([])).toEqual([]);
  });
});

describe("formatEventDay", () => {
  test("shows the day without the year", () => {
    const label = formatEventDay(event({ id: "a", date: "2026-03-12" }));
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain("2026");
  });
});

describe("formatEventWhen", () => {
  test("shows the calendar date", () => {
    const label = formatEventWhen(event({ id: "a", date: "2026-03-12" }));
    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain("2026");
  });
});

describe("timelineScale", () => {
  test("has no marks for an empty timeline", () => {
    expect(timelineScale([])).toEqual({ unit: "date", marks: [] });
  });

  test("marks a single day once, in the middle", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2026-03-12" }),
      event({ id: "b", date: "2026-03-12" }),
    ]);
    expect(scale.unit).toBe("date");
    expect(scale.marks).toHaveLength(1);
    expect(scale.marks[0]?.position).toBe(0.5);
    expect(scale.marks[0]?.label.length).toBeGreaterThan(0);
  });

  test("uses direct dates while the spread is at most 12 days", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2026-03-01" }),
      event({ id: "b", date: "2026-03-05" }),
    ]);
    expect(scale.unit).toBe("date");
    expect(scale.marks).toHaveLength(5);
    expect(scale.marks.map((mark) => mark.position)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  test("switches to calendar weeks once dates exceed 12 entries", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2026-03-01" }),
      event({ id: "b", date: "2026-03-21" }),
    ]);
    expect(scale.unit).toBe("week");
    expect(scale.marks.length).toBeLessThanOrEqual(MAX_SCALE_MARKS);
    for (const mark of scale.marks) {
      expect(mark.label).toMatch(/^W\d{1,2}$/);
      expect(mark.position).toBeGreaterThanOrEqual(0);
      expect(mark.position).toBeLessThanOrEqual(1);
    }
  });

  test("switches to months once weeks exceed 12 entries", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2026-01-15" }),
      event({ id: "b", date: "2026-06-15" }),
    ]);
    expect(scale.unit).toBe("month");
    expect(scale.marks).toHaveLength(5);
  });

  test("switches to years once months exceed 12 entries", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2024-06-01" }),
      event({ id: "b", date: "2026-03-01" }),
    ]);
    expect(scale.unit).toBe("year");
    expect(scale.marks.map((mark) => mark.label)).toEqual(["2025", "2026"]);
  });

  test("keeps years for very long spreads", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2000-01-01" }),
      event({ id: "b", date: "2020-01-01" }),
    ]);
    expect(scale.unit).toBe("year");
    expect(scale.marks).toHaveLength(21);
  });

  test("adds the year to month labels when the scale crosses a year", () => {
    const scale = timelineScale([
      event({ id: "a", date: "2026-11-15" }),
      event({ id: "b", date: "2027-03-10" }),
    ]);
    expect(scale.unit).toBe("month");
    expect(scale.marks.at(-1)?.label).toContain("'27");
  });
});
