import fs from 'fs';

// Geological time scale in MYA (Million Years Ago)
const GEOLOGICAL_TIME_SCALE = {
    // Eras
    "Paleozoic Era": { start: 541, end: 252 },
    "Mesozoic Era": { start: 252, end: 66 },
    "Cenozoic Era": { start: 66, end: 0 },

    // Periods
    "Cambrian Period": { start: 541, end: 485 },
    "Ordovician Period": { start: 485, end: 444 },
    "Silurian Period": { start: 444, end: 419 },
    "Devonian Period": { start: 419, end: 359 },
    "Carboniferous Period": { start: 359, end: 299 },
    "Permian Period": { start: 299, end: 252 },
    "Triassic Period": { start: 252, end: 201 },
    "Jurassic Period": { start: 201, end: 145 },
    "Cretaceous Period": { start: 145, end: 66 },
    "Paleogene Period": { start: 66, end: 23 },
    "Neogene Period": { start: 23, end: 2.6 },
    "Quaternary Period": { start: 2.6, end: 0 },

    // Epochs (Cenozoic)
    "Paleocene Epoch": { start: 66, end: 56 },
    "Eocene Epoch": { start: 56, end: 34 },
    "Oligocene Epoch": { start: 34, end: 23 },
    "Miocene Epoch": { start: 23, end: 5.3 },
    "Pliocene Epoch": { start: 5.3, end: 2.6 },
    "Pleistocene Epoch": { start: 2.6, end: 0.012 },
    "Holocene Epoch": { start: 0.012, end: 0 }
};

// All geological era tags currently in use (derived from the time scale)
const CURRENT_GEOLOGICAL_TAGS = Object.keys(GEOLOGICAL_TIME_SCALE);

/**
 * Determines which geological era tags should be applied based on MYA dates
 * @param {number} appearanceMYA - When the species appeared (MYA)
 * @param {number} extinctionMYA - When the species went extinct (MYA), 0 for still living
 * @returns {string[]} Array of geological era tags that should be applied
 */
function getGeologicalEraTags(appearanceMYA, extinctionMYA) {
    const tags = [];

    for (const [era, timeRange] of Object.entries(GEOLOGICAL_TIME_SCALE)) {
        // Check if the species existed during this geological time period
        // Use the same logic for all species (living and extinct)
        // Multiply by -1 to make the timeline more intuitive (larger numbers = more recent)
        const negAppearance = -appearanceMYA;
        const negExtinction = extinctionMYA === 0 ? 0 : -extinctionMYA; // 0 for living species
        const negStart = -timeRange.start;
        const negEnd = -timeRange.end;

        // A species existed during an era if there's any overlap between:
        // - Species existence: [negAppearance, negExtinction]
        // - Era: [negStart, negEnd]
        // There's overlap if: negAppearance < negEnd AND negExtinction > negStart
        // Using < and > to exclude species that went extinct exactly at period boundaries
        if (negAppearance < negEnd && negExtinction > negStart) {
            tags.push(era);
        }
    }

    return tags;
}

/**
 * Updates geological era tags for a specific word in the words.json file
 * @param {string} word - The word to update
 * @param {number} appearanceMYA - When the species appeared (MYA)
 * @param {number} extinctionMYA - When the species went extinct (MYA), 0 for still living
 */
function updateGeologicalEraTags(word, appearanceMYA, extinctionMYA) {
    try {
        // Read the words.json file
        const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

        if (!wordsData[word]) {
            console.log(`Word "${word}" not found in words.json`);
            return;
        }

        const wordTags = wordsData[word];

        // Remove all existing geological era tags
        const filteredTags = wordTags.filter(tag => !CURRENT_GEOLOGICAL_TAGS.includes(tag));

        // Add the correct geological era tags
        const correctEraTags = getGeologicalEraTags(appearanceMYA, extinctionMYA);
        const updatedTags = [...filteredTags, ...correctEraTags];

        // Update the word's tags
        wordsData[word] = updatedTags;

        // Write back to file
        fs.writeFileSync('data/words.json', JSON.stringify(wordsData, null, 2));

        console.log(`Updated "${word}":`);
        console.log(`  Appearance: ${appearanceMYA} MYA, Extinction: ${extinctionMYA === 0 ? 'Still living' : extinctionMYA + ' MYA'}`);
        console.log(`  Added tags: ${correctEraTags.join(', ')}`);
        console.log('');

    } catch (error) {
        console.error(`Error updating "${word}":`, error.message);
    }
}

/**
 * Finds all animal species and plants in the words.json file
 * @returns {string[]} Array of words that are animal species or plants
 */
function findAnimalSpeciesAndPlants() {
    try {
        const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));
        const animalSpeciesAndPlants = [];

        for (const [word, tags] of Object.entries(wordsData)) {
            if (tags.includes('Animal Species') ||
                tags.includes('Plants') ||
                tags.includes('Currently Living Plants') ||
                tags.includes('Extinct Plants') ||
                tags.includes('Carnivorous Plants')) {
                animalSpeciesAndPlants.push(word);
            }
        }

        return animalSpeciesAndPlants;
    } catch (error) {
        console.error('Error reading words.json:', error.message);
        return [];
    }
}

// Example usage and batch processing
function main() {
    console.log('Geological Era Tag Updater for Connecdoku');
    console.log('==========================================\n');

    // Find all animal species and plants
    const species = findAnimalSpeciesAndPlants();
    console.log(`Found ${species.length} animal species and plants:\n`);

    // Print them in batches for manual review
    const batchSize = 20;
    for (let i = 0; i < species.length; i += batchSize) {
        const batch = species.slice(i, i + batchSize);
        console.log(`Batch ${Math.floor(i / batchSize) + 1}:`);
        batch.forEach((word, index) => {
            console.log(`  ${i + index + 1}. ${word}`);
        });
        console.log('');
    }

    console.log('To update geological era tags, use:');
    console.log('updateGeologicalEraTags("Word Name", appearanceMYA, extinctionMYA)');
    console.log('');
    console.log('Example:');
    console.log('updateGeologicalEraTags("Tyrannosaurus", 68, 66)');
    console.log('updateGeologicalEraTags("Homo sapiens", 0.3, 0)');
    console.log('');
}

// Export functions for use in other scripts
export {
    updateGeologicalEraTags,
    findAnimalSpeciesAndPlants,
    getGeologicalEraTags,
    GEOLOGICAL_TIME_SCALE,
    CURRENT_GEOLOGICAL_TAGS
};

// Run main function if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
