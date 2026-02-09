# Connecdoku Development Makefile
# Common commands for managing the puzzle database and data

.PHONY: help build clean solve clean-db check-future curator ai-curator update-data review-puzzle delete-low-quality delete-old-hash-puzzles geological-era species-data serve

# Local server config
PORT ?= 8000

# Default target
help:
	@echo "Connecdoku Development Commands:"
	@echo ""
	@echo "Build & Setup:"
	@echo "  build          - Build Rust binaries (cdx_cleaner, cdx_writer, cdx_worker)"
	@echo "  clean          - Clean Rust build artifacts"
	@echo "  serve          - Serve the site at http://localhost:$(PORT) (override with PORT=xxxx)"
	@echo ""
	@echo "Database Operations:"
	@echo "  solve          - Run matrix solver to generate new puzzles"
	@echo "  clean-db       - Clean invalid puzzles from database (parallel)"
	@echo "  clean-db-single- Run clean database script (single-threaded)"
	@echo ""
	@echo "Data Management:"
	@echo "  update-data    - Update all data files (words, categories, etc.)"
	@echo "  check-future   - Check future puzzles for validity"
	@echo "  delete-low-quality - Delete low quality future puzzles"
	@echo "  geological-era - Update geological era data"
	@echo "  species-data   - Update species geological data"
	@echo ""
	@echo "Puzzle Management:"
	@echo "  curator        - Run puzzle curator"
	@echo "  ai-curator     - Run AI puzzle curator (use ACTION=select/input VALUE=xxx)"
	@echo "  review-puzzle  - Review specific puzzle"
	@echo ""
	@echo "Database Maintenance:"
	@echo "  checkpoint     - Run WAL checkpoint to clean up database"
	@echo "  delete-old-hash-puzzles - Delete puzzles with old word list hashes (reclaims space)"
	@echo "  db-size        - Show database file sizes"
	@echo "  db-status      - Show database status and statistics"

# Build Rust binaries
build:
	@echo "Building Rust binaries..."
	cd rust_helper && cargo build --release
	@echo "✓ Rust binaries built successfully"

# Clean Rust build artifacts
clean:
	@echo "Cleaning Rust build artifacts..."
	cd rust_helper && cargo clean
	@echo "✓ Build artifacts cleaned"

# Run matrix solver to generate new puzzles
solve:
	@echo "Running matrix solver..."
	caffeinate -i node connecdoku_matrix_solver_sqlite.js

# Clean invalid puzzles from database (parallel version)
clean-db:
	@echo "Cleaning database (parallel)..."
	caffeinate -i node clean_db_parallel.js

# Clean invalid puzzles from database (single-threaded version)
clean-db-single:
	@echo "Cleaning database (single-threaded)..."
	node clean_db.js

# Update all data files
update-data:
	@echo "Updating all data files..."
	node update_all_data.js

# Check future puzzles for validity
check-future:
	@echo "Checking future puzzles..."
	node check_future_puzzles.js

# Delete low quality future puzzles
delete-low-quality:
	@echo "Deleting low quality future puzzles..."
	node delete_low_quality_future_puzzles.js

# Delete puzzles with old word list hashes (immediately reclaims space)
delete-old-hash-puzzles:
	@echo "Deleting puzzles with old word list hashes..."
	node delete_old_hash_puzzles.js

# Update geological era data
geological-era:
	@echo "Updating geological era data..."
	node geological_era_updater.js

# Update species geological data
species-data:
	@echo "Updating species geological data..."
	node species_geological_data.js

# Run puzzle curator
curator:
	@echo "Running puzzle curator..."
	node puzzle_curator_sqlite.js

# Run AI puzzle curator
ai-curator:
	@echo "Running AI puzzle curator..."
	node ai_curator.js $(ACTION) $(VALUE)

# Review specific puzzle (requires puzzle index as argument)
review-puzzle:
	@if [ -z "$(INDEX)" ]; then \
		echo "Error: Please provide INDEX parameter"; \
		echo "Usage: make review-puzzle INDEX=<index>"; \
		echo "Examples: make review-puzzle INDEX=-1 (last puzzle)"; \
		echo "          make review-puzzle INDEX=0 (first puzzle)"; \
		echo "          make review-puzzle INDEX=5 (sixth puzzle)"; \
		exit 1; \
	fi
	@echo "Reviewing puzzle at index: $(INDEX)"
	node review_puzzle.js $(INDEX)

# Run WAL checkpoint to clean up database
checkpoint:
	@echo "Running WAL checkpoint..."
	sqlite3 puzzles.db "PRAGMA wal_checkpoint(TRUNCATE);"
	@echo "✓ Checkpoint completed"

# Reclaim space after deletions (VACUUM)
vacuum:
	@echo "Reclaiming database space (VACUUM)..."
	sqlite3 puzzles.db "VACUUM;"
	@echo "✓ Database space reclaimed"

# Show database file sizes
db-size:
	@echo "Database file sizes:"
	@ls -lh puzzles.db*
	@echo ""
	@echo "Database statistics:"
	@sqlite3 puzzles.db "SELECT COUNT(*) as total_puzzles FROM puzzles;"

# Show database status and statistics
db-status:
	@echo "Database Status:"
	@echo "================"
	@sqlite3 puzzles.db "PRAGMA journal_mode;"
	@echo ""
	@echo "Puzzle Counts:"
	@sqlite3 puzzles.db "SELECT COUNT(*) as total_puzzles FROM puzzles;"
	@echo ""
	@echo "Recent puzzles:"
	@sqlite3 puzzles.db "SELECT puzzle_hash, row0, col0 FROM puzzles ORDER BY ROWID DESC LIMIT 5;"

# Development helpers
dev-setup: build update-data
	@echo "✓ Development environment setup complete"

# Full database rebuild (clean + solve)
rebuild: clean-db solve
	@echo "✓ Database rebuild complete"

# Quick validation check
validate: check-future
	@echo "✓ Validation check complete"

# Serve static site locally
serve:
	@echo "Serving static site at http://localhost:$(PORT)"
	@echo "Press Ctrl+C to stop."
	python3 -m http.server $(PORT)
