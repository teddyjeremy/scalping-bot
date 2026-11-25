export type CompiledOrParsedInstruction = {
  programId?: unknown;
  programIdIndex?: unknown;
  data?: unknown;
  accounts?: unknown[];
};

function keyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toBase58" in value && typeof (value as { toBase58?: unknown }).toBase58 === "function") {
    return (value as { toBase58: () => string }).toBase58();
  }
  if (value && typeof value === "object" && "pubkey" in value) return keyString((value as { pubkey: unknown }).pubkey);
  return String(value ?? "");
}

/** Resolve parsed and compiled Solana instruction account references. */
export function normalizeTransactionInstructions(
  message: { accountKeys: readonly unknown[]; instructions: readonly CompiledOrParsedInstruction[] },
  innerInstructions: readonly { instructions: readonly CompiledOrParsedInstruction[] }[] = []
): CompiledOrParsedInstruction[] {
  const accountKeys = message.accountKeys.map(keyString);
  const normalize = (instruction: CompiledOrParsedInstruction): CompiledOrParsedInstruction => {
    const programId = instruction.programId != null
      ? keyString(instruction.programId)
      : Number.isInteger(instruction.programIdIndex)
        ? accountKeys[Number(instruction.programIdIndex)] ?? ""
        : "";
    const accounts = Array.isArray(instruction.accounts)
      ? instruction.accounts.map(account => typeof account === "number" ? accountKeys[account] ?? "" : keyString(account))
      : [];
    return { programId, data: instruction.data, accounts };
  };
  return [
    ...message.instructions.map(normalize),
    ...innerInstructions.flatMap(group => group.instructions.map(normalize))
  ];
}

/**
 * Returns only message-level instructions. Inner instructions are CPI calls
 * and must not be treated as launch initializers.
 */
export function getTopLevelInstructions(message: {
  instructions: readonly CompiledOrParsedInstruction[];
}): CompiledOrParsedInstruction[] {
  return [...message.instructions];
}
