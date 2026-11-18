-- Apply once to deployed global databases before releasing retention waiver support.
ALTER TABLE state_object_relocation ADD COLUMN retention_waived_at INTEGER
CHECK (retention_waived_at IS NULL OR
  (retention_waived_at >= resumed_at AND status IN ('retained', 'cleaning', 'complete')));
