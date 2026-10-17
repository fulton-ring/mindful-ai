CREATE TABLE turn_execution_state (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  alarm_at BIGINT,
  ended_at BIGINT
);
CREATE INDEX turn_execution_state_alarm ON turn_execution_state(alarm_at);
