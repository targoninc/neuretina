<script lang="ts">
  import { Button, Icon, ListItem, Switch, TextFieldOutlined } from "m3-svelte";
  import iconAdd from "@ktibow/iconset-material-symbols/add";
  import iconMic from "@ktibow/iconset-material-symbols/mic";
  import iconMicOff from "@ktibow/iconset-material-symbols/mic-off";
  import iconPlay from "@ktibow/iconset-material-symbols/play-arrow";
  import iconSchedule from "@ktibow/iconset-material-symbols/schedule";
  import { commands } from "../lib/commands";
  import type { ScheduledJob, WorkflowInfo } from "../lib/api";
  import { reportError } from "../lib/feedback";
  import { formatDateTime } from "../lib/format";
  import { useRefresh } from "../lib/refresh.svelte";
  import { paths, router } from "../lib/router.svelte";
  import ConfirmDeleteDialog from "./ConfirmDeleteDialog.svelte";
  import DataList from "./DataList.svelte";
  import DeleteIconButton from "./DeleteIconButton.svelte";
  import Pane from "./Pane.svelte";
  import ScheduledTaskDialog from "./ScheduledTaskDialog.svelte";

  interface Props {
    defaultCron?: string;
  }

  let { defaultCron = "0 7 * * *" }: Props = $props();

  let jobs = $state<ScheduledJob[]>([]);
  let workflows = $state<WorkflowInfo[]>([]);
  let saving = $state(false);
  let running = $state(false);
  let confirmingDelete = $state(false);
  let deleting = $state(false);
  let dialogOpen = $state(false);

  let editName = $state("");
  let editCron = $state("");

  const route = $derived(router.current);
  const jobId = $derived(route.segments[0] ?? null);
  const selected = $derived(jobs.find((job) => job.id === jobId) ?? null);
  const editDirty = $derived(
    selected !== null &&
      (editName.trim() !== selected.name || editCron.trim() !== selected.cron),
  );

  // Seed the edit fields when a different job is opened; a background refresh
  // of the list must not clobber unsaved edits.
  let editedJobId: string | null = null;
  $effect(() => {
    if (!selected) {
      editedJobId = null;
      return;
    }
    if (editedJobId === selected.id) return;
    editedJobId = selected.id;
    editName = selected.name;
    editCron = selected.cron;
  });

  async function refresh(): Promise<void> {
    try {
      [jobs, workflows] = await Promise.all([commands.jobs.list(), commands.workflows.list()]);
      if (jobId && !jobs.some((job) => job.id === jobId)) {
        router.navigate(paths.jobs(), { replace: true });
      }
    } catch (error) {
      reportError(error);
    }
  }

  useRefresh(["job."], refresh);

  function onSaved(job: ScheduledJob): void {
    jobs = [...jobs.filter((entry) => entry.id !== job.id), job];
  }

  function select(job: ScheduledJob): void {
    router.navigate(paths.jobs(job.id));
  }

  async function save(): Promise<void> {
    if (!selected || saving) return;
    saving = true;
    try {
      await commands.jobs.update(selected.id, { name: editName.trim(), cron: editCron.trim() });
    } catch (error) {
      reportError(error);
    } finally {
      saving = false;
    }
  }

  async function toggleVoice(): Promise<void> {
    if (!selected) return;
    const generateAudio = selected.input.generateAudio === false;
    try {
      await commands.jobs.update(selected.id, { input: { ...selected.input, generateAudio } });
    } catch (error) {
      reportError(error);
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (!selected) return;
    try {
      await commands.jobs.update(selected.id, { enabled: !selected.enabled });
    } catch (error) {
      reportError(error);
    }
  }

  async function run(): Promise<void> {
    if (!selected || running) return;
    running = true;
    try {
      const result = await commands.jobs.run(selected.id);
      // Jump to the fresh run so its activity can be watched live.
      router.navigate(paths.workflows(result.workflow, result.runId));
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
    }
  }

  async function remove(): Promise<void> {
    if (!selected || deleting) return;
    const target = selected;
    deleting = true;
    router.navigate(paths.jobs());
    try {
      await commands.jobs.remove(target.id);
      confirmingDelete = false;
    } catch (error) {
      reportError(error);
    } finally {
      deleting = false;
    }
  }

  function supportingText(job: ScheduledJob): string {
    const status = job.lastStatus ? ` (${job.lastStatus})` : "";
    const mode = job.input.generateAudio === false ? "text only" : "voice + text";
    return `${job.workflow} · ${mode} · cron ${job.cron} · last run ${formatDateTime(job.lastRunAt, "never")}${status}`;
  }
</script>

<Pane variant="list" title="Scheduled tasks">
  {#snippet actions()}
    <Button variant="tonal" iconType="left" onclick={() => (dialogOpen = true)}>
      <Icon icon={iconAdd} /> Add task
    </Button>
  {/snippet}

  <DataList items={jobs} empty="No scheduled tasks.">
    {#snippet children(job)}
      <div class="entry" class:selected={jobId === job.id} class:disabled={!job.enabled}>
        <ListItem
          onclick={() => select(job)}
          overline={job.enabled ? "enabled" : "disabled"}
          headline={job.name}
          supporting={supportingText(job)}
        >
          {#snippet leading()}
            <Icon icon={iconSchedule} />
          {/snippet}
        </ListItem>
      </div>
    {/snippet}
  </DataList>
</Pane>

<Pane
  variant="detail"
  title={selected?.name ?? "Task details"}
  subtitle={selected ? `workflow ${selected.workflow} · id ${selected.id.slice(0, 8)}` : undefined}
>
  {#snippet actions()}
    {#if selected}
      <Button variant="tonal" iconType="left" onclick={run} disabled={running}>
        <Icon icon={iconPlay} /> Run now
      </Button>
      <DeleteIconButton onclick={() => (confirmingDelete = true)} disabled={deleting} />
    {/if}
  {/snippet}

  {#if selected}
    <div class="detail-form">
      <TextFieldOutlined label="Name" bind:value={editName} enter={save} />
      <TextFieldOutlined label="Cron expression" bind:value={editCron} enter={save} />
      <div class="actions">
        <Button variant="filled" onclick={save} disabled={saving || !editDirty}>Save changes</Button>
      </div>
    </div>

    <div class="facts">
      <div class="fact">
        <span class="label">Workflow</span>
        <span>{selected.workflow}</span>
      </div>
      <div class="fact">
        <span class="label">State</span>
        <label class="inline-toggle">
          <Switch checked={selected.enabled} onchange={toggleEnabled} />
          <span>{selected.enabled ? "enabled" : "disabled"}</span>
        </label>
      </div>
      <div class="fact">
        <span class="label">Last run</span>
        <span>{formatDateTime(selected.lastRunAt, "never")}{selected.lastStatus
            ? ` (${selected.lastStatus})`
            : ""}</span>
      </div>
      <div class="fact">
        <span class="label">Delivery</span>
        <label
          class="inline-toggle"
          title={selected.input.generateAudio === false
            ? "Text only — switch on to include the voice message"
            : "Voice + text — switch off for text-only delivery"}
        >
          <Switch
            checked={selected.input.generateAudio !== false}
            icons="both"
            checkedIcon={iconMic}
            uncheckedIcon={iconMicOff}
            onchange={toggleVoice}
          />
          <span>{selected.input.generateAudio === false ? "text only" : "voice + text"}</span>
        </label>
      </div>
    </div>
  {:else}
    <p class="muted">Select a task to edit it, run it, or add a new one on the left.</p>
  {/if}
</Pane>

<ScheduledTaskDialog bind:open={dialogOpen} {workflows} {defaultCron} onsaved={onSaved} />

<ConfirmDeleteDialog
  bind:open={confirmingDelete}
  headline="Delete this task?"
  message={`Scheduled task "${selected?.name}" (workflow ${selected?.workflow}, cron ${selected?.cron}) will be permanently removed. Past runs and artifacts are kept. This cannot be undone.`}
  busy={deleting}
  onconfirm={remove}
  oncancel={() => (confirmingDelete = false)}
/>

<style>
  .entry.disabled {
    opacity: 0.65;
  }

  .facts {
    margin-top: var(--space-large);
  }
</style>
