DROP TABLE IF EXISTS aps_receipts;

CREATE TABLE aps_receipts
(
    receipt_id            String,
    action_ref            String,
    agent_id              String,
    delegation_chain_root String,
    scope                 String,
    decision              Enum('permit', 'deny', 'narrow'),
    policy_digest         String,
    payload_digest        String,
    ts                    DateTime64(3),
    signature             String,
    pubkey                String,
    raw                   String
)
ENGINE = MergeTree
ORDER BY (agent_id, ts);

DROP TABLE IF EXISTS agent_traces;

CREATE TABLE agent_traces
(
    trace_id       String,
    action_ref     String,
    agent_id       String,
    tool_name      String,
    observed_scope String,
    input_digest   String,
    output_digest  String,
    ts             DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (agent_id, ts);
