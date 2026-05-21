CREATE TABLE IF NOT EXISTS competition_attempts (
  model TEXT NOT NULL,
  puzzle_date TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  outcome TEXT CHECK (outcome IN ('won', 'lost') OR outcome IS NULL),
  strikes INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  source_ip TEXT,
  user_agent TEXT,
  PRIMARY KEY (model, puzzle_date),
  FOREIGN KEY(model) REFERENCES competitors(model)
);

CREATE INDEX IF NOT EXISTS idx_comp_attempts_date ON competition_attempts(puzzle_date);
CREATE INDEX IF NOT EXISTS idx_comp_attempts_finished ON competition_attempts(finished);
