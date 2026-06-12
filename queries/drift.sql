-- Behavior outside receipted authority.
-- The trace says what happened. The receipt says what was allowed.
-- One JOIN on action_ref finds every mismatch.
SELECT
    t.action_ref            AS action_ref,
    r.agent_id              AS agent_id,
    t.tool_name             AS observed_tool,
    r.scope                 AS authorized_scope,
    r.decision              AS receipt_decision
FROM aps_receipts AS r
INNER JOIN agent_traces AS t USING (action_ref)
WHERE r.decision = 'deny'
   OR NOT has(splitByChar(',', r.scope), t.tool_name)
ORDER BY t.ts
