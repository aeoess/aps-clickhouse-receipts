/* Control plane adapter.
   Three calls turn any control plane's dispatch loop into a signed,
   re-verifiable audit trail in ClickHouse:

     registerControlPlaneAgent  identity + narrow delegation from a principal
     receiptForAction           one signed APS receipt row per dispatched action
     verifyTrail                read an agent's rows back, re-verify every signature

   Wraps the exact API surface src/emit.ts uses. Row shape and verification
   checks match src/verify.ts, so rows written here also pass `npm run verify`.
   This file never edits the demo paths; it only adds a callable surface. */

import { readFileSync } from 'node:fs';
import { createClient } from '@clickhouse/client';
import {
  FloorValidatorV1,
  actionRefsMatch,
  canonicalHash,
  computeActionRef,
  computeDelegationChainRoot,
  createActionIntent,
  createDelegation,
  createPolicyReceipt,
  createPrincipalIdentity,
  createReceipt,
  evaluateIntent,
  generateKeyPair,
  loadFloor,
  verifyActionIntent,
  verifyDelegation,
  verifyPolicyDecision,
  verifyPolicyReceipt,
} from 'agent-passport-system';

type KeyPair = ReturnType<typeof generateKeyPair>;
type Delegation = ReturnType<typeof createDelegation>;
export type PrincipalBundle = ReturnType<typeof createPrincipalIdentity>;

const DEFAULT_TABLE = 'aps_receipts';

/* Same env pattern as test/roundtrip.test.ts: password defaults to the
   compose-pinned value so everything works against the repo's own docker
   setup out of the box. */
let client: ReturnType<typeof createClient> | null = null;
function ch() {
  client ??= createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'aps_demo',
  });
  return client;
}

export async function closeAdapterClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

/* ClickHouse DateTime64(3) wants 'YYYY-MM-DD hh:mm:ss.mmm'. Same as emit.ts. */
const toCH = (iso: string) => iso.replace('T', ' ').replace('Z', '').slice(0, 23);

/* The values floor ships inside the SDK package. Same load as emit.ts. */
const floorYaml = readFileSync(
  new URL('../node_modules/agent-passport-system/values/floor.yaml', import.meta.url),
  'utf8',
);
const floor = loadFloor(floorYaml);
const floorPrinciples = floor.floor.map((p) => ({
  id: p.id,
  name: p.name,
  enforcement: p.enforcement,
  weight: p.weight,
}));

export interface ControlPlaneAgent {
  agentId: string;
  keys: KeyPair;
  delegation: Delegation;
  evaluatorId: string;
  evaluatorKeys: KeyPair;
  verifierKeys: KeyPair;
  validationContext: Record<string, unknown>;
}

/* 1. Register an agent under a principal with a caller-supplied scope.
   The SDK treats delegatedBy as the signer's public key (key as identity). */
export function registerControlPlaneAgent(
  name: string,
  principal: PrincipalBundle,
  scope: string[],
  options: { spendLimit?: number; expiresInHours?: number } = {},
): ControlPlaneAgent {
  const agentId = name.startsWith('agent:') ? name : `agent:${name}`;
  const keys = generateKeyPair();
  const evaluatorKeys = generateKeyPair();
  const verifierKeys = generateKeyPair();

  const delegation = createDelegation({
    delegatedTo: agentId,
    delegatedBy: principal.principal.publicKey,
    scope,
    ...(options.spendLimit !== undefined
      ? { spendLimit: options.spendLimit, spendLimitUnit: 'currency' }
      : {}),
    maxDepth: 1,
    expiresInHours: options.expiresInHours ?? 24,
    privateKey: principal.keyPair.privateKey,
  });

  const validationContext = {
    floorVersion: floor.version,
    floorPrinciples,
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

  return { agentId, keys, delegation, evaluatorId: 'evaluator:floor-v1', evaluatorKeys, verifierKeys, validationContext };
}

export interface ActionRequest {
  agent: ControlPlaneAgent;
  tool: string;
  args: Record<string, unknown> & {
    target?: string;
    spend?: { amount: number; currency: string };
  };
  /* Scope the action requires. Defaults to the tool name, like emit.ts. */
  scope_check?: string;
  /* Override for tests. The demo table is the default. */
  table?: string;
}

export interface ActionReceiptResult {
  decision: string;
  receiptId: string;
  actionRef: string;
  row: Record<string, unknown>;
}

/* 2. One signed receipt per dispatched action, inserted into ClickHouse.
   Permit rows carry four signed artifacts (intent, decision, action receipt,
   policy receipt). The SDK refuses to mint an action receipt for an
   out-of-scope call by design, so a deny row lands with its two signed
   artifacts instead: the agent's signed intent and the signed deny decision. */
export async function receiptForAction(req: ActionRequest): Promise<ActionReceiptResult> {
  const { agent, tool, args } = req;
  const scopeRequired = req.scope_check ?? tool;
  const table = req.table ?? DEFAULT_TABLE;
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`bad table name: ${table}`);

  const target = String(args.target ?? tool);

  const intent = createActionIntent({
    agentId: agent.agentId,
    agentPublicKey: agent.keys.publicKey,
    delegationId: agent.delegation.delegationId,
    action: {
      type: tool,
      target,
      scopeRequired,
      ...(args.spend ? { spend: args.spend } : {}),
    },
    context: JSON.stringify(args),
    privateKey: agent.keys.privateKey,
  });

  const decision = evaluateIntent({
    intent,
    validator: new FloorValidatorV1(),
    validationContext: agent.validationContext,
    evaluatorId: agent.evaluatorId,
    evaluatorPublicKey: agent.evaluatorKeys.publicKey,
    evaluatorPrivateKey: agent.evaluatorKeys.privateKey,
  });

  let receipt = null;
  let policyReceipt = null;
  if (decision.verdict === 'permit') {
    receipt = createReceipt({
      agentId: agent.agentId,
      delegationId: agent.delegation.delegationId,
      delegation: agent.delegation,
      action: {
        type: tool,
        target,
        scopeUsed: scopeRequired,
        ...(args.spend ? { spend: args.spend } : {}),
      },
      result: { status: 'success', summary: `ok: ${tool} on ${target}` },
      delegationChain: [agent.delegation.delegationId],
      privateKey: agent.keys.privateKey,
    });

    policyReceipt = createPolicyReceipt({
      intent,
      decision,
      receipt,
      verifierPrivateKey: agent.verifierKeys.privateKey,
      delegationChain: [agent.delegation],
    });
  }

  const actionRef = policyReceipt?.actionRef ?? intent.actionRef ?? '';
  const receiptId = policyReceipt ? policyReceipt.policyReceiptId : decision.decisionId;

  const row = {
    receipt_id: receiptId,
    action_ref: actionRef,
    agent_id: agent.agentId,
    delegation_chain_root:
      policyReceipt?.delegation_chain_root ?? computeDelegationChainRoot([agent.delegation]),
    scope: agent.delegation.scope.join(','),
    decision: decision.verdict,
    policy_digest: canonicalHash({ floorVersion: floor.version, principles: floorPrinciples }),
    payload_digest: canonicalHash({ action: intent.action }),
    ts: toCH(intent.createdAt),
    signature: intent.signature,
    pubkey: agent.keys.publicKey,
    raw: JSON.stringify({
      intent,
      decision,
      ...(receipt ? { receipt } : {}),
      ...(policyReceipt ? { policyReceipt } : {}),
      delegation: agent.delegation,
      verifierPublicKey: agent.verifierKeys.publicKey,
    }),
  };

  await ch().insert({ table, values: [row], format: 'JSONEachRow' });

  return { decision: decision.verdict, receiptId, actionRef, row };
}

