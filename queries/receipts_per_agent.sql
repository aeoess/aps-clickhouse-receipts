-- Receipts per agent per decision.
SELECT
    agent_id,
    decision,
    count() AS receipts
FROM aps_receipts
GROUP BY agent_id, decision
ORDER BY agent_id, decision
