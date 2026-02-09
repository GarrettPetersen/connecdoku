#!/usr/bin/env node
// delete_old_hash_puzzles.js - Immediately delete all puzzles with old word list hashes
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sqlite3 from "sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── paths ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const DB_PATH = path.join(__dirname, "puzzles.db");

// ───────── helpers ──────────────────────────────────────────────────────────
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

async function main() {
    console.log("🗑️  Deleting puzzles with old word list hashes");
    console.log("=".repeat(60));
    
    // Calculate current word list hash
    console.log("Calculating current word list hash...");
    const currentHash = sha256(fs.readFileSync(WORDS_F));
    console.log(`Current word list hash: ${currentHash.substring(0, 16)}...`);
    
    // Connect to database
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error("Error opening database:", err.message);
                reject(err);
                return;
            }
            
            // First, checkpoint WAL to minimize its size before deletion
            console.log("\nCheckpointing WAL file...");
            db.run("PRAGMA wal_checkpoint(TRUNCATE)", (err) => {
                if (err) {
                    console.warn("Warning: Could not checkpoint WAL:", err.message);
                }
                
                // Check current state
                db.get("SELECT COUNT(*) as total, COUNT(CASE WHEN word_list_hash = ? THEN 1 END) as current_hash FROM puzzles", 
                       [currentHash], 
                       (err, row) => {
                    if (err) {
                        console.error("Error querying database:", err.message);
                        db.close();
                        reject(err);
                        return;
                    }
                    
                    const total = row.total || 0;
                    const currentHashCount = row.current_hash || 0;
                    const oldHashCount = total - currentHashCount;
                    
                    console.log(`\nDatabase status:`);
                    console.log(`  Total puzzles: ${total}`);
                    console.log(`  Puzzles with current hash: ${currentHashCount}`);
                    console.log(`  Puzzles with old hash: ${oldHashCount}`);
                    
                    if (oldHashCount === 0) {
                        console.log("\n✅ No puzzles with old hashes found. Nothing to delete.");
                        db.close();
                        resolve();
                        return;
                    }
                    
                    // Delete puzzles with old hashes in a transaction to minimize WAL growth
                    console.log(`\nDeleting ${oldHashCount} puzzles with old word list hashes...`);
                    db.run("BEGIN TRANSACTION", (err) => {
                        if (err) {
                            console.error("Error starting transaction:", err.message);
                            db.close();
                            reject(err);
                            return;
                        }
                        
                        db.run("DELETE FROM puzzles WHERE word_list_hash != ? OR word_list_hash IS NULL", 
                               [currentHash], 
                               function(err) {
                            if (err) {
                                console.error("Error deleting puzzles:", err.message);
                                db.run("ROLLBACK", () => db.close());
                                reject(err);
                                return;
                            }
                            
                            const deleted = this.changes;
                            console.log(`✅ Deleted ${deleted} puzzles with old word list hash`);
                            
                            // Commit transaction
                            db.run("COMMIT", (err) => {
                                if (err) {
                                    console.error("Error committing transaction:", err.message);
                                    db.close();
                                    reject(err);
                                    return;
                                }
                                
                                // Immediately VACUUM to reclaim space
                                console.log("\nRunning VACUUM to reclaim disk space...");
                                db.run("VACUUM", (err) => {
                                    if (err) {
                                        console.error("Error running VACUUM:", err.message);
                                        db.close();
                                        reject(err);
                                        return;
                                    }
                                    
                                    // Verify final count
                                    db.get("SELECT COUNT(*) as count FROM puzzles", (err2, row2) => {
                                        if (err2) {
                                            console.warn("Warning: Could not verify final count:", err2.message);
                                        } else {
                                            console.log(`\nFinal database count: ${row2.count} puzzles`);
                                        }
                                        
                                        db.close((err3) => {
                                            if (err3) {
                                                console.error("Error closing database:", err3.message);
                                                reject(err3);
                                            } else {
                                                console.log("✅ Cleanup complete! Disk space reclaimed.");
                                                resolve();
                                            }
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

// Run the cleanup
main().catch(err => {
    console.error("Error during cleanup:", err);
    process.exit(1);
});

