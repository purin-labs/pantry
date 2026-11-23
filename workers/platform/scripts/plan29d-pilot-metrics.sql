-- Content-free proposal counts. Run through the restricted D1 operator workflow.
-- No recipients, subjects, bodies, account identifiers or proposal IDs are exported.
SELECT 'gmail_reply' AS product, lifecycle_kind, COUNT(*) AS proposal_count,
  SUM(CASE WHEN current_version > 1 THEN 1 ELSE 0 END) AS revised_proposal_count
FROM email_reply_proposal
GROUP BY lifecycle_kind;

SELECT 'operational_new_message' AS product, lifecycle_kind,
  COUNT(*) AS proposal_count,
  SUM(CASE WHEN current_version > 1 THEN 1 ELSE 0 END) AS revised_proposal_count
FROM email_operational_proposal_projection
GROUP BY lifecycle_kind;

SELECT COUNT(*) AS reviewed_routes,
  SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked_routes,
  SUM(CASE WHEN revoked_at IS NULL AND review_expires_at <= unixepoch() * 1000
    THEN 1 ELSE 0 END) AS expired_reviews
FROM gmail_inference_eligibility;
