/* Optional Langfuse mirror.
   Reads the six actions back from ClickHouse and sends each one as a real
   Langfuse trace, action_ref in the metadata. With Langfuse connected, the
   same JOIN logic runs against real observability data instead of the
   self-contained agent_traces mirror.
   Skips silently when LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is absent. */

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASEURL;

if (!publicKey || !secretKey) {
  process.exit(0);
}

const { Langfuse } = await import('langfuse');
const { createClient } = await import('@clickhouse/client');

const client = createClient({ url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123', username: process.env.CLICKHOUSE_USER ?? 'default', password: process.env.CLICKHOUSE_PASSWORD ?? '' });

interface TraceRow {
  trace_id: string;
  action_ref: string;
  agent_id: string;
  tool_name: string;
  observed_scope: string;
  input_digest: string;
  output_digest: string;
  ts: string;
}

interface ReceiptRow {
  action_ref: string;
  decision: string;
  scope: string;
}

const traces = await client
  .query({ query: 'SELECT * FROM agent_traces ORDER BY ts', format: 'JSONEachRow' })
  .then((r) => r.json<TraceRow>());
const receipts = await client
  .query({ query: 'SELECT action_ref, decision, scope FROM aps_receipts', format: 'JSONEachRow' })
  .then((r) => r.json<ReceiptRow>());
const byRef = new Map(receipts.map((r) => [r.action_ref, r]));

const langfuse = new Langfuse({ publicKey, secretKey, ...(baseUrl ? { baseUrl } : {}) });

for (const t of traces) {
  const receipt = byRef.get(t.action_ref);
  langfuse.trace({
    name: `agent-action:${t.tool_name}`,
    timestamp: new Date(`${t.ts.replace(' ', 'T')}Z`),
    metadata: {
      action_ref: t.action_ref,
      agent_id: t.agent_id,
      observed_scope: t.observed_scope,
      receipt_decision: receipt?.decision ?? 'missing',
      authorized_scope: receipt?.scope ?? 'missing',
    },
    input: { tool: t.tool_name, input_digest: t.input_digest },
    output: { output_digest: t.output_digest },
  });
}

await langfuse.flushAsync();
await langfuse.shutdownAsync();
await client.close();

console.log(`[langfuse] sent ${traces.length} traces, action_ref in metadata`);
