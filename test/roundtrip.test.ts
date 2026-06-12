/* One roundtrip test.
   Emit one receipt, insert it, read it back from ClickHouse, verify the
   signatures and the action_ref with the SDK's own functions. */

import assert from 'node:assert/strict';
import { createClient } from '@clickhouse/client';
import {
  FloorValidatorV1,
  actionRefsMatch,
  computeActionRef,
  createActionIntent,
  createDelegation,
  createPolicyReceipt,
  createPrincipalIdentity,
  createReceipt,
  evaluateIntent,
  generateKeyPair,
  verifyActionIntent,
  verifyPolicyReceipt,
} from 'agent-passport-system';

// Same env pattern as src/. Password defaults to the compose-pinned value
// so `npm test` works against the repo's own docker setup out of the box.
const client = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'aps_demo',
});

const TABLE = 'aps_receipts_roundtrip_test';
await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
await client.command({
  query: `CREATE TABLE ${TABLE} (receipt_id String, action_ref String, signature String, pubkey String, raw String) ENGINE = MergeTree ORDER BY receipt_id`,
});

const { principal, keyPair: principalKeys } = createPrincipalIdentity({ displayName: 'Test Principal' });
const agentKeys = generateKeyPair();
const evaluatorKeys = generateKeyPair();
const verifierKeys = generateKeyPair();
const agentId = 'agent:roundtrip-test';

const delegation = createDelegation({
  delegatedTo: agentId,
  delegatedBy: principal.publicKey,
  scope: ['search'],
  maxDepth: 1,
  expiresInHours: 1,
  privateKey: principalKeys.privateKey,
});

const intent = createActionIntent({
  agentId,
  agentPublicKey: agentKeys.publicKey,
  delegationId: delegation.delegationId,
  action: { type: 'search', target: 'web:example.com', scopeRequired: 'search' },
  privateKey: agentKeys.privateKey,
});

const decision = evaluateIntent({
  intent,
  validator: new FloorValidatorV1(),
  validationContext: {
    floorVersion: '0.1',
    floorPrinciples: [],
    delegation: {
      scope: delegation.scope,
      expiresAt: delegation.expiresAt,
      revoked: false,
      currentDepth: delegation.currentDepth,
      maxDepth: delegation.maxDepth,
    },
    agentRegistered: true,
    agentAttestationValid: true,
  },
  evaluatorId: 'evaluator:test',
  evaluatorPublicKey: evaluatorKeys.publicKey,
  evaluatorPrivateKey: evaluatorKeys.privateKey,
});
assert.equal(decision.verdict, 'permit', 'in-scope action should be permitted');

const receipt = createReceipt({
  agentId,
  delegationId: delegation.delegationId,
  delegation,
  action: { type: 'search', target: 'web:example.com', scopeUsed: 'search' },
  result: { status: 'success', summary: 'ok' },
  delegationChain: [delegation.delegationId],
  privateKey: agentKeys.privateKey,
});

const policyReceipt = createPolicyReceipt({
  intent,
  decision,
  receipt,
  verifierPrivateKey: verifierKeys.privateKey,
  delegationChain: [delegation],
});

await client.insert({
  table: TABLE,
  values: [
    {
      receipt_id: policyReceipt.policyReceiptId,
      action_ref: intent.actionRef,
      signature: intent.signature,
      pubkey: agentKeys.publicKey,
      raw: JSON.stringify({ intent, policyReceipt, verifierPublicKey: verifierKeys.publicKey }),
    },
  ],
  format: 'JSONEachRow',
});

const rows = await client
  .query({ query: `SELECT * FROM ${TABLE}`, format: 'JSONEachRow' })
  .then((r) => r.json<{ receipt_id: string; action_ref: string; raw: string }>());
assert.equal(rows.length, 1, 'one row expected back');

const stored = JSON.parse(rows[0].raw);
assert.equal(verifyActionIntent(stored.intent).valid, true, 'intent signature verifies after roundtrip');
assert.equal(
  verifyPolicyReceipt(stored.policyReceipt, stored.verifierPublicKey).valid,
  true,
  'policy receipt chain verifies after roundtrip',
);
assert.equal(
  actionRefsMatch(computeActionRef(stored.intent), rows[0].action_ref),
  true,
  'action_ref recomputes to the stored column value',
);

await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
await client.close();

console.log('roundtrip test: PASS (emit, insert, read back, verify)');
