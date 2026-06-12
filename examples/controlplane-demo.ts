/* Simulated control plane dispatch loop.
   Three actions go through the adapter: two inside the delegated scope,
   one outside it. Every dispatch lands a signed receipt row, then the
   whole trail is read back from ClickHouse and re-verified. */

import { createPrincipalIdentity } from 'agent-passport-system';
import {
  closeAdapterClient,
  receiptForAction,
  registerControlPlaneAgent,
  verifyTrail,
} from '../src/controlplane-adapter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const principal = createPrincipalIdentity({ displayName: 'Control Plane Demo Principal', domain: 'example.com' });
const agent = registerControlPlaneAgent('controlplane-demo', principal, ['search', 'summarize']);
console.log(`[control-plane] registered ${agent.agentId} scope=${agent.delegation.scope.join(',')}`);

const dispatchQueue = [
  { tool: 'search', args: { target: 'web:docs.example.com', query: 'release notes' } },
  { tool: 'summarize', args: { target: 'doc:meeting-notes.md' } },
  { tool: 'delete_records', args: { target: 'db:users' } },
];

for (const [i, job] of dispatchQueue.entries()) {
  const r = await receiptForAction({ agent, tool: job.tool, args: job.args, scope_check: job.tool });
  console.log(
    `[control-plane] ${i + 1}/${dispatchQueue.length} ${job.tool.padEnd(14)} decision=${r.decision.padEnd(6)} receipt=${r.receiptId.slice(0, 18)}`,
  );
  /* action_ref hashes a second precision timestamp; space actions out. */
  if (i < dispatchQueue.length - 1) await sleep(1100);
}

const report = await verifyTrail(agent.agentId);
console.log(`[control-plane] trail re-verified from ClickHouse: ${report.passed}/${report.total} rows PASS`);
await closeAdapterClient();
process.exit(report.ok ? 0 : 1);
