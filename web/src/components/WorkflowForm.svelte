<script lang="ts">
  import { TextFieldOutlined } from "m3-svelte";
  import type { Topic, WorkflowInputInfo } from "../lib/api";
  import { WORKFLOW_INPUT_EDITORS } from "../lib/workflowInputs";

  interface Props {
    name: string;
    inputs: Record<string, unknown>;
    specs: WorkflowInputInfo[];
    topics: Topic[];
    disabled?: boolean;
    /** Cap editors with their own scrollbar (dialog); the details tab grows. */
    capped?: boolean;
    /** Triggered by Enter in the name field. */
    onenter?: () => void;
  }

  let {
    name = $bindable(),
    inputs = $bindable(),
    specs,
    topics,
    disabled = false,
    capped = true,
    onenter,
  }: Props = $props();

  function setValue(spec: WorkflowInputInfo, value: unknown): void {
    inputs = { ...inputs, [spec.id]: value };
  }
</script>

<div class="workflow-fields">
  <TextFieldOutlined label="Name" bind:value={name} {disabled} enter={onenter} />

  {#each specs as spec (spec.id)}
    {@const Editor = WORKFLOW_INPUT_EDITORS[spec.kind]}
    <div class="field-group">
      <h3 class="group-label">{spec.title}</h3>
      {#if Editor}
        <Editor
          {spec}
          {topics}
          value={inputs[spec.id]}
          {disabled}
          {capped}
          onchange={(value) => setValue(spec, value)}
        />
      {:else}
        <p class="muted">This input kind is not editable in the interface yet.</p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .workflow-fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-large);
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-large);
  }

  .group-label {
    @apply --m3-title-small;
    color: var(--m3c-on-surface-variant);
  }

  .spec-note {
    font-size: var(--font-medium);
  }
</style>
