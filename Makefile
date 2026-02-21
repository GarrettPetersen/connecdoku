# Connecdoku Development Makefile
# Common commands for managing the puzzle database and data

.PHONY: help build clean solve-and-curate delete-db check-future ai-curator update-data review-puzzle delete-low-quality geological-era species-data serve
.PHONY: cell-options cell-replace

# Local server config
PORT ?= 8000

# Default target
help:
	@echo "Connecdoku Development Commands:"
	@echo ""
	@echo "Build & Setup:"
	@echo "  build          - Build Rust binaries (cdx_worker)"
	@echo "  clean          - Clean Rust build artifacts"
	@echo "  serve          - Serve the site at http://localhost:$(PORT) (override with PORT=xxxx)"
	@echo ""
	@echo "Solve & Curate:"
	@echo "  solve-and-curate - Find good puzzles in-memory (no DB) and hand off to AI curator"
	@echo ""
	@echo "Data Management:"
	@echo "  update-data    - Update all data files (words, categories, etc.)"
	@echo "  check-future   - Check future puzzles for validity"
	@echo "  delete-low-quality - Delete low quality future puzzles"
	@echo "  geological-era - Update geological era data"
	@echo "  species-data   - Update species geological data"
	@echo ""
	@echo "Puzzle Management:"
	@echo "  ai-curator     - Run AI puzzle curator (use ACTION=select/input VALUE=xxx)"
	@echo "  review-puzzle  - Review specific puzzle"
	@echo ""
	@echo "Legacy / Cleanup:"
	@echo "  delete-db      - Delete local database files (puzzles.db*) if present"

# Build Rust binaries
build:
	@echo "Building Rust binaries..."
	cd rust_helper && cargo build --release --bin cdx_worker
	@echo "✓ Rust binaries built successfully"

# Clean Rust build artifacts
clean:
	@echo "Cleaning Rust build artifacts..."
	cd rust_helper && cargo clean
	@echo "✓ Build artifacts cleaned"

# Solve-and-curate (no DB): find high-quality diverse puzzles directly and hand to AI curator
solve-and-curate:
	@echo "Running solve-and-curate (no DB)..."
	SOLVE_CURATE_NONINTERACTIVE=1 node solve_and_curate.js

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

# Show replacement options for a specific puzzle cell (0-based row/col indices).
# Usage:
#   make cell-options INDEX=-5 ROW=3 COL=0
cell-options:
	@if [ -z "$(INDEX)" ] || [ -z "$(ROW)" ] || [ -z "$(COL)" ]; then \
		echo "Error: Please provide INDEX, ROW, and COL"; \
		echo "Usage: make cell-options INDEX=<puzzleIndex> ROW=<0..3> COL=<0..3>"; \
		exit 1; \
	fi
	node puzzle_cell_options.js --index "$(INDEX)" --row "$(ROW)" --col "$(COL)"

# Replace a specific puzzle cell with a new word (validated). (No backups; rely on git.)
# Usage:
#   make cell-replace INDEX=-5 ROW=3 COL=0 WORD="The Rescuers Down Under"
cell-replace:
	@if [ -z "$(INDEX)" ] || [ -z "$(ROW)" ] || [ -z "$(COL)" ] || [ -z "$(WORD)" ]; then \
		echo "Error: Please provide INDEX, ROW, COL, and WORD"; \
		echo "Usage: make cell-replace INDEX=<puzzleIndex> ROW=<0..3> COL=<0..3> WORD=\"...\""; \
		exit 1; \
	fi
	node puzzle_cell_replace.js --index "$(INDEX)" --row "$(ROW)" --col "$(COL)" --word "$(WORD)"

delete-db:
	@echo "Deleting local DB files (if present)..."
	@rm -f puzzles.db puzzles.db-wal puzzles.db-shm
	@echo "✓ Deleted puzzles.db*"

# Development helpers
dev-setup: build update-data
	@echo "✓ Development environment setup complete"

# Quick validation check
validate: check-future
	@echo "✓ Validation check complete"

# Serve static site locally
serve:
	@echo "Serving static site at http://localhost:$(PORT)"
	@echo "Press Ctrl+C to stop."
	python3 -m http.server $(PORT)
