-- Receipts grouped by delegation chain root.
-- Every receipt that flows from the same signed authority shares a root.
SELECT
    delegation_chain_root,
    count()                      AS receipts,
    countIf(decision = 'permit') AS permits,
    countIf(decision = 'deny')   AS denies,
    countIf(decision = 'narrow') AS narrows,
    min(ts)                      AS first_seen,
    max(ts)                      AS last_seen
FROM aps_receipts
GROUP BY delegation_chain_root
ORDER BY receipts DESC
