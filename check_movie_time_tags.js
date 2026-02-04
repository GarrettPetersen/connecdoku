import fs from 'fs';

const words = JSON.parse(fs.readFileSync('./data/words.json', 'utf8'));

const decadeRegex = /^\d{3}0s$/;
const yearRegex = /^\d{4}$/;

const missingDecade = [];
const missingYear = [];
const missingBoth = [];

for (const [word, tags] of Object.entries(words)) {
    // Check if this is a movie
    const isMovie = tags.includes('Movies');
    
    if (!isMovie) continue;

    const decades = tags.filter(t => decadeRegex.test(t));
    const years = tags.filter(t => yearRegex.test(t));

    const hasDecade = decades.length > 0;
    const hasYear = years.length > 0;

    if (!hasDecade && !hasYear) {
        missingBoth.push({word, tags: tags.filter(t => t.includes('Century') || decadeRegex.test(t) || yearRegex.test(t))});
    } else if (!hasDecade) {
        missingDecade.push({word, year: years[0]});
    } else if (!hasYear) {
        missingYear.push({word, decade: decades[0]});
    }
}

console.log(`\n=== Movie Time Tag Check ===\n`);
console.log(`Total movies found: ${Object.entries(words).filter(([w, t]) => t.includes('Movies')).length}`);
console.log(`Movies missing both year and decade: ${missingBoth.length}`);
console.log(`Movies missing decade tag: ${missingDecade.length}`);
console.log(`Movies missing year tag: ${missingYear.length}`);

if (missingBoth.length > 0) {
    console.log("\n--- Movies Missing Both Year and Decade ---");
    missingBoth.forEach(i => console.log(`${i.word} (has: ${i.tags.join(', ') || 'none'})`));
}

if (missingDecade.length > 0) {
    console.log("\n--- Movies Missing Decade Tag ---");
    missingDecade.forEach(i => console.log(`${i.word} (year: ${i.year})`));
}

if (missingYear.length > 0) {
    console.log("\n--- Movies Missing Year Tag ---");
    missingYear.forEach(i => console.log(`${i.word} (decade: ${i.decade})`));
}

// Export for potential fixing
if (missingBoth.length > 0 || missingDecade.length > 0 || missingYear.length > 0) {
    console.log("\n=== Summary ===");
    console.log(`Total movies needing fixes: ${missingBoth.length + missingDecade.length + missingYear.length}`);
}

