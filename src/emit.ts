/* Demo agent loop.
   A principal delegates a narrow scope to an agent. The agent runs six
   actions. Five stay inside the scope. One leaves it on purpose.
   Every action gets a real signed APS receipt and a trace mirror row.
   Both land in ClickHouse and share an action_ref. */

import { readFileSync } from 'node:fs';
import { createClient } from '@clickhouse/client';
import {
  FloorValidatorV1,
  canonicalHash,
  computeDelegationChainRoot,
  createActionIntent,
  createDelegation,
  createPolicyReceipt,
  createPrincipalIdentity,
  createReceipt,
  evaluateIntent,
  generateKeyPair,
  loadFloor,
} from 'agent-passport-system';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const client = createClient({ url: CH_URL, username: process.env.CLICKHOUSE_USER ?? 'default', password: process.env.CLICKHOUSE_PASSWORD ?? '' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ClickHouse DateTime64(3) wants 'YYYY-MM-DD hh:mm:ss.mmm'. */
const toCH = (iso: string) => iso.replace('T', ' ').replace('Z', '').slice(0, 23);

/* The values floor ships inside the SDK package. */
const floorYaml = readFileSync(
  new URL('../node_modules/agent-passport-system/values/floor.yaml', import.meta.url),
  'utf8',
);
const floor = loadFloor(floorYaml);

/* Identities. One principal, one agent, one policy evaluator, one verifier.
   The SDK treats delegatedBy as the signer's public key. */
const { principal, keyPair: principalKeys } = createPrincipalIdentity({
  displayName: 'Demo Principal',
  domain: 'example.com',
});
const agentKeys = generateKeyPair();
const evaluatorKeys = generateKeyPair();
const verifierKeys = generateKeyPair();
const agentId = 'agent:research-assistant';
const evaluatorId = 'evaluator:floor-v1';

/* Narrow delegation: two tools, a spend limit, 24 hour expiry. */
const delegation = createDelegation({
  delegatedTo: agentId,
  delegatedBy: principal.publicKey,
  scope: ['search', 'summarize'],
  spendLimit: 50,
  spendLimitUnit: 'currency',
  maxDepth: 1,
  expiresInHours: 24,
  privateKey: principalKeys.privateKey,
});

const validationContext = {
  floorVersion: floor.version,
  floorPrinciples: floor.floor.map((p) => ({
    id: p.id,
    name: p.name,
    enforcement: p.enforcement,
    weight: p.weight,
  })),
  delegation: {
    scope: delegation.scope,
    spendLimit: delegation.spendLimit,
    spentAmount: 0,
    expiresAt: delegation.expiresAt,
    revoked: false,
    currentDepth: delegation.currentDepth,
    maxDepth: delegation.maxDepth,
  },
  agentRegistered: true,
  agentAttestationValid: true,
};

interface DemoAction {
  tool: string;
  target: string;
  input: string;
  spend?: { amount: number; currency: string };
}

/* Five in scope, the last one out of scope on purpose. */
const actions: DemoAction[] = [
  { tool: 'search', target: 'web:docs.clickhouse.com', input: 'MergeTree ORDER BY for receipt tables' },
  { tool: 'search', target: 'web:langfuse.com/docs', input: 'trace ingestion format' },
  { tool: 'summarize', target: 'doc:clickhouse-notes.md', input: 'summarize search findings' },
  { tool: 'search', target: 'web:npmjs.com', input: 'agent-passport-system package' },
  { tool: 'summarize', target: 'doc:vendor-invoice.pdf', input: 'summarize invoice line items' },
  { tool: 'transfer_funds', target: 'bank:acct-9921', input: 'pay invoice 4417', spend: { amount: 480, currency: 'USD' } },
];

const receiptRows: Record<string, unknown>[] = [];
const traceRows: Record<string, unknown>[] = [];

let n = 0;
for (const a of actions) {
  n += 1;

  /* 1. The agent declares what it wants to do. Signed. */
  const intent = createActionIntent({
    agentId,
    agentPublicKey: agentKeys.publicKey,
    delegationId: delegation.delegationId,
    action: {
      type: a.tool,
      target: a.target,
      scopeRequired: a.tool,
      ...(a.spend ? { spend: a.spend } : {}),
    },
    context: a.input,
    privateKey: agentKeys.privateKey,
  });

  /* 2. The evaluator checks the intent against the floor. Signed. */
  const decision = evaluateIntent({
    intent,
    validator: new FloorValidatorV1(),
    validationContext,
    evaluatorId,
    evaluatorPublicKey: evaluatorKeys.publicKey,
    evaluatorPrivateKey: evaluatorKeys.privateKey,
  });

  /* 3. Execution. The runtime calls the tool either way.
     That gap between receipt and trace is the point of the demo. */
  const executedAt = new Date().toISOString();
  const output = decision.verdict === 'permit'
    ? `ok: ${a.tool} on ${a.target}`
    : `executed despite ${decision.verdict}: ${a.tool} on ${a.target}`;

  /* 4. Action receipt from the executor, then the policy receipt that
     links intent, decision and receipt under the verifier's signature.
     The SDK refuses to mint an action receipt for an out-of-scope call.
     So a deny row lands with its two signed artifacts instead: the
     agent's signed intent and the evaluator's signed deny decision. */
  let receipt = null;
  let policyReceipt = null;
  if (decision.verdict === 'permit') {
    receipt = createReceipt({
      agentId,
      delegationId: delegation.delegationId,
      delegation,
      action: {
        type: a.tool,
        target: a.target,
        scopeUsed: a.tool,
        ...(a.spend ? { spend: a.spend } : {}),
      },
      result: { status: 'success', summary: output },
      delegationChain: [delegation.delegationId],
      privateKey: agentKeys.privateKey,
    });

    policyReceipt = createPolicyReceipt({
      intent,
      decision,
      receipt,
      verifierPrivateKey: verifierKeys.privateKey,
      delegationChain: [delegation],
    });
  }

  const actionRef = policyReceipt?.actionRef ?? intent.actionRef ?? '';

  receiptRows.push({
    receipt_id: policyReceipt ? policyReceipt.policyReceiptId : decision.decisionId,
    action_ref: actionRef,
    agent_id: agentId,
    delegation_chain_root:
      policyReceipt?.delegation_chain_root ?? computeDelegationChainRoot([delegation]),
    scope: delegation.scope.join(','),
    decision: decision.verdict,
    policy_digest: canonicalHash({
      floorVersion: floor.version,
      principles: validationContext.floorPrinciples,
    }),
    payload_digest: canonicalHash({ action: intent.action }),
    ts: toCH(intent.createdAt),
    signature: intent.signature,
    pubkey: agentKeys.publicKey,
    raw: JSON.stringify({
      intent,
      decision,
      ...(receipt ? { receipt } : {}),
      ...(policyReceipt ? { policyReceipt } : {}),
      delegation,
      verifierPublicKey: verifierKeys.publicKey,
    }),
  });

  traceRows.push({
    trace_id: `trace-${String(n).padStart(3, '0')}`,
    action_ref: actionRef,
    agent_id: agentId,
    tool_name: a.tool,
    observed_scope: a.tool,
    input_digest: canonicalHash({ input: a.input, target: a.target }),
    output_digest: canonicalHash({ output }),
    ts: toCH(executedAt),
  });

  console.log(
    `[emit] ${n}/6 ${a.tool.padEnd(16)} verdict=${decision.verdict.padEnd(6)} action_ref=${actionRef.slice(0, 16)}`,
  );

  /* action_ref hashes a second precision timestamp.
     Space the actions out so every ref is distinct. */
  if (n < actions.length) await sleep(1100);
}

await client.insert({ table: 'aps_receipts', values: receiptRows, format: 'JSONEachRow' });
await client.insert({ table: 'agent_traces', values: traceRows, format: 'JSONEachRow' });
await client.close();

console.log(`[emit] inserted ${receiptRows.length} receipts into aps_receipts`);
console.log(`[emit] inserted ${traceRows.length} traces into agent_traces`);
