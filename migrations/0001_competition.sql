CREATE TABLE IF NOT EXISTS competitors (
  model TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competition_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  puzzle_date TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost')),
  strikes INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  solved_rows INTEGER NOT NULL,
  solved_cols INTEGER NOT NULL,
  solved_lines_total INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT,
  notes TEXT,
  UNIQUE(model, puzzle_date),
  FOREIGN KEY(model) REFERENCES competitors(model)
);

CREATE INDEX IF NOT EXISTS idx_comp_results_model ON competition_results(model);
CREATE INDEX IF NOT EXISTS idx_comp_results_date ON competition_results(puzzle_date);
CREATE INDEX IF NOT EXISTS idx_comp_results_outcome ON competition_results(outcome);
