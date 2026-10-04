<script lang="ts">
  import { Button, Chip, Icon, ListItem } from "m3-svelte";
  import iconChevronRight from "@ktibow/iconset-material-symbols/chevron-right";
  import iconPayments from "@ktibow/iconset-material-symbols/payments";
  import iconSchedule from "@ktibow/iconset-material-symbols/schedule";
  import type { ArtifactInfo, DeliveryRecord, WorkflowRunDetail } from "../lib/api";
  import { isReportContainer } from "../lib/artifacts";
  import { formatDateTime, formatRelativeTime } from "../lib/format";
  import { costLabel, outputPreview, triggerLabel } from "../lib/workflows";
  import DataList from "./DataList.svelte";
  import DeleteIconButton from "./DeleteIconButton.svelte";
  import Pane from "./Pane.svelte";
  import RunStatusIcon from "./RunStatusIcon.svelte";
  import StatusFeedPanel from "./StatusFeed.svelte";

  interface Props {
    run: WorkflowRunDetail | null;
    deliveries: DeliveryRecord[];
    deleting: boolean;
    cancelling: boolean;
    ondelete: () => void;
    oncancel: () => void;
    onopenartifact: (artifact: ArtifactInfo) => void;
  }

  let { run, deliveries, deleting, cancelling, ondelete, oncancel, onopenartifact }: Props = $props();

  const artifacts = $derived(run ? run.artifacts.filter((artifact) => !isReportContainer(artifact)) : []);
</script>

<Pane
  variant="detail"
  title={run ? `Run ${run.id.slice(0, 8)}` : "Run details"}
  subtitle={run ? `${run.workflow} · ${run.contextId} · ${triggerLabel(run)}` : undefined}
>
  {#snippet actions()}
    {#if run}
      <RunStatusIcon status={run.status} size={20} />
      <Chip variant="assist" icon={iconSchedule}>
        {formatRelativeTime(run.startedAt)}
      </Chip>
      {#if run.cost}
        <Chip variant="assist" icon={iconPayments}>{costLabel(run.cost)}</Chip>
      {/if}
      {#if run.status === "running"}
        <span class="danger">
          <Button variant="tonal" iconType="left" onclick={oncancel} disabled={cancelling}>
            Cancel
          </Button>
        </span>
      {/if}
      <DeleteIconButton title="Delete run" onclick={ondelete} disabled={deleting} />
    {/if}
  {/snippet}

  {#if run}
    <p class="preview">{outputPreview(run)}</p>

    <StatusFeedPanel
      runId={run.id}
      title="Run activity"
      empty="No activity recorded for this run."
    />

    <h3 class="subhead">Artifacts</h3>
    <DataList items={artifacts} empty="This run produced no artifacts.">
      {#snippet children(artifact)}
        <div class="entry">
          <ListItem
            onclick={() => onopenartifact(artifact)}
            overline={artifact.kind}
            headline={artifact.name ?? artifact.id.slice(0, 8)}
            supporting={`${artifact.contentType} · ${formatDateTime(artifact.createdAt)}`}
          >
            {#snippet trailing()}
              <Icon icon={iconChevronRight} />
            {/snippet}
          </ListItem>
        </div>
      {/snippet}
    </DataList>

    {#if deliveries.length > 0}
      <h3 class="subhead">Deliveries</h3>
      <DataList items={deliveries} empty="">
        {#snippet children(record)}
          <div class="delivery">
            <span class="provider-tag delivery-status" data-status={record.status}>
              {record.status}
            </span>
            <div class="delivery-info">
              <span class="delivery-channel">{record.channelId}</span>
              {#if record.error}
                <span class="delivery-error">{record.error}</span>
              {/if}
            </div>
            <span class="muted delivery-kind">{record.kind}</span>
          </div>
        {/snippet}
      </DataList>
    {/if}
  {:else}
    <p class="muted">Select a run to see its activity, output and artifacts.</p>
  {/if}
</Pane>

<style>
  .subhead {
    padding-inline: var(--space-large);
  }

  .preview {
    margin: 0 0 var(--space-large);
    overflow-wrap: anywhere;
  }

  .delivery {
    display: flex;
    align-items: flex-start;
    gap: var(--space-small);
    padding: var(--space-small) var(--space-large);
  }

  .delivery-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-small);
    min-width: 0;
    flex: 1 1 auto;
  }

  .delivery-channel {
    @apply --m3-body-medium;
    overflow-wrap: anywhere;
  }

  .delivery-error {
    @apply --m3-body-small;
    color: var(--m3c-on-surface-variant);
    overflow-wrap: anywhere;
  }

  .delivery-kind {
    @apply --m3-body-small;
    flex: none;
  }

  .delivery-status[data-status="sent"] {
    border-color: transparent;
    background-color: var(--m3c-success-container);
    color: var(--m3c-on-success-container);
  }

  .delivery-status[data-status="failed"] {
    border-color: transparent;
    background-color: var(--m3c-warning-container);
    color: var(--m3c-on-warning-container);
  }
</style>
