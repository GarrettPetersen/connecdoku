import fs from 'fs';

const words = JSON.parse(fs.readFileSync('./data/words.json', 'utf8'));

const decadeRegex = /^\d{3}0s$/;
const yearRegex = /^\d{4}$/;

const relevantCenturies = ["19th Century", "20th Century", "21st Century"];
const lateDecades = ["1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

const missingDecade = [];
const missingYear = [];

for (const [word, tags] of Object.entries(words)) {
    // Focus on Events-like items
    const isEvent = tags.some(t => ['Events', 'Military Conflicts', 'Wars', 'Battles', 'Elections', 'Treaties', 'Sports Events'].includes(t));
    
    if (!isEvent) continue;

    const centuries = tags.filter(t => t.includes('Century'));
    const decades = tags.filter(t => decadeRegex.test(t));
    const years = tags.filter(t => yearRegex.test(t));

    // Check for missing decade in relevant centuries
    // Note: 18th century covers 1700-1799. "Past 250 years" is approx 1775+.
    // We'll flag 18th century ones too and manually check if they are late enough.
    const hasRelevantCentury = centuries.some(c => relevantCenturies.includes(c) || c === '18th Century');
    if (hasRelevantCentury && decades.length === 0) {
        missingDecade.push({word, centuries});
    }

    // Check for missing year since 1970s
    const isRecent = decades.some(d => lateDecades.includes(d));
    // Skip if it looks like a generic "Wars" which might be multi-year, but user said "assuming they happened in a specific year".
    // We'll flag them and decide.
    if (isRecent && years.length === 0) {
        missingYear.push({word, decades});
    }
}

console.log(`Found ${missingDecade.length} items missing decade tags.`);
console.log(`Found ${missingYear.length} items missing year tags (since 1970s).`);

console.log("\n--- Missing Decade Tags (First 50) ---");
missingDecade.slice(0, 50).forEach(i => console.log(`${i.word} (${i.centuries.join(', ')})`));

console.log("\n--- Missing Year Tags since 1970s (First 50) ---");
missingYear.slice(0, 50).forEach(i => console.log(`${i.word} (${i.decades.join(', ')})`));

