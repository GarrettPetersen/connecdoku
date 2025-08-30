# Connecdoku Development Makefile
# Common commands for managing the puzzle database and data

.PHONY: help build clean solve clean-db check-future curator update-data review-puzzle delete-low-quality geological-era species-data

# Default target
help:
	@echo "Connecdoku Development Commands:"
	@echo ""
	@echo "Build & Setup:"
	@echo "  build          - Build Rust binaries (cdx_cleaner, cdx_writer, cdx_worker)"
	@echo "  clean          - Clean Rust build artifacts"
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
	@echo "  review-puzzle  - Review specific puzzle"
	@echo ""
	@echo "Database Maintenance:"
	@echo "  checkpoint     - Run WAL checkpoint to clean up database"
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

# Review specific puzzle (requires puzzle hash as argument)
review-puzzle:
	@if [ -z "$(PUZZLE_HASH)" ]; then \
		echo "Error: Please provide PUZZLE_HASH parameter"; \
		echo "Usage: make review-puzzle PUZZLE_HASH=<hash>"; \
		exit 1; \
	fi
	@echo "Reviewing puzzle: $(PUZZLE_HASH)"
	node review_puzzle.js $(PUZZLE_HASH)

# Run WAL checkpoint to clean up database
checkpoint:
	@echo "Running WAL checkpoint..."
	sqlite3 puzzles.db "PRAGMA wal_checkpoint(TRUNCATE);"
	@echo "✓ Checkpoint completed"

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
