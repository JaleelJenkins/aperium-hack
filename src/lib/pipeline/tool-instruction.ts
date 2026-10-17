/**
 * Some models (e.g. claude-sonnet-5-5) reject a forced tool_choice. Calls use
 * tool_choice "auto" plus this instruction; callers still throw if no tool call comes back.
 */
export function withToolInstruction(system: string, toolName: string): string {
  return `${system}\n\nRespond only by calling the ${toolName} tool exactly once. Do not reply with plain text.`;
}