interface StoredRow {
  receipt_id: string;
  action_ref: string;
  agent_id: string;
  scope: string;
  decision: string;
  signature: string;
  pubkey: string;
  raw: string;
  ts: string;
}

export interface TrailFailure {
  receiptId: string;
  check: string;
  detail: string;
}

export interface TrailReport {
  agentId: string;
  total: number;
  passed: number;
  ok: boolean;
  failures: TrailFailure[];
}

/* Same per-row checks as src/verify.ts, against the stored bytes only.
   verify.ts is a script and exports nothing, so the minimal checks are
   replicated here with the same SDK verify functions. The store is not
   trusted. */
function checkStoredRow(row: StoredRow): TrailFailure[] {
  const failures: TrailFailure[] = [];
  const fail = (check: string, detail: string) =>
    failures.push({ receiptId: row.receipt_id, check, detail });
  const raw = JSON.parse(row.raw);

  const intentCheck = verifyActionIntent(raw.intent);
  if (!intentCheck.valid) fail('intent signature', intentCheck.errors.join('; '));

  const decisionCheck = verifyPolicyDecision(raw.decision);
  if (!decisionCheck.valid) fail('decision signature', decisionCheck.errors.join('; '));

  /* Deny rows carry no policy receipt, by design. */
  if (raw.policyReceipt) {
    const receiptCheck = verifyPolicyReceipt(raw.policyReceipt, raw.verifierPublicKey);
    if (!receiptCheck.valid) fail('policy receipt chain', receiptCheck.errors.join('; '));
  }

  const delegationCheck = verifyDelegation(raw.delegation);
  if (!delegationCheck.valid) fail('delegation signature', delegationCheck.errors.join('; '));

  const recomputedRef = computeActionRef(raw.intent);
  if (!actionRefsMatch(recomputedRef, row.action_ref)) {
    fail(
      'action_ref recompute',
      `stored ${row.action_ref.slice(0, 16)} vs recomputed ${recomputedRef.slice(0, 16)}`,
    );
  }

  const signedScope = raw.delegation.scope.join(',');
  if (row.scope !== signedScope) {
    fail('scope column binding', `stored scope '${row.scope}' vs signed authority '${signedScope}'`);
  }

  if (row.signature !== raw.intent.signature || row.pubkey !== raw.intent.agentPublicKey) {
    fail('signature column binding', 'stored signature or pubkey column differs from the signed intent');
  }

  return failures;
}

/* 3. Read one agent's rows back and re-verify every signature. */
export async function verifyTrail(agentId: string, table: string = DEFAULT_TABLE): Promise<TrailReport> {
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`bad table name: ${table}`);

  const rs = await ch().query({
    query: `SELECT * FROM ${table} WHERE agent_id = {agentId: String} ORDER BY ts`,
    query_params: { agentId },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<StoredRow>();

  const failures: TrailFailure[] = [];
  let passed = 0;
  for (const row of rows) {
    const rowFailures = checkStoredRow(row);
    if (rowFailures.length === 0) passed += 1;
    else failures.push(...rowFailures);
  }

  return { agentId, total: rows.length, passed, ok: rows.length > 0 && failures.length === 0, failures };
}
