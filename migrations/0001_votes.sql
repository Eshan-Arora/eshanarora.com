CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  show_results INTEGER NOT NULL DEFAULT 0 CHECK (show_results IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);
CREATE UNIQUE INDEX one_active_round ON rounds(active) WHERE active = 1;
CREATE TABLE ballots (
  round_id TEXT NOT NULL REFERENCES rounds(id),
  voter_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  PRIMARY KEY (round_id, voter_id)
);
CREATE INDEX round_history ON rounds(created_at DESC);
