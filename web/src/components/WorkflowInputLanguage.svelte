<script lang="ts">
  import { Select } from "m3-svelte";
  import { LANGUAGES } from "../../../src/core/languages.ts";
  import type { WorkflowInputEditorProps } from "../lib/workflowInputs";

  let { value, disabled = false, onchange }: WorkflowInputEditorProps = $props();

  const options = [
    { text: "Configured default", value: "" },
    ...LANGUAGES.map((language) => ({ text: language.name, value: language.code })),
  ];
  const selected = $derived(typeof value === "string" ? value : "");
</script>

<Select
  label="Language"
  {options}
  value={selected}
  {disabled}
  onchange={(event) => onchange((event.currentTarget as HTMLSelectElement).value)}
/>
