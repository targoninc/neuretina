import { describe, expect, test } from "bun:test";
import { parseToolDetail, reportRevision } from "../web/src/lib/statusDetail.ts";

describe("status detail", () => {
  test("parses report revisions", () => {
    const detail = JSON.stringify({ reportDiff: { before: "# A", after: "# B" } });
    const parsed = parseToolDetail(detail);
    expect(parsed).not.toBeNull();
    expect(reportRevision(parsed)).toEqual({ before: "# A", after: "# B" });
  });

  test("keeps parsing tool input/output details", () => {
    const parsed = parseToolDetail(JSON.stringify({ input: { q: "x" }, output: 1 }));
    expect(parsed?.input).toEqual({ q: "x" });
    expect(reportRevision(parsed)).toBeNull();
  });

  test("ignores unrelated JSON, plain text and unchanged revisions", () => {
    expect(parseToolDetail('{"foo":1}')).toBeNull();
    expect(parseToolDetail("not json")).toBeNull();
    expect(parseToolDetail(undefined)).toBeNull();
    const unchanged = parseToolDetail(
      JSON.stringify({ reportDiff: { before: "# A", after: "# A" } }),
    );
    expect(reportRevision(unchanged)).toBeNull();
  });
});
