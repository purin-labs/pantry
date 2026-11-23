-- A flow label now holds an owner and readers only. Labels stored before
-- this change also held copies of the organisation's tool rules, and they no
-- longer restore. These rows are deleted, not converted. A deleted projection
-- row leaves context search until its source is projected again. A forked
-- chat without its row continues without the inherited history.
--
-- Apply to each regional database (and a local combined database) right
-- after the Worker release. The Worker before the release still writes the
-- old label form. The schema does not change.
DELETE FROM context_projection
WHERE EXISTS (
  SELECT 1
  FROM json_each(context_projection.flow_label_json, '$.policies') AS policy
  WHERE json_type(policy.value, '$.restrictions') IS NOT NULL
);

DELETE FROM portal_chat_fork
WHERE history_json IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM json_tree(portal_chat_fork.history_json, '$.bindings') AS node
    WHERE node.key = 'restrictions'
  );
