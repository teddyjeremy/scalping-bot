export type CompiledOrParsedInstruction = {
  programId?: unknown;
  data?: unknown;
  accounts?: unknown[];
};

/**
 * Returns only message-level instructions.
 * Inner instructions are CPI calls and must never be treated as a launch
 * initializer: a buy/swap can invoke token/program instructions internally.
 */
export function getTopLevelInstructions(message: {
  instructions: readonly CompiledOrParsedInstruction[];
}): CompiledOrParsedInstruction[] {
  return [...message.instructions];
}
