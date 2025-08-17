use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Msg {
    Init { db_path: String },
    Delete { hashes: Vec<String> },
    UpsertScores { items: Vec<(String, i64)> },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out { Ready, Ack, Error { message: String } }

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
                match rusqlite::Connection::open(db_path) {
                    Ok(conn) => {
                        let _ = conn.pragma_update(None, "journal_mode", &"WAL");
                        let _ = conn.pragma_update(None, "synchronous", &"OFF");
                        let _ = conn.busy_timeout(std::time::Duration::from_millis(60000));
                        conn_opt = Some(conn);
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ready).unwrap());
                    }
                    Err(e) => { let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: e.to_string()}).unwrap()); }
                }
            }
            Msg::Delete { hashes } => {
                if let Some(ref mut conn) = conn_opt {
                    let tx = conn.transaction().unwrap();
                    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS temp_to_delete(hash TEXT PRIMARY KEY);").unwrap();
                    {
                        let mut stmt = tx.prepare("INSERT OR IGNORE INTO temp_to_delete(hash) VALUES (?1)").unwrap();
                        for h in &hashes { let _ = stmt.execute((&h,)); }
                    }
                    tx.execute("DELETE FROM puzzles WHERE puzzle_hash IN (SELECT hash FROM temp_to_delete)", ()).unwrap();
                    tx.execute("DELETE FROM temp_to_delete", ()).unwrap();
                    tx.commit().unwrap();
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack).unwrap());
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
            Msg::UpsertScores { items } => {
                if let Some(ref mut conn) = conn_opt {
                    let tx = conn.transaction().unwrap();
                    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS temp_scores(hash TEXT PRIMARY KEY, score INTEGER);").unwrap();
                    {
                        let mut stmt = tx.prepare("INSERT OR REPLACE INTO temp_scores(hash, score) VALUES (?1, ?2)").unwrap();
                        for (h, s) in &items { let _ = stmt.execute((h, s)); }
                    }
                    tx.execute_batch("UPDATE puzzles SET puzzle_quality_score=(SELECT score FROM temp_scores WHERE temp_scores.hash=puzzles.puzzle_hash) WHERE puzzle_hash IN (SELECT hash FROM temp_scores);").unwrap();
                    tx.execute("DELETE FROM temp_scores", ()).unwrap();
                    tx.commit().unwrap();
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Ack).unwrap());
                } else {
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&Out::Error{ message: "no db".into() }).unwrap());
                }
            }
        }
    }
}


