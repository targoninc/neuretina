import iconHistory from "@ktibow/iconset-material-symbols/history";
import iconInfo from "@ktibow/iconset-material-symbols/info";
import type { WorkflowInfo, WorkflowRunDetail, WorkflowRunInfo } from "./api";

/** Tabs shown right of the workflow list. */
export const WORKFLOW_TABS = [
  { name: "Details", value: "details", icon: iconInfo },
  { name: "Runs", value: "runs", icon: iconHistory },
];

/** Built-in briefing and user workflows are editable; others are read-only. */
export function isEditableWorkflow(workflow: WorkflowInfo): boolean {
  return workflow.user === true || workflow.id === "briefing";
}

/** A customized built-in briefing is reset (not deleted) on remove. */
export function isBriefingReset(workflow: WorkflowInfo): boolean {
  return workflow.id === "briefing" && workflow.user === true;
}

/** Query for the current workflow view state. */
export function workflowQuery(contextFilter: string): { context?: string } {
  return { context: contextFilter === "all" ? undefined : contextFilter };
}

/** Key a step-output channel assignment is stored under. */
export function assignmentKey(step: string, output: string): string {
  return `${step}/${output}`;
}

export function splitAssignmentKey(key: string): [string, string] {
  const [step = "", output = ""] = key.split("/");
  return [step, output];
}

/** Order-insensitive snapshot of the input editor's values. */
export function serializeInputs(inputs: Record<string, unknown>): string {
  const entries = Object.entries(inputs)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

export function inputFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

/** Order-insensitive snapshot of the channel assignments (empty keys dropped). */
export function serializeAssignments(assignments: Record<string, string[]>): string {
  const entries = Object.entries(assignments)
    .filter(([, channelIds]) => channelIds.length > 0)
    .map(([key, channelIds]) => [key, [...channelIds].sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

export function workflowOverline(workflow: WorkflowInfo): string {
  return workflow.user ? "user workflow" : workflow.contextId ?? "default context";
}

export function workflowHeadline(workflow: WorkflowInfo): string {
  return workflow.user ? workflow.title : workflow.id;
}

/** Details header subtitle with the workflow's configured inputs. */
export function workflowSummary(workflow: WorkflowInfo, channelCount: number): string {
  if (!workflow.user) {
    return `${workflow.description} · triggers ${workflow.triggers.join(", ") || "none"}`;
  }
  const topicIds = workflow.inputValues?.topics;
  const topicCount = Array.isArray(topicIds) ? topicIds.length : 0;
  return `${topicCount} topic(s) · ${channelCount} channel(s)`;
}

export function triggerLabel(run: WorkflowRunInfo): string {
  const detail = run.triggerDetail ?? {};
  const origin =
    (typeof detail.jobName === "string" && detail.jobName) ||
    (typeof detail.sender === "string" && detail.sender) ||
    (typeof detail.source === "string" && detail.source) ||
    undefined;
  return origin ? `${run.trigger} · ${origin}` : run.trigger;
}

export function durationLabel(run: WorkflowRunInfo): string {
  if (!run.finishedAt) return "running…";
  const ms = run.finishedAt - run.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatUsd(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

export function costLabel(cost: { totalUsd: number; complete: boolean }): string {
  return formatUsd(cost.totalUsd);
}

export function outputPreview(run: WorkflowRunDetail): string {
  if (run.error) return run.error;
  if (run.output === undefined || run.output === null) return "–";
  const output = run.output as Record<string, unknown>;
  if (typeof output.answer === "string") return output.answer;
  if (typeof output.reportId === "string") return `report ${output.reportId}`;
  if (typeof output.markdown === "string") return `${output.markdown.slice(0, 200)}…`;
  return JSON.stringify(run.output).slice(0, 300);
}
