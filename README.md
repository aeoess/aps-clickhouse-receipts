# aps-clickhouse-receipts

APS signed receipts land in ClickHouse next to agent traces.
The receipt says what the agent was allowed to do. The trace says what it did.
One SQL JOIN finds every action that left its authority.
Tamper with a stored row and verification catches it. The store is not trusted.
Everything is signed with Ed25519 and re-verified straight out of the database.

## Quickstart

```
npm install
./demo.sh
```

Three commands if you count the clone. The demo starts ClickHouse via docker
compose (or a local `bin/clickhouse` binary when Docker is absent), applies the
schema, emits six actions, verifies all receipts, tampers with one row, catches
it, and runs the drift query. Under 2 minutes.

## Architecture

```
                +-----------------+
                |      agent      |
                +--------+--------+
                         |
              declares intent, then acts
                         |
          +--------------+--------------+
          v                             v
   APS policy receipt            runtime trace
   (signed: what was             (observed: what
    allowed at decision           actually ran)
    time)                               |
          |                             +--> Langfuse (optional)
          v                             v
    aps_receipts                  agent_traces
          \                            /
           \    JOIN USING action_ref
            v
     drift report: behavior outside authority
```

## What the demo shows

1. A principal delegates a narrow scope to an agent: tools `search` and
   `summarize`, spend limit 50.
2. The agent runs six actions. Five fit the scope. The sixth calls
   `transfer_funds`. The policy evaluator denies it. The runtime trace shows
   it ran anyway.
3. `src/verify.ts` reads every row back and re-verifies all Ed25519
   signatures and recomputes `action_ref` with the SDK's own functions.
4. `--tamper` widens one row's `scope` column with `ALTER TABLE UPDATE`.
   Verification fails on exactly that row: the column no longer matches the
   signed delegation. The other rows still pass.
5. `queries/drift.sql` joins receipts to traces on `action_ref` and returns
   every action whose observed tool sits outside its receipted authority.

## What a receipt proves and what it does not prove

A receipt proves three things at decision time:

- Authority. A signed delegation chain reaches from a principal to the agent.
- Policy. A named evaluator checked the intent and signed a verdict.
- Integrity. The stored tuple still matches its signatures. Any edit shows.

A receipt does not prove that the runtime effect matched the declaration.
The agent can still do something else after the decision. That gap is exactly
what the trace table covers, and why the JOIN matters: receipts bound what was
allowed, traces record what happened, and the difference is the drift report.

## Langfuse mode

`src/langfuse.ts` mirrors the same six actions to Langfuse as real traces,
`action_ref` in the metadata. Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
and optionally `LANGFUSE_BASEURL`, then rerun `./demo.sh`. Without the keys
the step skips silently. The `agent_traces` mirror table keeps the demo
self-contained either way: the JOIN runs against local rows, no external
service required.

## Audit dashboard (OpenUI)

`dashboard/index.html` is one self-contained file. It fetches the drift JOIN
and the receipts-per-agent rollup from ClickHouse over HTTP as JSON, then
renders them with the OpenUI browser bundle: a callout with the count of
actions that left authority, the drift table, and a bar chart of receipts
per agent per decision. Connection settings live in the small `CH` config
object at the top of the file; the defaults match `docker-compose.yml`.

Open it after a demo run:

    open dashboard/index.html

![Audit dashboard screenshot placeholder](dashboard/screenshot.png)

## For control planes
A control plane enforces at the moment of action. This adapter makes what it
enforced verifiable by a third party: three calls turn a dispatch loop into a
signed, tamper-evident audit trail in ClickHouse. Works with any control plane
that can call a function per action. Wiring it to a specific platform SDK
(Guild, or any other) is an afternoon, not a project.

## Live Guild agent
guild-live/ holds an agent scaffolded with the Guild CLI (guild agent init,
LLM template) whose tool dispatch is wired through this adapter: one signed
receipt per tool call, one out-of-scope delete denied live without executing,
and the whole trail re-verified from ClickHouse. See guild-live/RUN.md for
the captured run.

## Presenter agent

The demo video was produced by a receipted presenter agent: every build step
ran as a receipt-gated tool call under a signed delegation, with one denied
out-of-scope dispatch (publish_video). See presenter/RUN.md.

## About APS

APS is an open Apache 2.0 protocol. 3,959 tests in the SDK suite.
Specified in IETF Internet-Draft draft-pidlisnyi-aps, with contributions
merged into Microsoft's agent governance toolkit. A hosted gateway product
exists; this repo only uses the open SDK.

## License

Apache-2.0. Copyright 2026 Tymofii Pidlisnyi.
