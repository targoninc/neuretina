import type { Component } from "svelte";
import type { Topic, WorkflowInputInfo } from "./api";
import WorkflowInputLanguage from "../components/WorkflowInputLanguage.svelte";
import WorkflowInputTopics from "../components/WorkflowInputTopics.svelte";

/** Props every workflow input editor receives; values are input ids. */
export interface WorkflowInputEditorProps {
  spec: WorkflowInputInfo;
  topics: Topic[];
  value: unknown;
  disabled?: boolean;
  capped?: boolean;
  onchange: (value: unknown) => void;
}

/** One editor per input kind; registering a kind here makes it editable. */
export const WORKFLOW_INPUT_EDITORS: Record<string, Component<WorkflowInputEditorProps>> = {
  topics: WorkflowInputTopics,
  language: WorkflowInputLanguage,
};
