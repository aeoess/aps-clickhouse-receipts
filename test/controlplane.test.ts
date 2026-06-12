/* Control plane adapter test, mirroring the roundtrip pattern.
   Uses its own table so it never touches the aps_receipts demo rows.
   Registers an agent, dispatches one in-scope and one out-of-scope action,
   re-verifies the trail, then tampers a column and checks the trail fails. */

import assert from 'node:assert/strict';
import { createClient } from '@clickhouse/client';
import { createPrincipalIdentity } from 'agent-passport-system';
import {
  closeAdapterClient,
  receiptForAction,
  registerControlPlaneAgent,
  verifyTrail,
} from '../src/controlplane-adapter.js';

// Same env pattern as test/roundtrip.test.ts.
const client = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'aps_demo',
});

const TABLE = 'aps_receipts_controlplane_test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
await client.command({
  query: `CREATE TABLE ${TABLE} (
    receipt_id String, action_ref String, agent_id String,
    delegation_chain_root String, scope String,
    decision Enum('permit', 'deny', 'narrow'),
    policy_digest String, payload_digest String, ts DateTime64(3),
    signature String, pubkey String, raw String
  ) ENGINE = MergeTree ORDER BY (agent_id, ts)`,
});

const principal = createPrincipalIdentity({ displayName: 'Control Plane Test Principal' });
const agent = registerControlPlaneAgent('controlplane-test', principal, ['search']);

const permitted = await receiptForAction({
  agent,
  tool: 'search',
  args: { target: 'web:example.com', query: 'adapter test' },
  scope_check: 'search',
  table: TABLE,
});
assert.equal(permitted.decision, 'permit', 'in-scope action should be permitted');
assert.ok(JSON.parse(String(permitted.row.raw)).policyReceipt, 'permit row carries a policy receipt');

/* action_ref hashes a second precision timestamp; keep refs distinct. */
await sleep(1100);

const denied = await receiptForAction({
  agent,
  tool: 'transfer_funds',
  args: { target: 'bank:acct-9921', spend: { amount: 480, currency: 'USD' } },
  scope_check: 'transfer_funds',
  table: TABLE,
});
assert.equal(denied.decision, 'deny', 'out-of-scope action should be denied');
assert.equal(
  JSON.parse(String(denied.row.raw)).policyReceipt,
  undefined,
  'deny row carries signed intent and deny decision, no policy receipt',
);
assert.notEqual(permitted.actionRef, denied.actionRef, 'action refs stay distinct');

const clean = await verifyTrail(agent.agentId, TABLE);
assert.equal(clean.total, 2, 'two rows in the trail');
assert.equal(clean.passed, 2, 'both rows re-verify from the store');
assert.equal(clean.ok, true, 'clean trail verifies');

/* Tamper: widen the stored scope column. Signatures stay valid, the column
   binding check must catch it. Same mutation pattern as src/verify.ts. */
await client.command({
  query: `ALTER TABLE ${TABLE} UPDATE scope = 'search,transfer_funds' WHERE receipt_id = '${permitted.receiptId}'`,
  clickhouse_settings: { mutations_sync: '2' },
});

const tampered = await verifyTrail(agent.agentId, TABLE);
assert.equal(tampered.ok, false, 'tampered trail fails verification');
assert.equal(tampered.passed, 1, 'only the untouched row still passes');
assert.ok(
  tampered.failures.some((f) => f.check === 'scope column binding'),
  'failure names the scope column binding check',
);

await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
await client.close();
await closeAdapterClient();

console.log('controlplane adapter test: PASS (register, permit, deny, verify trail, catch tamper)');
