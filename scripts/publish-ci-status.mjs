import { uploadFiles } from "@huggingface/hub";

const token = process.env.HF_TOKEN;
if (!token) throw new Error("HF_TOKEN is required to publish the verification report.");
const report = {
  schemaVersion: 1,
  commitSha: process.env.GITHUB_SHA ?? null,
  workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  stage: process.env.VERIFICATION_STAGE ?? "preflight",
  jobStatus: process.env.JOB_STATUS ?? "unknown",
  typecheck: process.env.TYPECHECK_STATUS ?? "not_run",
  unitTests: process.env.UNIT_TEST_STATUS ?? "not_run",
  recordedAt: new Date().toISOString(),
  nodeVersion: process.version
};
await uploadFiles({
  repo: { type: "dataset", name: process.env.HF_DATASET_REPO ?? "ndeda/solana-scalping-data" },
  accessToken: token,
  files: [{ path: "quality/ci-status.json", content: new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }) }],
  commitTitle: `Collector verification: ${report.stage} ${report.jobStatus}`,
  commitDescription: `CI verification report for ${report.commitSha ?? "unknown commit"}.`
});
console.log("Published collector CI verification report:", JSON.stringify(report));
