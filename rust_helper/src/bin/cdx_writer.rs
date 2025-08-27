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
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out { Ready, Ack { deleted: usize }, Error { message: String } }

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
                        match conn.busy_timeout(std::time::Duration::from_millis(60000)) {
                            Ok(_) => {},
                            Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: format!("busy_timeout failed: {}", e)}).unwrap()); return; }
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
                    match retry_with_backoff(|| {
                        let tx = conn.transaction()?;
                        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS temp_to_delete(hash TEXT PRIMARY KEY);")?;
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
                    match retry_with_backoff(|| {
                        let tx = conn.transaction()?;
                        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS temp_scores(hash TEXT PRIMARY KEY, score REAL);")?;
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
        }
    }
}


