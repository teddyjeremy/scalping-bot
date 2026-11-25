export type InitialScreenStatus = "eligible" | "rejected" | "unverified";

export type InitialScreenEvidence = {
  mintAuthorityRevoked?: boolean;
  tokenExtensionsAssessed?: boolean;
  tokenExtensionsSafe?: boolean;
  pumpCurveVerifiedActive?: boolean;
  pumpRealQuoteReservesPositive?: boolean;
  migratedPoolVerified?: boolean;
  migratedPoolLockPercent?: number;
};

export type InitialScreenDecision = {
  schemaVersion: 1;
  ruleVersion: "initial-security-gate-v1";
  status: InitialScreenStatus;
  evaluatedAt: string;
  reasons: string[];
  evidence: InitialScreenEvidence;
  limitations: string[];
};

/**
 * Fail-closed historical security gate.
 * Missing historical evidence is never interpreted as safe.
 * Behavioral thresholds are deliberately not inferred from aggregate
 * ten-minute summaries because that would leak later observations into
 * an earlier screening decision.
 */
export function evaluateInitialScreen(
  evidence: InitialScreenEvidence,
  evaluatedAt = new Date().toISOString()
): InitialScreenDecision {
  const reasons: string[] = [];
  let rejected = false;

  if (evidence.mintAuthorityRevoked === false) {
    reasons.push("mint_authority_not_revoked");
    rejected = true;
  } else if (evidence.mintAuthorityRevoked !== true) {
    reasons.push("historical_mint_authority_state_unverified");
  }

  if (evidence.tokenExtensionsAssessed !== true) {
    reasons.push("token_2022_extensions_not_assessed");
  } else if (evidence.tokenExtensionsSafe !== true) {
    reasons.push(evidence.tokenExtensionsSafe === false
      ? "token_extensions_failed_safety_policy"
      : "token_extension_safety_result_missing");
    if (evidence.tokenExtensionsSafe === false) rejected = true;
  }

  const pumpVerified = evidence.pumpCurveVerifiedActive === true &&
    evidence.pumpRealQuoteReservesPositive === true;
  const migratedVerified = evidence.migratedPoolVerified === true &&
    typeof evidence.migratedPoolLockPercent === "number" &&
    evidence.migratedPoolLockPercent >= 90;

  if (!pumpVerified && !migratedVerified) {
    if (evidence.pumpCurveVerifiedActive === false || evidence.pumpRealQuoteReservesPositive === false ||
        evidence.migratedPoolVerified === false ||
        (typeof evidence.migratedPoolLockPercent === "number" && evidence.migratedPoolLockPercent < 90)) {
      reasons.push("venue_liquidity_evidence_failed_policy");
      rejected = true;
    } else {
      reasons.push("historical_curve_or_locked_pool_liquidity_unverified");
    }
  }

  const status: InitialScreenStatus = rejected
    ? "rejected"
    : reasons.length > 0
      ? "unverified"
      : "eligible";

  return {
    schemaVersion: 1,
    ruleVersion: "initial-security-gate-v1",
    status,
    evaluatedAt,
    reasons,
    evidence,
    limitations: [
      "This is a security-evidence gate, not a profitability signal.",
      "Behavioral entry criteria are not evaluated by this version.",
      "No 30-minute price or outcome reconstruction is required.",
      "Missing historical evidence remains unverified and cannot pass."
    ]
  };
}
