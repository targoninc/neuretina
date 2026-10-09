<script lang="ts">
  import { Switch } from "m3-svelte";
  import type { WorkflowInputEditorProps } from "../lib/workflowInputs";

  let { topics, value, disabled = false, capped = true, onchange }: WorkflowInputEditorProps =
    $props();

  const values = $derived(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  );

  function toggle(id: string): void {
    onchange(values.includes(id) ? values.filter((entry) => entry !== id) : [...values, id]);
  }
</script>

{#if topics.length === 0}
  <p class="muted">No topics yet. Create topics first, then pick the ones to cover.</p>
{:else}
  <div class="toggle-list" class:capped>
    {#each topics as topic (topic.id)}
      <label class="toggle-row" class:muted={topic.muted}>
        <Switch checked={values.includes(topic.id)} {disabled} onchange={() => toggle(topic.id)} />
        <span>{topic.name}{topic.muted ? " (muted)" : ""}</span>
      </label>
    {/each}
  </div>
{/if}

<style>
  .toggle-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
    padding: 0;
  }

  .toggle-list.capped {
    max-height: 12rem;
    overflow-y: auto;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--space-small);
    padding: 0 0;
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    cursor: pointer;
    user-select: none;
  }

  .toggle-row.muted {
    opacity: 0.65;
  }
</style>
