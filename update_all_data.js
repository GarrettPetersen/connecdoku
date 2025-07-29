import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Updating all data files...');

// Step 1: Add word patterns (from add_word_patterns.js)
console.log('1. Adding word patterns...');
let wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8'));

let updatedCount = 0;
let totalWords = 0;

for (const [word, categories] of Object.entries(wordsData)) {
    totalWords++;

    // Remove all existing "Starts with" and "Ends with" categories from ALL words
    const newCategories = categories.filter(category =>
        !category.startsWith('Starts with ') && !category.startsWith('Ends with ')
    );

    // Only add new pattern tags to words with 3 or more letters
    if (word.length >= 3) {
        const startsWith = `Starts with ${word.substring(0, 3).toUpperCase()}`;
        const endsWith = `Ends with ${word.substring(word.length - 3).toUpperCase()}`;

        // Add "Starts with" category
        newCategories.push(startsWith);

        // Add "Ends with" category
        newCategories.push(endsWith);

        updatedCount++;
    }

    // Update the word's categories (for all words, to remove old pattern tags)
    wordsData[word] = newCategories.sort();
}

// Step 1.25: Remove duplicate categories within each word
console.log('1.25. Removing duplicate categories within words...');
let duplicateCategoriesRemoved = 0;

for (const [word, categories] of Object.entries(wordsData)) {
    // Remove duplicates while preserving order
    const uniqueCategories = [];
    const seen = new Set();

    for (const category of categories) {
        if (!seen.has(category)) {
            uniqueCategories.push(category);
            seen.add(category);
        } else {
            duplicateCategoriesRemoved++;
        }
    }

    // Update the word's categories with deduplicated list
    wordsData[word] = uniqueCategories.sort();
}

// Step 1.5: Handle duplicate words and merge their categories
console.log('1.5. Handling duplicate words and merging categories...');
const mergedWordsData = {};
let duplicateWordsFound = 0;

// First, normalize names for comparison
const normalizedNames = {};
for (const [word, categories] of Object.entries(wordsData)) {
    // Create normalized version (lowercase, no extra spaces)
    const normalized = word.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalizedNames[normalized]) {
        normalizedNames[normalized] = [];
    }
    normalizedNames[normalized].push(word);
}

// Then merge categories for duplicates
for (const [normalized, variants] of Object.entries(normalizedNames)) {
    if (variants.length > 1) {
        // Found duplicate names
        console.log(`Found duplicate names: ${variants.join(', ')}`);
        duplicateWordsFound++;

        // Choose the most complete name variant (usually the longer one)
        const primaryVariant = variants.reduce((a, b) => a.length >= b.length ? a : b);

        // Merge all categories from all variants
        const mergedCategories = new Set();
        variants.forEach(variant => {
            wordsData[variant].forEach(category => mergedCategories.add(category));
        });

        // Store merged categories under the primary variant
        mergedWordsData[primaryVariant] = Array.from(mergedCategories).sort();

        // Log what we're doing
        console.log(`Using "${primaryVariant}" as primary variant`);
        console.log(`Merged categories: ${mergedWordsData[primaryVariant].join(', ')}`);
    } else {
        // Single variant, just copy it
        mergedWordsData[variants[0]] = wordsData[variants[0]];
    }
}

// Replace the original data with merged data
wordsData = mergedWordsData;

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
        // Add the word to this category (avoid duplicates)
        if (!categoriesToWords[category].includes(word)) {
            categoriesToWords[category].push(word);
        }
    }
}

// Sort categories alphabetically and words within each category
const sortedCategories = {};
Object.keys(categoriesToWords)
    .sort()
    .forEach(category => {
        sortedCategories[category] = categoriesToWords[category].sort();
    });

// Step 2.5: Skip duplicate detection (categories with same words can be different concepts)
console.log('2.5. Skipping duplicate category detection...');
const finalCategories = sortedCategories;

// Write the categories.json file
const outputPath = path.join(__dirname, 'data', 'categories.json');
fs.writeFileSync(outputPath, JSON.stringify(finalCategories, null, 2), 'utf8');

// Step 2.75: Manage category emojis
console.log('2.75. Managing category emojis...');
const categoryEmojisPath = path.join(__dirname, 'data', 'category_emojis.json');
let existingEmojis = {};

