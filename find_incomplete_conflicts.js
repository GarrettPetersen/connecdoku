import fs from 'fs';

const words = JSON.parse(fs.readFileSync('./data/words.json', 'utf8'));

const conflictTags = ['Military Conflicts', 'Wars', 'Battles', 'Civil Wars', 'Rebellions'];
const centuryRegex = /^\d+(st|nd|rd|th) Century( BC)?$/;
const thingsRegex = /^Things /;

const incomplete = [];

for (const [word, tags] of Object.entries(words)) {
    const isConflict = tags.some(t => conflictTags.includes(t));
    if (!isConflict) continue;

    const hasCentury = tags.some(t => centuryRegex.test(t));
    const hasNationality = tags.some(t => thingsRegex.test(t));

    if (!hasCentury || !hasNationality) {
        incomplete.push({
            word,
            missing: [
                !hasCentury ? 'Century' : null,
                !hasNationality ? 'Nationality' : null
            ].filter(Boolean)
        });
    }
}

console.log(JSON.stringify(incomplete, null, 2));

