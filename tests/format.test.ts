import { describe, expect, test } from "bun:test";
import { formatDuration, formatRelativeTime, formatUsd } from "../web/src/lib/format.ts";

describe("formatUsd", () => {
  test("always uses two decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00004)).toBe("$0.00");
    expect(formatUsd(1.239)).toBe("$1.24");
  });
});

describe("formatDuration", () => {
  test("switches to minutes after a minute", () => {
    expect(formatDuration(201_300)).toBe("3m 21s");
    expect(formatDuration(65_000)).toBe("1m 05s");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);

  test("renders relative time in the past", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now, "en")).toBe("2 hours ago");
    expect(formatRelativeTime(now - 25 * 60 * 60_000, now, "en")).toBe("yesterday");
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now, "en")).toBe("3 days ago");
  });

  test("handles recent, future and missing timestamps", () => {
    expect(formatRelativeTime(now - 30_000, now, "en")).toBe("now");
    expect(formatRelativeTime(now + 2 * 60 * 60_000, now, "en")).toBe("in 2 hours");
    expect(formatRelativeTime(undefined, now, "en")).toBe("–");
  });
});
