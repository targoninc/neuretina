<script lang="ts">
  import { Button } from "m3-svelte";
  import type { DeliveryChannelInfo, Topic, WorkflowInfo } from "../lib/api";
  import { commands } from "../lib/commands";
  import { reportError, reportSuccess } from "../lib/feedback";
  import {
    assignmentKey,
    inputFilled,
    serializeAssignments,
    serializeInputs,
    splitAssignmentKey,
    workflowHeadline,
    workflowSummary,
  } from "../lib/workflows";
  import DeleteIconButton from "./DeleteIconButton.svelte";
  import Pane from "./Pane.svelte";
  import WorkflowForm from "./WorkflowForm.svelte";
  import WorkflowSteps from "./WorkflowSteps.svelte";

  interface Props {
    workflow: WorkflowInfo | null;
    editable: boolean;
    user: boolean;
    resettable: boolean;
    deleting: boolean;
    ondelete: () => void;
    /** Re-reads the workflow list after a save. */
    onchanged: () => Promise<void>;
  }

  let { workflow, editable, user, resettable, deleting, ondelete, onchanged }: Props = $props();

  // `editorId` records which workflow the fields hold; the *Base* snapshots are
  // the saved values the dirty check compares against.
  let editorId = $state<string | null>(null);
  let editorName = $state("");
  let editorInputs = $state<Record<string, unknown>>({});
  let editorAssignments = $state<Record<string, string[]>>({});
  let editorStopAfter = $state<string | null>(null);
  let editorBaseName = $state("");
  let editorBaseInputs = $state("");
  let editorBaseAssignments = $state("");
  let editorBaseStopAfter = $state<string | null>(null);
  let editorLoading = $state(false);
  let saving = $state(false);

  let topics = $state<Topic[]>([]);
  let channels = $state<DeliveryChannelInfo[]>([]);

  const ready = $derived(workflow !== null && editorId === workflow.id && !editorLoading);
  const dirty = $derived(
    ready &&
      (editorName.trim() !== editorBaseName ||
        serializeInputs(editorInputs) !== editorBaseInputs ||
        serializeAssignments(editorAssignments) !== editorBaseAssignments ||
        editorStopAfter !== editorBaseStopAfter),
  );
  /** Every required input holds a value (e.g. at least one topic). */
  const inputsValid = $derived(
    (workflow?.inputs ?? []).every((spec) => !spec.required || inputFilled(editorInputs[spec.id])),
  );
  const canSave = $derived(
    ready && dirty && !saving && editorName.trim() !== "" && inputsValid,
  );
  const assignedChannels = $derived(
    new Set(Object.values(editorAssignments).flat()).size,
  );

  /** Channel ids assigned to a workflow's step outputs, keyed "step/output". */
  async function loadAssignments(id: string): Promise<Record<string, string[]>> {
    const attachments = await commands.delivery.attachments();
    const assignments: Record<string, string[]> = {};
    for (const attachment of attachments) {
      if (attachment.workflow !== id) continue;
      const key = assignmentKey(attachment.step, attachment.output);
      (assignments[key] ??= []).push(attachment.channelId);
    }
    return assignments;
  }

  // Seeds the editor with the workflow's saved settings.
  async function loadEditor(target: WorkflowInfo): Promise<void> {
    const id = target.id;
    editorId = id;
    editorLoading = true;
    try {
      const [loadedTopics, loadedChannels, assignments] = await Promise.all([
        commands.topics.list(),
        commands.delivery.channels(),
        loadAssignments(id),
      ]);
      if (editorId !== id) return;
      topics = loadedTopics;
      channels = loadedChannels;

      const inputs: Record<string, unknown> = {};
      for (const spec of target.inputs) {
        const stored = target.inputValues?.[spec.id];
        if (stored !== undefined) {
          inputs[spec.id] = stored;
        } else if (spec.kind === "topics" && id === "briefing") {
          // The un-customized briefing covers all topics until pinned.
          inputs[spec.id] = loadedTopics.map((topic) => topic.id);
        } else {
          // An empty list / unset scalar means "use the configured default".
          inputs[spec.id] = spec.multiple ? [] : "";
        }
      }

      editorName = target.user ? target.title : id;
      editorInputs = inputs;
      editorAssignments = assignments;
      editorStopAfter = target.stopAfter ?? null;
      editorBaseName = editorName;
      editorBaseInputs = serializeInputs(inputs);
      editorBaseAssignments = serializeAssignments(assignments);
      editorBaseStopAfter = editorStopAfter;
    } catch (error) {
      reportError(error);
    } finally {
      if (editorId === id) editorLoading = false;
    }
  }

  // Seed the editor when a different workflow is selected; a background
  // refresh of the list must not clobber unsaved edits.
  $effect(() => {
    const target = workflow;
    if (!target) {
      editorId = null;
      return;
    }
    if (editorId === target.id) return;
    void loadEditor(target);
  });

  function toggleAssignment(step: string, output: string, channelId: string): void {
    const key = assignmentKey(step, output);
    const current = editorAssignments[key] ?? [];
    editorAssignments = {
      ...editorAssignments,
      [key]: current.includes(channelId)
        ? current.filter((entry) => entry !== channelId)
        : [...current, channelId],
    };
  }

  function toggleStopAfter(stepId: string | null): void {
    editorStopAfter = stepId;
  }

  // Attaches/detaches channels so each step output matches `assignments`.
  async function reconcileAssignments(
    id: string,
    assignments: Record<string, string[]>,
  ): Promise<void> {
    const current = await loadAssignments(id);
    const keys = new Set([...Object.keys(current), ...Object.keys(assignments)]);
    for (const key of keys) {
      const [step, output] = splitAssignmentKey(key);
      const target = { workflow: id, step, output };
      const wanted = assignments[key] ?? [];
      const existing = current[key] ?? [];
      for (const channelId of wanted) {
        if (!existing.includes(channelId)) await commands.delivery.attach(target, channelId);
      }
      for (const channelId of existing) {
        if (!wanted.includes(channelId)) await commands.delivery.detach(target, channelId);
      }
    }
  }

  // Saves the editor: the name/inputs row first (an upsert also customizes a
  // built-in workflow), then the step-output channel assignments.
  async function save(): Promise<void> {
    const id = editorId;
    const target = workflow;
    if (!id || !target || !canSave) return;
    saving = true;
    try {
      const name = editorName.trim();
      const inputs = { ...editorInputs };
      const nameChanged = name !== editorBaseName;
      const inputsChanged = serializeInputs(inputs) !== editorBaseInputs;
      const stopChanged = editorStopAfter !== editorBaseStopAfter;
      if (target.user || nameChanged || inputsChanged || stopChanged) {
        await commands.userWorkflows.update(id, {
          name,
          inputs,
          stopAfter: editorStopAfter,
        });
      }
      await reconcileAssignments(id, editorAssignments);
      editorBaseName = name;
      editorBaseInputs = serializeInputs(inputs);
      editorBaseAssignments = serializeAssignments(editorAssignments);
      editorBaseStopAfter = editorStopAfter;
      reportSuccess("Workflow saved");
      await onchanged();
    } catch (error) {
      reportError(error);
    } finally {
      saving = false;
    }
  }
