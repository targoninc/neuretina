import type { TriggerKind } from "../../domain/runs/WorkflowRunRepository.ts";
import type { DeliveryMessage } from "../../delivery/DeliveryService.ts";
import { derivesFrom } from "./ports.ts";
import type { WorkflowRunContext } from "./Workflow.ts";

/**
 * How a trigger event is bound to a workflow; `when` narrows which events
 * count (e.g. only Matrix replies to the bot).
 */
export interface WorkflowTriggerBinding {
  kind: TriggerKind;
  when?: (detail: Record<string, unknown>) => boolean;
}

/**
 * A configurable workflow input. `kind` names a registered input kind (see
 * inputs.ts): "topics" is one context kind today, and file/document kinds can
 * register later without changing the workflow plumbing.
 */
export interface WorkflowInputSpec {
  /** Stable key the configured value is stored under, e.g. "topics". */
  id: string;
  /** Port type id (see ports.ts); drives validation and the editor control. */
  kind: string;
  title: string;
  /** Required inputs must hold a value for the workflow to be runnable. */
  required: boolean;
  /** The value is a list (of ids for now) rather than a single entry. */
  multiple: boolean;
}

/** A value a step consumes, produced by workflow inputs or earlier steps. */
export interface StepInputSpec {
  /**
   * Accepted port type (see ports.ts). Any derivative of it satisfies the
   * input: an input accepting "text" consumes a report, a draft, an answer, …
   */
  kind: string;
  title: string;
  description?: string;
  /** Optional inputs may be missing for a run; the step still runs. */
  required: boolean;
}

/** Renders a produced value into a deliverable message. */
export type OutputRenderer = (value: unknown) => DeliveryMessage | undefined;

/** A value a step produces; deliverable outputs can be assigned channels. */
export interface StepOutputSpec {
  /** Port type id of the produced value, e.g. "report", "tts" (see ports.ts). */
  kind: string;
  title: string;
  description?: string;
  /**
   * Guaranteed outputs exist after the step ran; optional outputs may be
   * skipped (e.g. a step that found nothing to add).
   */
  guaranteed: boolean;
  /**
   * Present when the output can be sent to delivery channels. A step output
   * without a renderer cannot be assigned any channel.
   */
  deliver?: OutputRenderer;
}

/** What a step returns to the pipeline. */
export interface StepResult {
  /** Produced values keyed by output kind. */
  outputs?: Record<string, unknown>;
  /** Ends the pipeline early; the value becomes the run's output. */
  halt?: unknown;
  /** Sent to every channel assigned anywhere in the workflow when halting. */
  fallback?: DeliveryMessage;
}

/** What a step handler receives from the pipeline. */
export interface StepContext {
  /** Resolved workflow inputs keyed by input id (e.g. topics). */
  inputs: Record<string, unknown>;
  /** Raw run options (deliver, generateAudio, …) as passed by the caller. */
  options: Record<string, unknown>;
  /** Outputs of completed steps, keyed by step id (then by output kind). */
  outputs: ReadonlyMap<string, Record<string, unknown>>;
  /** The run context: bus, logger, statuses, cost, signal, cancellation. */
  run: WorkflowRunContext;
}

export type StepHandler = (context: StepContext) => Promise<StepResult | void>;

/** One action in a workflow. */
export interface StepDefinition {
  id: string;
  /**
   * Handler kind. Direct handler references are used today; JSON definitions
   * will resolve this through a step-handler registry later.
   */
  type: string;
  title: string;
  description?: string;
  /**
   * Step ids that must complete before this step runs. Steps whose
   * dependencies are met start immediately and run concurrently; without
   * `after`, a step depends on every earlier step and stays sequential.
   */
  after?: string[];
  inputs: StepInputSpec[];
  outputs: StepOutputSpec[];
  /** Direct implementation reference (see `type`). */
  run: StepHandler;
}

/**
 * A workflow's public definition: inputs, steps and ports. Definitions are
 * plain objects that hold direct references today and are designed to become
 * JSON with a handler/kind registry later.
 */
