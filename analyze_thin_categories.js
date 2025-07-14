const fs = require('fs');

// Load the data
const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));
const thinCategories = JSON.parse(fs.readFileSync('data/thin_categories.json', 'utf8'));
const allWords = Object.keys(wordsData);

console.log('Analyzing thin categories for existing words that would fit:\n');

// Check each thin category
for (const [category, existingWords] of Object.entries(thinCategories)) {
    console.log(`\n${category}:`);
    console.log(`  Currently has: ${existingWords.join(', ')}`);

    // Find words that could fit this category
    const potentialFits = [];

    for (const word of allWords) {
        const wordCategories = wordsData[word];

        // Skip if word is already in this thin category
        if (existingWords.includes(word)) {
            continue;
        }

        // Check if word has categories that might relate to this thin category
        let fits = false;

        switch (category) {
            case 'Sun':
                if (wordCategories.includes('Astronomical Objects') ||
                    wordCategories.includes('Star') ||
                    word.toLowerCase().includes('sun')) {
                    fits = true;
                }
                break;

            case 'Psychology Terms':
                if (wordCategories.includes('Psychology Terms')) {
                    fits = true;
                }
                break;

            case 'Wars':
                if (wordCategories.includes('Wars') ||
                    wordCategories.includes('Trojan War')) {
                    fits = true;
                }
                break;

            case 'Cars':
                if (wordCategories.includes('Car Brands') ||
                    wordCategories.includes('Cars')) {
                    fits = true;
                }
                break;

            case 'Crimes':
                if (wordCategories.includes('Crimes') ||
                    wordCategories.includes('Criminals')) {
                    fits = true;
                }
                break;

            case 'Sports Terms':
                if (wordCategories.includes('Sports Terms') ||
                    wordCategories.includes('Sports') ||
                    wordCategories.includes('Sports Equipment')) {
                    fits = true;
                }
                break;

            case 'Spanish Words':
                if (wordCategories.includes('Spanish Words') ||
                    wordCategories.includes('Spanish Ships')) {
                    fits = true;
                }
                break;

            case 'Books':
                if (wordCategories.includes('Books')) {
                    fits = true;
                }
                break;

            case 'Ninja Terms':
                if (wordCategories.includes('Ninja Terms')) {
                    fits = true;
                }
                break;

            case 'Pirate Terms':
                if (wordCategories.includes('Pirate Terms')) {
                    fits = true;
                }
                break;

            case 'Martial Arts':
                if (wordCategories.includes('Martial Arts')) {
                    fits = true;
                }
                break;

            case 'Alliances':
                if (wordCategories.includes('Alliances')) {
                    fits = true;
                }
                break;

            case 'Games':
                if (wordCategories.includes('Games') ||
                    wordCategories.includes('Board Games') ||
                    wordCategories.includes('Card Games')) {
                    fits = true;
                }
                break;

            case 'Dinosaurs':
                if (wordCategories.includes('Dinosaurs')) {
                    fits = true;
                }
                break;

            case 'Star':
                if (wordCategories.includes('Star') ||
                    wordCategories.includes('Astronomical Objects')) {
                    fits = true;
                }
                break;

            case 'Bear':
                if (wordCategories.includes('Bear')) {
                    fits = true;
                }
                break;

            case 'Religious Titles':
                if (wordCategories.includes('Religious Titles')) {
                    fits = true;
                }
                break;

            case 'Sports':
                if (wordCategories.includes('Sports')) {
                    fits = true;
                }
                break;

            case 'Cities in South America':
                if (wordCategories.includes('Cities in South America')) {
                    fits = true;
                }
                break;

            case 'Clothing':
                if (wordCategories.includes('Clothing')) {
                    fits = true;
                }
                break;

            case 'Royalty':
                if (wordCategories.includes('Royalty') ||
                    wordCategories.includes('Monarchs') ||
                    wordCategories.includes('Queens') ||
                    wordCategories.includes('Kings')) {
                    fits = true;
                }
                break;

            case 'Biology':
                if (wordCategories.includes('Biology')) {
                    fits = true;
                }
                break;

            case 'Language':
                if (wordCategories.includes('Language')) {
                    fits = true;
                }
                break;

            case 'Pink Panther Characters':
                if (wordCategories.includes('Pink Panther Characters')) {
                    fits = true;
                }
                break;

            case 'Rooms':
                if (wordCategories.includes('Rooms')) {
                    fits = true;
                }
                break;

            case 'MLB Teams':
                if (wordCategories.includes('MLB Teams')) {
                    fits = true;
                }
                break;

            case 'USA':
                if (wordCategories.includes('USA')) {
                    fits = true;
                }
                break;

            case 'Arctic Animals':
                if (wordCategories.includes('Arctic Animals')) {
                    fits = true;
                }
                break;

            case 'Criminals':
                if (wordCategories.includes('Criminals')) {
                    fits = true;
                }
                break;

            case 'Silver Things':
                if (wordCategories.includes('Silver Things')) {
                    fits = true;
                }
                break;

            case 'Astronomers':
                if (wordCategories.includes('Astronomers')) {
                    fits = true;
                }
                break;

            case 'Rhythm':
                if (wordCategories.includes('Rhythm')) {
                    fits = true;
                }
                break;

            case 'Pronouns':
                if (wordCategories.includes('Pronouns')) {
                    fits = true;
                }
                break;

            case 'Coffee':
                if (wordCategories.includes('Coffee')) {
                    fits = true;
                }
                break;

            case 'Norse Gods':
                if (wordCategories.includes('Norse Gods')) {
                    fits = true;
                }
                break;

            case 'Organizations':
                if (wordCategories.includes('Organizations')) {
                    fits = true;
                }
                break;

            case 'Dances':
                if (wordCategories.includes('Dances')) {
                    fits = true;
                }
                break;

            case 'Drinks':
                if (wordCategories.includes('Drinks')) {
                    fits = true;
                }
                break;

            case 'Comedians':
                if (wordCategories.includes('Comedians')) {
                    fits = true;
                }
                break;

            case 'National Leaders':
                if (wordCategories.includes('National Leaders')) {
                    fits = true;
                }
                break;

            case 'Fable Characters':
                if (wordCategories.includes('Fable Characters')) {
                    fits = true;
                }
                break;

            case 'Norse Mythology':
                if (wordCategories.includes('Norse Mythology')) {
                    fits = true;
                }
                break;

            case 'Philosophical Concepts':
                if (wordCategories.includes('Philosophical Concepts')) {
                    fits = true;
                }
                break;

            case 'Manga':
                if (wordCategories.includes('Manga')) {
                    fits = true;
                }
                break;

            case 'Religious Sites':
                if (wordCategories.includes('Religious Sites')) {
                    fits = true;
                }
                break;

            case 'Math Terms':
                if (wordCategories.includes('Math Terms')) {
                    fits = true;
                }
                break;

            case 'Gemstones':
                if (wordCategories.includes('Gemstones')) {
                    fits = true;
                }
                break;

            case 'Spiders':
                if (wordCategories.includes('Spiders')) {
                    fits = true;
                }
                break;
        }

        if (fits) {
            potentialFits.push(word);
        }
    }

    if (potentialFits.length > 0) {
        console.log(`  Potential additions: ${potentialFits.join(', ')}`);
    } else {
        console.log(`  No additional words found`);
    }
} 