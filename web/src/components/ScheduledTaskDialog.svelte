<script lang="ts">
  import { Button, Dialog, Select, Switch, TextFieldOutlined } from "m3-svelte";
  import iconMic from "@ktibow/iconset-material-symbols/mic";
  import iconMicOff from "@ktibow/iconset-material-symbols/mic-off";
  import type { ScheduledJob, WorkflowInfo } from "../lib/api";
  import { commands } from "../lib/commands";
  import { reportError, reportSuccess } from "../lib/feedback";

  interface Props {
    open: boolean;
    workflows: WorkflowInfo[];
    defaultCron?: string;
    onsaved: (job: ScheduledJob) => void;
  }

  let { open = $bindable(), workflows, defaultCron = "0 7 * * *", onsaved }: Props = $props();

  let name = $state("");
  let cron = $state(defaultCron);
  let workflow = $state("");
  let voiceEnabled = $state(true);
  let saving = $state(false);

  const workflowOptions = $derived(
    workflows.map((entry) => ({ text: entry.title || entry.id, value: entry.id })),
  );
  const canSave = $derived(
    !saving && name.trim() !== "" && cron.trim() !== "" && workflow !== "",
  );

  // Reset the form each time the dialog opens.
  $effect(() => {
    if (!open) return;
    name = "";
    cron = defaultCron;
    workflow = workflows[0]?.id ?? "";
    voiceEnabled = true;
  });

  async function save(): Promise<void> {
    if (!canSave) return;
    saving = true;
    try {
      const job = await commands.jobs.create({
        name: name.trim(),
        cron: cron.trim(),
        workflow,
        input: { generateAudio: voiceEnabled },
      });
      onsaved(job);
      reportSuccess(`Task "${job.name}" added`);
      open = false;
    } catch (error) {
      reportError(error);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog headline="Add scheduled task" bind:open>
  <div class="task-form">
    <TextFieldOutlined label="Name" bind:value={name} enter={() => void save()} />
    <TextFieldOutlined label="Cron expression" bind:value={cron} enter={() => void save()} />
    <Select label="Workflow" options={workflowOptions} bind:value={workflow} />
    <label
      class="voice-toggle"
      title={voiceEnabled
        ? "Voice + text — switch off for text-only delivery"
        : "Text only — switch on to include the voice message"}
    >
      <Switch
        bind:checked={voiceEnabled}
        icons="both"
        checkedIcon={iconMic}
        uncheckedIcon={iconMicOff}
      />
      <span>{voiceEnabled ? "Voice + text" : "Text only"}</span>
    </label>
  </div>
  {#snippet buttons()}
    <Button variant="text" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
    <Button variant="filled" onclick={() => void save()} disabled={!canSave}>Add task</Button>
  {/snippet}
</Dialog>

<style>
  .task-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-large);
  }

  .voice-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-small);
    color: var(--m3c-on-surface-variant);
    font-size: var(--font-medium);
    cursor: pointer;
    user-select: none;
  }
</style>