export interface WorkflowDefinition {
  id: string;
  title: string;
  description: string;
  contextId?: string;
  triggers: WorkflowTriggerBinding[];
  inputs: WorkflowInputSpec[];
  steps: StepDefinition[];
}

/** Serializable output description for the UI (drops the renderer). */
export interface StepOutputInfo {
  kind: string;
  title: string;
  description?: string;
  guaranteed: boolean;
  /** True when channels can be assigned to this output. */
  deliverable: boolean;
}

/** Serializable step description for the UI (drops the handler). */
export interface WorkflowStepInfo {
  id: string;
  type: string;
  title: string;
  description?: string;
  inputs: StepInputSpec[];
  outputs: StepOutputInfo[];
}

/** Serializable workflow description for the UI. */
export interface WorkflowInfo {
  id: string;
  title: string;
  description: string;
  contextId?: string;
  triggers: TriggerKind[];
  inputs: WorkflowInputSpec[];
  steps: WorkflowStepInfo[];
}

/** A step output that can carry delivery channels. */
export interface DeliveryTargetSpec {
  step: string;
  output: string;
  /** Human label of the output (falls back to its kind). */
  title: string;
}

export function describeWorkflow(definition: WorkflowDefinition): WorkflowInfo {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    ...(definition.contextId ? { contextId: definition.contextId } : {}),
    triggers: definition.triggers.map((binding) => binding.kind),
    inputs: definition.inputs,
    steps: definition.steps.map(describeStep),
  };
}

export function describeStep(step: StepDefinition): WorkflowStepInfo {
  return {
    id: step.id,
    type: step.type,
    title: step.title,
    ...(step.description ? { description: step.description } : {}),
    inputs: step.inputs,
    outputs: step.outputs.map((output) => ({
      kind: output.kind,
      title: output.title,
      ...(output.description ? { description: output.description } : {}),
      guaranteed: output.guaranteed,
      deliverable: output.deliver !== undefined,
    })),
  };
}

export function findStep(
  definition: WorkflowDefinition,
  stepId: string,
): StepDefinition | undefined {
  return definition.steps.find((step) => step.id === stepId);
}

export function findStepOutput(
  definition: WorkflowDefinition,
  stepId: string,
  kind: string,
): StepOutputSpec | undefined {
  return findStep(definition, stepId)?.outputs.find((output) => output.kind === kind);
}

/** True when the (step, output) pair exists and accepts delivery channels. */
export function isDeliveryTarget(
  definition: WorkflowDefinition,
  stepId: string,
  kind: string,
): boolean {
  return findStepOutput(definition, stepId, kind)?.deliver !== undefined;
}

/** Every output that accepts channels, in definition order. */
export function deliveryTargets(definition: WorkflowDefinition): DeliveryTargetSpec[] {
  const targets: DeliveryTargetSpec[] = [];
  for (const step of definition.steps) {
    for (const output of step.outputs) {
      if (output.deliver === undefined) continue;
      targets.push({ step: step.id, output: output.kind, title: output.title });
    }
  }
  return targets;
}

/**
 * The most recent step output whose port type derives from `primitive` — the
 * value a step declaring that input should consume. Steps run in order, so
 * the last match wins.
 */
export function latestOutput(
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  primitive: string,
): { step: string; kind: string; value: unknown } | undefined {
  let found: { step: string; kind: string; value: unknown } | undefined;
  for (const [step, stepOutputs] of outputs) {
    for (const [kind, value] of Object.entries(stepOutputs)) {
      if (derivesFrom(kind, primitive)) found = { step, kind, value };
    }
  }
  return found;
}

/** First deliverable output of a kind (e.g. the audio output), if any. */
export function deliveryTargetForKind(
  definition: WorkflowDefinition | undefined,
  kind: string,
): DeliveryTargetSpec | undefined {
  if (!definition) return undefined;
  return deliveryTargets(definition).find((target) => target.output === kind);
}
