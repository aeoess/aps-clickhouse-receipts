/* Re-verify every receipt straight out of ClickHouse.
   The store is not trusted. Every check below uses the SDK's own functions
   against the stored bytes:
     1. intent signature        (Ed25519, agent key)
     2. decision signature      (Ed25519, evaluator key)
     3. policy receipt chain    (Ed25519, verifier key)
     4. delegation signature    (Ed25519, principal key)
     5. action_ref recompute    (stored column vs recomputed digest)
     6. scope column binding    (stored column vs signed delegation scope)
     7. signature and pubkey column binding (stored columns vs signed intent)

   --tamper: widen one row's scope with ALTER TABLE UPDATE, then re-verify.
   The tampered row fails check 6. The signed authority did not change. */

import { createClient } from '@clickhouse/client';
import {
  actionRefsMatch,
  computeActionRef,
  verifyActionIntent,
  verifyDelegation,
  verifyPolicyDecision,
  verifyPolicyReceipt,
} from 'agent-passport-system';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const client = createClient({ url: CH_URL });

interface ReceiptRow {
  receipt_id: string;
  action_ref: string;
  agent_id: string;
  delegation_chain_root: string;
  scope: string;
  decision: string;
  signature: string;
  pubkey: string;
  raw: string;
  ts: string;
}

interface Failure {
  check: string;
  detail: string;
}

async function fetchRows(): Promise<ReceiptRow[]> {
  const rs = await client.query({
    query: 'SELECT * FROM aps_receipts ORDER BY ts',
    format: 'JSONEachRow',
  });
  return rs.json<ReceiptRow>();
}

function checkRow(row: ReceiptRow): Failure[] {
  const failures: Failure[] = [];
  const raw = JSON.parse(row.raw);

  const intentCheck = verifyActionIntent(raw.intent);
  if (!intentCheck.valid) {
    failures.push({ check: 'intent signature', detail: intentCheck.errors.join('; ') });
  }

  const decisionCheck = verifyPolicyDecision(raw.decision);
  if (!decisionCheck.valid) {
    failures.push({ check: 'decision signature', detail: decisionCheck.errors.join('; ') });
  }

  /* Deny rows carry no policy receipt. The SDK refuses to mint an action
     receipt for an out-of-scope call, so a deny row holds two signed
     artifacts (intent, decision) instead of four. */
  if (raw.policyReceipt) {
    const receiptCheck = verifyPolicyReceipt(raw.policyReceipt, raw.verifierPublicKey);
    if (!receiptCheck.valid) {
      failures.push({ check: 'policy receipt chain', detail: receiptCheck.errors.join('; ') });
    }
  }

  const delegationCheck = verifyDelegation(raw.delegation);
  if (!delegationCheck.valid) {
    failures.push({ check: 'delegation signature', detail: delegationCheck.errors.join('; ') });
  }

  const recomputedRef = computeActionRef(raw.intent);
  if (!actionRefsMatch(recomputedRef, row.action_ref)) {
    failures.push({
      check: 'action_ref recompute',
      detail: `stored ${row.action_ref.slice(0, 16)} vs recomputed ${recomputedRef.slice(0, 16)}`,
    });
  }

  const signedScope = raw.delegation.scope.join(',');
  if (row.scope !== signedScope) {
    failures.push({
      check: 'scope column binding',
      detail: `stored scope '${row.scope}' vs signed authority '${signedScope}'`,
    });
  }

  if (row.signature !== raw.intent.signature || row.pubkey !== raw.intent.agentPublicKey) {
    failures.push({
      check: 'signature column binding',
      detail: 'stored signature or pubkey column differs from the signed intent',
    });
  }

  return failures;
}

function runPass(rows: ReceiptRow[]): ReceiptRow[] {
  const failed: ReceiptRow[] = [];
  rows.forEach((row, i) => {
    const failures = checkRow(row);
    if (failures.length === 0) {
      console.log(
        `[verify] row ${i + 1}/${rows.length} receipt=${row.receipt_id.slice(0, 18)} decision=${row.decision.padEnd(6)} PASS`,
      );
    } else {
      failed.push(row);
      console.log(
        `[verify] row ${i + 1}/${rows.length} receipt=${row.receipt_id.slice(0, 18)} decision=${row.decision.padEnd(6)} FAIL`,
      );
      for (const f of failures) {
        console.log(`         failed check: ${f.check}`);
        console.log(`         ${f.detail}`);
      }
    }
  });
  return failed;
}

const tamperMode = process.argv.includes('--tamper');
const rows = await fetchRows();

if (rows.length === 0) {
  console.error('[verify] aps_receipts is empty. Run src/emit.ts first.');
  process.exit(1);
}

if (!tamperMode) {
  const failed = runPass(rows);
  console.log(
    failed.length === 0
      ? `[verify] all ${rows.length} receipts verified against the store`
      : `[verify] ${failed.length} of ${rows.length} receipts FAILED verification`,
  );
  await client.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

/* Tamper mode. Widen the scope column of the first permitted row.
   The row keeps its valid signatures. The column no longer matches them. */
const target = rows.find((r) => r.decision === 'permit') ?? rows[0];
console.log(`[tamper] target row: receipt=${target.receipt_id}`);
console.log(`[tamper] before:    scope='${target.scope}'`);
console.log("[tamper] ALTER TABLE aps_receipts UPDATE scope = 'search,summarize,transfer_funds' ...");

await client.command({
  query: `ALTER TABLE aps_receipts UPDATE scope = 'search,summarize,transfer_funds' WHERE receipt_id = '${target.receipt_id}'`,
  clickhouse_settings: { mutations_sync: '2' },
});

const after = await fetchRows();
const failed = runPass(after);

if (failed.length === 1 && failed[0].receipt_id === target.receipt_id) {
  console.log('[tamper] verification caught the tampered row. The store is not trusted.');
  console.log('[tamper] every other row still verifies.');
  await client.close();
  process.exit(0);
}

console.error('[tamper] unexpected result: tampered row was not the only failure');
await client.close();
process.exit(1);
