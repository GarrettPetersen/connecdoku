use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;
use std::thread;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Msg {
    Init { db_path: String },
    Delete { hashes: Vec<String> },
    UpsertScores { items: Vec<(String, f64)> },
    CountRange { min_hash: String, max_hash: String },
    SelectPage { min_hash: String, max_hash: String, after: String, limit: usize },
    Checkpoint,
    Close,
}

#[derive(Serialize)]
struct RowOut {
    puzzle_hash: String,
    row0: String,
    row1: String,
    row2: String,
    row3: String,
    col0: String,
    col1: String,
    col2: String,
    col3: String,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out { Ready, Ack { deleted: usize }, Rows { rows: Vec<RowOut> }, Count { total: usize }, Error { message: String } }

fn retry_with_backoff<F, T, E>(mut f: F, max_attempts: usize) -> Result<T, E>
where
    F: FnMut() -> Result<T, E>,
    E: std::fmt::Display,
{
    for attempt in 1..=max_attempts {
        match f() {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt == max_attempts {
                    return Err(e);
                }
                // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
                let delay = Duration::from_millis(50 * (1 << (attempt - 1)));
                thread::sleep(delay);
            }
        }
    }
    unreachable!()
}

fn main() {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    let mut stdout = std::io::stdout();
    let mut conn_opt: Option<rusqlite::Connection> = None;

    loop {
        line.clear();
        let n = reader.read_line(&mut line).unwrap();
        if n == 0 { break; }
        let msg: Msg = match serde_json::from_str(&line) { Ok(m) => m, Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("bad json: {}", e)}).unwrap()); continue; } };
        match msg {
            Msg::Init { db_path } => {
                // Try to open the database with a timeout
                match std::thread::spawn(move || {
                    rusqlite::Connection::open(db_path)
                }).join() {
                    Ok(Ok(conn)) => {
                        match conn.pragma_update(None, "journal_mode", &"WAL") {
                            Ok(_) => {},
                            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("WAL pragma failed: {}", e)}).unwrap()); return; }
                        }
                        match conn.pragma_update(None, "synchronous", &"OFF") {
                            Ok(_) => {},
                            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("synchronous pragma failed: {}", e)}).unwrap()); return; }
                        }
                        match conn.busy_timeout(std::time::Duration::from_millis(10_000)) {
                            Ok(_) => {},
                            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("busy_timeout failed: {}", e)}).unwrap()); return; }
                        }
                        // Create TEMP tables once per connection to avoid DDL inside write transactions
                        if let Err(e) = conn.execute_batch(
                            "CREATE TEMP TABLE IF NOT EXISTS temp_to_delete(hash TEXT PRIMARY KEY);\n\
                             CREATE TEMP TABLE IF NOT EXISTS temp_scores(hash TEXT PRIMARY KEY, score REAL);"
                        ) {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("temp tables setup failed: {}", e)}).unwrap());
                            return;
                        }
                        conn_opt = Some(conn);
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ready).unwrap());
                    }
                    Ok(Err(e)) => { 
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("database open failed: {}", e)}).unwrap()); 
                    }
                    Err(_) => { 
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "database open timed out".into() }).unwrap()); 
                    }
                }
            }
            Msg::Delete { hashes } => {
                if let Some(ref mut conn) = conn_opt {
                    use rusqlite::TransactionBehavior;
                    match retry_with_backoff(|| {
                        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                        {
                            let mut stmt = tx.prepare("INSERT OR IGNORE INTO temp_to_delete(hash) VALUES (?1)")?;
                            for h in &hashes { 
                                let _ = stmt.execute((&h,))?; 
                            }
                        }
                        let deleted = tx.execute("DELETE FROM puzzles WHERE puzzle_hash IN (SELECT hash FROM temp_to_delete)", ())?;
                        tx.execute("DELETE FROM temp_to_delete", ())?;
                        tx.commit()?;
                        Ok::<usize, rusqlite::Error>(deleted)
                    }, 5) {
                        Ok(deleted) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack{ deleted }).unwrap());
                        }
                        Err(e) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("delete failed after retries: {}", e)}).unwrap());
                        }
                    }
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::UpsertScores { items } => {
                if let Some(ref mut conn) = conn_opt {
                    use rusqlite::TransactionBehavior;
                    match retry_with_backoff(|| {
                        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                        {
                            let mut stmt = tx.prepare("INSERT OR REPLACE INTO temp_scores(hash, score) VALUES (?1, ?2)")?;
                            for (h, s) in &items { 
                                let _ = stmt.execute((h, s))?; 
                            }
                        }
                        tx.execute_batch("UPDATE puzzles SET puzzle_quality_score=(SELECT score FROM temp_scores WHERE temp_scores.hash=puzzles.puzzle_hash) WHERE puzzle_hash IN (SELECT hash FROM temp_scores);")?;
                        tx.execute("DELETE FROM temp_scores", ())?;
                        tx.commit()?;
                        Ok::<(), rusqlite::Error>(())
                    }, 5) {
                        Ok(_) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack{ deleted: 0 }).unwrap());
                        }
                        Err(e) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("upsert scores failed after retries: {}", e)}).unwrap());
                        }
                    }
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::CountRange { min_hash, max_hash } => {
                if let Some(ref mut conn) = conn_opt {
                    match conn.query_row(
                        "SELECT COUNT(*) FROM puzzles WHERE puzzle_hash > ?1 AND puzzle_hash <= ?2",
                        (&min_hash, &max_hash),
                        |row| row.get::<_, i64>(0),
                    ) {
                        Ok(count) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Count{ total: count as usize }).unwrap());
                        }
                        Err(e) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("count failed: {}", e)}).unwrap());
                        }
                    }
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::SelectPage { min_hash, max_hash, after, limit } => {
                if let Some(ref mut conn) = conn_opt {
                    let mut rows_out: Vec<RowOut> = Vec::new();
                    let mut stmt = match conn.prepare(
                        "SELECT puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3 \
                         FROM puzzles \
                         WHERE puzzle_hash > ?1 AND puzzle_hash <= ?2 AND puzzle_hash > ?3 \
                         ORDER BY puzzle_hash LIMIT ?4"
                    ) {
                        Ok(s) => s,
                        Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("prepare failed: {}", e)}).unwrap()); continue; }
                    };
                    let mut rows = match stmt.query((&min_hash, &max_hash, &after, limit as i64)) {
                        Ok(r) => r,
                        Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("select failed: {}", e)}).unwrap()); continue; }
                    };
                    while let Ok(Some(row)) = rows.next() {
                        let ro = RowOut {
                            puzzle_hash: row.get::<_, String>(0).unwrap_or_default(),
                            row0: row.get::<_, String>(1).unwrap_or_default(),
                            row1: row.get::<_, String>(2).unwrap_or_default(),
                            row2: row.get::<_, String>(3).unwrap_or_default(),
                            row3: row.get::<_, String>(4).unwrap_or_default(),
                            col0: row.get::<_, String>(5).unwrap_or_default(),
                            col1: row.get::<_, String>(6).unwrap_or_default(),
                            col2: row.get::<_, String>(7).unwrap_or_default(),
                            col3: row.get::<_, String>(8).unwrap_or_default(),
                        };
                        rows_out.push(ro);
                    }
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Rows{ rows: rows_out }).unwrap());
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::Checkpoint => {
                if let Some(ref mut conn) = conn_opt {
                    match conn.execute("PRAGMA wal_checkpoint(TRUNCATE)", ()) {
                        Ok(_) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack{ deleted: 0 }).unwrap());
                        }
                        Err(e) => {
                            let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("checkpoint failed: {}", e)}).unwrap());
                        }
                    }
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::Close => {
                // Close the database connection
                conn_opt = None;
                let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack{ deleted: 0 }).unwrap());
            }
        }
    }
}


