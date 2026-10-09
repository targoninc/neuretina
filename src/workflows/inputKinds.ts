import { WorkflowInputRegistry } from "../core/workflow/inputs.ts";
import { createLanguageInputKind } from "./inputKinds/languageInput.ts";
import { createTopicsInputKind } from "./inputKinds/topicsInput.ts";

/**
 * Every input kind the engine understands; context kinds are registered here.
 * A new context source (e.g. uploaded files) is one kind module plus one
 * registration line — command validation, context resolution and the stored
 * user-workflow shape all pick it up without further changes.
 */
export function createWorkflowInputs(): WorkflowInputRegistry {
  const inputs = new WorkflowInputRegistry();
  inputs.register(createTopicsInputKind());
  inputs.register(createLanguageInputKind());
  return inputs;
}
