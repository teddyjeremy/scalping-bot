export type MintExtension = { extension: string; state?: unknown };
export type MintSafetyInput = {
  mintMetadataParsed: boolean;
  mintInitialized: boolean | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  tokenProgramOwner: string | null;
  tokenExtensions: MintExtension[] | null;
};
export type LiquidityEvidence =
  | { kind: "bonding_curve"; programOwnerVerified: boolean; curvePdaVerified: boolean; active: boolean; realQuoteReserve: number; virtualQuoteReserve: number; realTokenReserve: number; virtualTokenReserve: number }
  | { kind: "locked_lp"; poolOwnerVerified: boolean; lpMintVerified: boolean; lockVaultTokenAccountVerified: boolean; lockAuthorityVerified: boolean; lockedLpAmount: number; lpSupply: number; minimumLockedSharePct?: number }
  | { kind: "burned_lp"; poolOwnerVerified: boolean; lpMintVerified: boolean; lpSupplyRaw: string; poolLpSupplyRaw: string };
export type DiscoveryCandidateInput = {
  launchAgeSeconds: number;
  fdvUsd: number | null;
  mint: MintSafetyInput;
  liquidity: LiquidityEvidence | null;
  minFdvUsd?: number;
  maxFdvUsd?: number;
  maxLaunchAgeSeconds?: number;
};
export type GateResult = { eligible: boolean; reasons: string[]; warnings: string[] };

const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SAFE_TOKEN_2022_EXTENSIONS = new Set(["metadata", "tokenmetadata", "metadatapointer", "grouppointer", "groupmemberpointer"]);

function extensionName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function extensionState(extension: MintExtension): Record<string, unknown> {
  return extension.state && typeof extension.state === "object" ? extension.state as Record<string, unknown> : {};
}

export function evaluateMintSafety(mint: MintSafetyInput): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!mint.mintMetadataParsed || mint.mintInitialized !== true) reasons.push("mint_metadata_unverified");
  if (mint.mintAuthority !== null) reasons.push("mint_authority_not_revoked_or_unknown");
  if (mint.freezeAuthority !== null) reasons.push("freeze_authority_not_revoked_or_unknown");
  if (![CLASSIC_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(mint.tokenProgramOwner ?? "")) reasons.push("unsupported_or_unverified_token_program");
  const extensions = mint.tokenExtensions;
  if (mint.tokenProgramOwner === CLASSIC_TOKEN_PROGRAM && extensions?.length) reasons.push("unexpected_extensions_on_classic_token_program");
  if (mint.tokenProgramOwner === TOKEN_2022_PROGRAM) {
    if (extensions === null) reasons.push("token_2022_extensions_unavailable");
    for (const extension of extensions ?? []) {
      const name = extensionName(extension.extension);
      const state = extensionState(extension);
      if (!SAFE_TOKEN_2022_EXTENSIONS.has(name)) {
        if (name === "transferfeeconfig") {
          const config = state as Record<string, unknown>;
          const bps = Number(config.transferFeeBasisPoints ?? config.transfer_fee_basis_points ?? 0);
          const maxFee = Number(config.maximumFee ?? config.maximum_fee ?? 0);
          if (bps > 0 || maxFee > 0) reasons.push("nonzero_transfer_fee_extension");
          else warnings.push("zero_transfer_fee_extension_present");
        } else {
          reasons.push(`unsupported_token_2022_extension:${name || "unknown"}`);
        }
      }
      if (name === "defaultaccountstate" && /frozen/i.test(JSON.stringify(state))) reasons.push("default_account_state_frozen");
    }
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], warnings };
}

export function evaluateLiquiditySafety(evidence: LiquidityEvidence | null): GateResult {
  if (!evidence) return { eligible: false, reasons: ["liquidity_evidence_missing"], warnings: [] };
  if (evidence.kind === "bonding_curve") {
    const valid = evidence.programOwnerVerified && evidence.curvePdaVerified && evidence.active &&
      evidence.realQuoteReserve > 0 && evidence.virtualQuoteReserve > 0 &&
      evidence.realTokenReserve > 0 && evidence.virtualTokenReserve > 0;
    return {
      eligible: valid,
      reasons: valid ? [] : ["bonding_curve_state_or_reserves_unverified"],
      warnings: ["bonding_curve_reserves_are_protocol_curve_inventory_not_locked_lp"]
    };
  }
  if (evidence.kind === "burned_lp") {
    const burned = evidence.poolOwnerVerified && evidence.lpMintVerified && evidence.lpSupplyRaw === "0";
    return { eligible: burned, reasons: burned ? [] : ["lp_burn_not_verified_on_chain"], warnings: [] };
  }
  const valid = evidence.poolOwnerVerified && evidence.lpMintVerified &&
    evidence.lockVaultTokenAccountVerified && evidence.lockAuthorityVerified &&
    evidence.lockedLpAmount > 0 && evidence.lpSupply > 0 &&
    evidence.lockedLpAmount <= evidence.lpSupply && evidence.lockedLpAmount / evidence.lpSupply * 100 >= (evidence.minimumLockedSharePct ?? 90);
  return {
    eligible: valid,
    reasons: valid ? [] : [evidence.lockedLpAmount > 0 && evidence.lpSupply > 0 && evidence.lockedLpAmount / evidence.lpSupply * 100 < (evidence.minimumLockedSharePct ?? 90) ? "locked_lp_share_below_90_percent" : "locked_lp_or_lock_authority_not_cryptographically_verified"],
    warnings: []
  };
}

export function evaluateDiscoveryCandidate(input: DiscoveryCandidateInput): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const ageLimit = input.maxLaunchAgeSeconds ?? 300;
  const minFdv = input.minFdvUsd ?? 5_000;
  const maxFdv = input.maxFdvUsd ?? 10_000;
  if (!Number.isFinite(input.launchAgeSeconds) || input.launchAgeSeconds < 0 || input.launchAgeSeconds > ageLimit) reasons.push("outside_discovery_age_window");
  if (input.fdvUsd == null || !Number.isFinite(input.fdvUsd)) reasons.push("fdv_unavailable_or_untrusted");
  else if (input.fdvUsd < minFdv || input.fdvUsd > maxFdv) reasons.push("fdv_outside_5000_10000_usd");
  const mint = evaluateMintSafety(input.mint);
  const liquidity = evaluateLiquiditySafety(input.liquidity);
  reasons.push(...mint.reasons, ...liquidity.reasons);
  warnings.push(...mint.warnings, ...liquidity.warnings);
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], warnings };
}
