#!/usr/bin/env python3
"""
Analyze categories in words.json to find categories with fewer than 4 items.
These categories need to be expanded to be useful in the 4x4 grid game.
"""

import json
from collections import defaultdict


def analyze_categories():
    # Load the words data
    with open("data/words.json", "r") as f:
        words_data = json.load(f)

    # Create a reverse mapping: category -> list of words
    categories = defaultdict(list)
    for word, word_categories in words_data.items():
        for category in word_categories:
            categories[category].append(word)

    # Find categories with fewer than 4 items, excluding "Starts with" and "Ends with"
    small_categories = {}
    for category, words in categories.items():
        if (
            len(words) < 4
            and not category.startswith("Starts with")
            and not category.startswith("Ends with")
        ):
            small_categories[category] = words

    # Sort by number of items (ascending)
    sorted_small_categories = sorted(small_categories.items(), key=lambda x: len(x[1]))

    print(
        f"Found {len(sorted_small_categories)} categories with fewer than 4 items "
        f"(excluding 'Starts with' and 'Ends with'):"
    )
    print("=" * 80)

    for category, words in sorted_small_categories:
        print(f"{category} ({len(words)} items): " f"{', '.join(words)}")

    # Save to thin_categories.json
    thin_categories = {}
    for category, words in sorted_small_categories:
        thin_categories[category] = words

    with open("data/thin_categories.json", "w") as f:
        json.dump(thin_categories, f, indent=2)

    print(
        f"\nSaved {len(thin_categories)} thin categories to data/thin_categories.json"
    )

    # Summary statistics
    total_categories = len(
        [
            c
            for c in categories.keys()
            if not c.startswith("Starts with") and not c.startswith("Ends with")
        ]
    )
    usable_categories = len(
        [
            w
            for w in categories.values()
            if len(w) >= 4
            and not any(
                c.startswith("Starts with") or c.startswith("Ends with")
                for c in categories.keys()
            )
        ]
    )

    print("\n" + "=" * 80)
    print("Summary (excluding 'Starts with' and 'Ends with'):")
    print(f"Total categories: {total_categories}")
    print(f"Categories with 4+ items (usable): {usable_categories}")
    print(f"Categories with <4 items (need expansion): {len(sorted_small_categories)}")
    print(f"Usable percentage: {usable_categories/total_categories*100:.1f}%")


if __name__ == "__main__":
    analyze_categories()