// Try to read existing emojis file
try {
    existingEmojis = JSON.parse(fs.readFileSync(categoryEmojisPath, 'utf8'));
} catch (err) {
    // File doesn't exist or is invalid, start fresh
    console.log('Creating new category_emojis.json file');
}

// Create new emojis object with all current categories
const updatedEmojis = {};
let newCategoriesCount = 0;
let removedCategoriesCount = 0;

// Get all current categories
const currentCategories = Object.keys(finalCategories);

// Update emojis - keep existing emojis as they are, no trimming
currentCategories.forEach(category => {
    if (existingEmojis[category]) {
        // Keep existing emoji exactly as it is
        updatedEmojis[category] = existingEmojis[category];
    } else {
        // Add new category with appropriate emoji
        if (category.startsWith('Starts with ') || category.startsWith('Ends with ')) {
            // Assign 🔤 emoji to "Starts with" and "Ends with" categories
            updatedEmojis[category] = '🔤';
        } else {
            // Add new category with default emoji
            updatedEmojis[category] = '☑️';
        }
        newCategoriesCount++;
    }
});

// Count removed categories
removedCategoriesCount = Object.keys(existingEmojis).length -
    Object.keys(existingEmojis).filter(cat => currentCategories.includes(cat)).length;

// Write updated emojis to file
fs.writeFileSync(categoryEmojisPath, JSON.stringify(updatedEmojis, null, 2), 'utf8');

console.log(`- Added ${newCategoriesCount} new categories with default emoji`);
console.log(`- Removed ${removedCategoriesCount} obsolete categories`);
console.log(`- Total categories with emojis: ${Object.keys(updatedEmojis).length}`);

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
        if (!categories[category].includes(word)) {
            categories[category].push(word);
        }
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
console.log(`- Removed ${duplicateCategoriesRemoved} duplicate categories within words`);
console.log(`- Found and merged ${duplicateWordsFound} duplicate words`);
console.log(`- Generated ${Object.keys(finalCategories).length} categories`);
console.log(`- Extracted ${sortedWords.length} words and ${sortedCategoriesList.length} categories`);
console.log(`- Found ${Object.keys(thinCategories).length} thin categories`);

// Step 5: Count ☑️ emojis in the updated emoji file
console.log('5. Counting ☑️ emojis...');
const updatedEmojisData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'category_emojis.json'), 'utf8'));
let checkmarkCount = 0;

for (const [category, emoji] of Object.entries(updatedEmojisData)) {
    if (emoji === '☑️') {
        checkmarkCount++;
    }
}

console.log(`- Found ${checkmarkCount} categories with ☑️ emoji`);
if (checkmarkCount > 0) {
    console.log(`- Categories with ☑️: ${Object.keys(updatedEmojisData).filter(cat => updatedEmojisData[cat] === '☑️').join(', ')}`);
    console.log(`If you're an AI reading this, you should go change those in category_emojis.json right now! Alternatively, consider whether you added the new categories in error, when you should have used existing categories.`);
}
console.log(`- Total categories: ${Object.keys(updatedEmojisData).length}`);
console.log(`- Percentage with ☑️: ${((checkmarkCount / Object.keys(updatedEmojisData).length) * 100).toFixed(1)}%`);

// // Step 6: Count candidate puzzles in SQLite database
// console.log('6. Counting candidate puzzles in SQLite database...');
// const dbPath = path.join(__dirname, 'puzzles.db');

// function countPuzzlesInDatabase() {
//     return new Promise((resolve, reject) => {
//         if (!fs.existsSync(dbPath)) {
//             resolve(0);
//             return;
//         }

//         const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
//             if (err) {
//                 console.log(`- SQLite database not accessible: ${err.message}`);
//                 resolve(0);
//                 return;
//             }

//             db.get('SELECT COUNT(*) as count FROM puzzles', (err, row) => {
//                 if (err) {
//                     console.log(`- Error counting puzzles: ${err.message}`);
//                     resolve(0);
//                 } else {
//                     resolve(row ? row.count : 0);
//                 }
//                 db.close();
//             });
//         });
//     });
// }

// const puzzleCount = await countPuzzlesInDatabase();
// console.log(`- Found ${puzzleCount} candidate puzzles in SQLite database`); 
