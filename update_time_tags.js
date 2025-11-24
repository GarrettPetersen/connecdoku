import fs from 'fs';

const filePath = './data/words.json';
const words = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const updates = {
    // Decades for past ~250 years
    "Gettysburg": ["1860s"],
    "The American Civil War": ["1860s"],
    "The American Revolution": ["1770s", "1780s"],
    "The Boer War": ["1890s", "1900s"],
    "The Cold War": ["1940s", "1950s", "1960s", "1970s", "1980s", "1990s"],
    "The Crimean War": ["1850s"],
    "The Franco-Prussian War": ["1870s"],
    "The French Revolution": ["1780s", "1790s"],
    "The Napoleonic Wars": ["1800s", "1810s"],
    "The Spanish-American War": ["1890s"],
    "Total War": ["2000s", "2010s", "2020s"],
    "Triple Alliance": ["1880s", "1890s", "1900s", "1910s"],

    // Specific Years since 1970s
    "Challenger": ["1986"],
    "Entebbe Hijacking": ["1976"],
    "The Chernobyl Disaster": ["1986"],
    "The Fall of the Berlin Wall": ["1989"],
    "The Great Recession": ["2008"],
    "The Rwandan Genocide": ["1994"],
    "The Watergate Scandal": ["1972"],
    "Watergate": ["1972"],
    "The Iran Hostage Crisis": ["1979"]
};

let changed = 0;

for (const [word, newTags] of Object.entries(updates)) {
    if (words[word]) {
        let entryChanged = false;
        for (const tag of newTags) {
            if (!words[word].includes(tag)) {
                words[word].push(tag);
                entryChanged = true;
            }
        }
        if (entryChanged) {
            words[word].sort();
            changed++;
        }
    } else {
        console.log(`Warning: ${word} not found in dictionary.`);
    }
}

if (changed > 0) {
    fs.writeFileSync(filePath, JSON.stringify(words, null, 2));
    console.log(`Updated ${changed} entries with time tags.`);
} else {
    console.log("No changes needed.");
}

