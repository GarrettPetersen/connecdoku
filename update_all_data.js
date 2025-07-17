const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Updating all data files...');

// Step 1: Add word patterns (from add_word_patterns.js)
console.log('1. Adding word patterns...');
const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8'));

let updatedCount = 0;
let totalWords = 0;

for (const [word, categories] of Object.entries(wordsData)) {
    totalWords++;

    // Only process words with 3 or more letters
    if (word.length >= 3) {
        const startsWith = `Starts with ${word.substring(0, 3).toUpperCase()}`;
        const endsWith = `Ends with ${word.substring(word.length - 3).toUpperCase()}`;

        let updated = false;
        const newCategories = [...categories];

        // Add "Starts with" category if not already present
        if (!categories.includes(startsWith)) {
            newCategories.push(startsWith);
            updated = true;
        }

        // Add "Ends with" category if not already present
        if (!categories.includes(endsWith)) {
            newCategories.push(endsWith);
            updated = true;
        }

        // Update the word's categories if changes were made
        if (updated) {
            wordsData[word] = newCategories.sort();
            updatedCount++;
        }
    }
}

// Write the updated data back to the file
fs.writeFileSync(path.join(__dirname, 'data', 'words.json'), JSON.stringify(wordsData, null, 2), 'utf8');

// Step 2: Generate categories (from generate_categories.js)
console.log('2. Generating categories...');
const categoriesToWords = {};

// Iterate through each word and its categories
for (const [word, categories] of Object.entries(wordsData)) {
    // For each category of this word
    for (const category of categories) {
        // Initialize the category array if it doesn't exist
        if (!categoriesToWords[category]) {
            categoriesToWords[category] = [];
        }
        // Add the word to this category
        categoriesToWords[category].push(word);
    }
}

// Sort categories alphabetically and words within each category
const sortedCategories = {};
Object.keys(categoriesToWords)
    .sort()
    .forEach(category => {
        sortedCategories[category] = categoriesToWords[category].sort();
    });

// Write the categories.json file
const outputPath = path.join(__dirname, 'data', 'categories.json');
fs.writeFileSync(outputPath, JSON.stringify(sortedCategories, null, 2), 'utf8');

// Step 3: Extract words and categories (from extract_words_and_categories.js)
console.log('3. Extracting words and categories...');

// Extract all words
const words = Object.keys(wordsData);

// Extract all categories, excluding "starts with" and "ends with" categories
const categoriesSet = new Set();
for (const wordCategories of Object.values(wordsData)) {
    for (const category of wordCategories) {
        if (!category.startsWith('Starts with ') && !category.startsWith('Ends with ')) {
            categoriesSet.add(category);
        }
    }
}

// Convert to sorted arrays
const sortedWords = words.sort();
const sortedCategoriesList = Array.from(categoriesSet).sort();

// Write words to file
fs.writeFileSync('words_list.txt', sortedWords.join('\n'));

// Write categories to file
fs.writeFileSync('categories_list.txt', sortedCategoriesList.join('\n'));

// Also write as JSON arrays
fs.writeFileSync('words_list.json', JSON.stringify(sortedWords, null, 2));
fs.writeFileSync('categories_list.json', JSON.stringify(sortedCategoriesList, null, 2));

// Step 4: Analyze categories (from analyze_categories.py)
console.log('4. Analyzing categories...');

// Create a reverse mapping: category -> list of words
const categories = {};
for (const [word, wordCategories] of Object.entries(wordsData)) {
    for (const category of wordCategories) {
        if (!categories[category]) {
            categories[category] = [];
        }
        categories[category].push(word);
    }
}

// Find categories with fewer than 4 items, excluding "Starts with" and "Ends with"
const smallCategories = {};
for (const [category, words] of Object.entries(categories)) {
    if (
        words.length < 4
        && !category.startsWith("Starts with")
        && !category.startsWith("Ends with")
    ) {
        smallCategories[category] = words;
    }
}

// Sort by number of items (ascending)
const sortedSmallCategories = Object.entries(smallCategories).sort((a, b) => a[1].length - b[1].length);

// Save to thin_categories.json
const thinCategories = {};
for (const [category, words] of sortedSmallCategories) {
    thinCategories[category] = words;
}

fs.writeFileSync(path.join(__dirname, 'data', 'thin_categories.json'), JSON.stringify(thinCategories, null, 2));

console.log('All data files updated successfully!');
console.log(`- Updated ${updatedCount} words with patterns`);
console.log(`- Generated ${Object.keys(sortedCategories).length} categories`);
console.log(`- Extracted ${sortedWords.length} words and ${sortedCategoriesList.length} categories`);
console.log(`- Found ${Object.keys(thinCategories).length} thin categories`); 