</script>

<Pane
  variant="detail"
  title={workflow ? workflowHeadline(workflow) : "Workflow details"}
  subtitle={workflow ? workflowSummary(workflow, assignedChannels) : undefined}
>
  {#snippet actions()}
    {#if editable}
      <Button variant="filled" onclick={() => void save()} disabled={!canSave}>Save changes</Button>
    {/if}
    {#if user}
      <DeleteIconButton
        title={resettable ? "Reset workflow" : "Delete workflow"}
        onclick={ondelete}
        disabled={deleting}
      />
    {/if}
  {/snippet}

  {#if !workflow}
    <p class="muted">Select a workflow to see and edit its settings.</p>
  {:else if !ready}
    <p class="muted">Loading…</p>
  {:else}
    {#if editable}
      <div class="detail-form">
        <WorkflowForm
          bind:name={editorName}
          bind:inputs={editorInputs}
          specs={workflow.inputs}
          {topics}
          disabled={saving}
          capped={false}
          onenter={() => void save()}
        />
      </div>
    {:else}
      <div class="facts">
        <div class="fact">
          <span class="label">Description</span>
          <span>{workflow.description}</span>
        </div>
        <div class="fact">
          <span class="label">Triggers</span>
          <span>{workflow.triggers.join(", ") || "none"}</span>
        </div>
        <div class="fact">
          <span class="label">Context</span>
          <span>{workflow.contextId ?? "default context"}</span>
        </div>
      </div>
      <p class="muted hint">This workflow is built in and has no editable settings.</p>
    {/if}

    <h3 class="subhead">Steps</h3>
    <WorkflowSteps
      steps={workflow.steps}
      {channels}
      assignments={editorAssignments}
      editable={editable}
      stopAfter={editorStopAfter}
      ontoggle={toggleAssignment}
      onstop={toggleStopAfter}
    />
  {/if}
</Pane>

<style>
  .detail-form {
    margin-bottom: var(--space-large);
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
    margin-bottom: var(--space-medium);
  }

  .fact {
    display: flex;
    gap: var(--space-small);
  }

  .label {
    min-width: 6rem;
    color: var(--m3c-on-surface-variant);
  }

  .hint {
    margin-top: var(--space-large);
    max-width: 36rem;
  }

  .subhead {
    padding-inline: var(--space-large);
  }
</style>
