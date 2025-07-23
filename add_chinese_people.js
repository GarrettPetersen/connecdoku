import fs from 'fs';

// Read the words.json file
const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

// Define Chinese historical figures and their categories
const chinesePeople = {
    "Guan Yu": [
        "Ancient Figures",
        "Ends with  YU",
        "Historical Figures",
        "Military Leaders",
        "People",
        "Real People",
        "Religious Figures",
        "Starts with GUA",
        "Things Chinese"
    ],
    "Confucius": [
        "Ancient Figures",
        "Ends with IUS",
        "Historical Figures",
        "People",
        "Philosophers",
        "Real People",
        "Religious Figures",
        "Starts with CON",
        "Things Chinese",
        "Writers"
    ],
    "Sun Tzu": [
        "Ancient Figures",
        "Ends with  TZU",
        "Historical Figures",
        "Military Leaders",
        "People",
        "Real People",
        "Starts with SUN",
        "Things Chinese",
        "Writers"
    ],
    "Emperor Qin Shi Huang": [
        "Ancient Figures",
        "Ancient Rulers",
        "Ends with ANG",
        "Historical Figures",
        "Military Leaders",
        "Modern Rulers",
        "People",
        "Real People",
        "Starts with EMP",
        "Things Chinese"
    ],
    "Emperor Wu of Han": [
        "Ancient Figures",
        "Ancient Rulers",
        "Ends with  HAN",
        "Historical Figures",
        "Military Leaders",
        "Modern Rulers",
        "People",
        "Real People",
        "Starts with EMP",
        "Things Chinese"
    ],
    "Li Bai": [
        "Ends with  BAI",
        "Historical Figures",
        "Medieval Figures",
        "People",
        "Poets",
        "Real People",
        "Starts with LI ",
        "Things Chinese",
        "Writers"
    ],
    "Du Fu": [
        "Ends with   FU",
        "Historical Figures",
        "Medieval Figures",
        "People",
        "Poets",
        "Real People",
        "Starts with DU ",
        "Things Chinese",
        "Writers"
    ],
    "Zhu Yuanzhang": [
        "Ends with ZHANG",
        "Historical Figures",
        "Medieval Figures",
        "Medieval Rulers",
        "Military Leaders",
        "Modern Rulers",
        "People",
        "Real People",
        "Starts with ZHU",
        "Things Chinese"
    ],
    "Zheng He": [
        "Ends with  HE",
        "Explorers",
        "Historical Figures",
        "Medieval Figures",
        "People",
        "Real People",
        "Sailors",
        "Starts with ZHE",
        "Things Chinese"
    ]
};

// Add the new Chinese people
let addedCount = 0;
for (const [name, categories] of Object.entries(chinesePeople)) {
    if (!wordsData[name]) {
        wordsData[name] = categories;
        console.log(`Added ${name}: ${categories.join(', ')}`);
        addedCount++;
    } else {
        console.log(`Warning: ${name} already exists in words.json`);
    }
}

// Write the updated data back to the file
fs.writeFileSync('data/words.json', JSON.stringify(wordsData, null, 2));

console.log(`\nAdded ${addedCount} Chinese historical figures.`);
console.log('Chinese historical figures have been added with appropriate category tags.'); 