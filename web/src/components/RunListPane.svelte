<script lang="ts">
  import { ListItem } from "m3-svelte";
  import type { WorkflowInfo, WorkflowRunInfo } from "../lib/api";
  import { clock } from "../lib/clock.svelte";
  import { formatRelativeTime } from "../lib/format";
  import { costLabel, durationLabel, triggerLabel } from "../lib/workflows";
  import DataList from "./DataList.svelte";
  import Pane from "./Pane.svelte";
  import RunStatusIcon from "./RunStatusIcon.svelte";

  interface Props {
    workflow: WorkflowInfo | null;
    runs: WorkflowRunInfo[];
    selectedRunId: string | null;
    onopen: (id: string) => void;
  }

  let { workflow, runs, selectedRunId, onopen }: Props = $props();
</script>

<Pane variant="list" title="Runs" subtitle={workflow?.id}>
  {#if workflow}
    <DataList items={runs} empty="No runs for this workflow yet.">
      {#snippet children(run)}
        <div class="entry" class:selected={selectedRunId === run.id}>
          <ListItem
            onclick={() => onopen(run.id)}
            overline={triggerLabel(run)}
            headline={`${run.workflow} · ${run.contextId}`}
            supporting={`${formatRelativeTime(run.startedAt, clock.now)} · ${durationLabel(run)}${run.cost ? ` · ${costLabel(run.cost)}` : ""}`}
          >
            {#snippet leading()}
              <RunStatusIcon status={run.status} />
            {/snippet}
          </ListItem>
        </div>
      {/snippet}
    </DataList>
  {:else}
    <p class="muted">Select a workflow to see its runs.</p>
  {/if}
</Pane>
