/**
 * Adds umbrella category "Amphibious" to all Amphibious Operations lemmas,
 * plus new amphibious animals and amphibious-capable military vehicles.
 * Run: node scripts/add_amphibious_category.mjs && node update_all_data.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wordsPath = path.join(__dirname, "..", "data", "words.json");

const AMP = "Amphibious";
const AMP_OPS = "Amphibious Operations";

const words = JSON.parse(fs.readFileSync(wordsPath, "utf8"));

let opsTagged = 0;
for (const [lemma, cats] of Object.entries(words)) {
  if (!cats.includes(AMP_OPS)) continue;
  if (cats.includes(AMP)) continue;
  const next = [...cats, AMP].sort();
  words[lemma] = next;
  opsTagged++;
}

/** Geologic tags matching other small vertebrates (see Rabbit, Cat) */
const vertebrateEras = [
  "Cenozoic Era",
  "Currently Living Animals",
  "Holocene Epoch",
  "Miocene Epoch",
  "Neogene Period",
  "Paleogene Period",
  "Pleistocene Epoch",
  "Pliocene Epoch",
  "Quaternary Period",
];

const amphibianBase = [
  "Amphibious",
  "Animal Species",
  "Animal Terms",
  "Carnivores",
  ...vertebrateEras,
  "Real Animals",
];

const newLemmas = {
  Axolotl: [...amphibianBase, "Things Mexican"],
  Caecilian: [...amphibianBase],
  Frog: [...amphibianBase],
  Hellbender: [...amphibianBase, "Things American"],
  Mudskipper: [
    "Amphibious",
    "Animal Species",
    "Animal Terms",
    "Carnivores",
    "Cenozoic Era",
    "Currently Living Animals",
    "Fish",
    "Holocene Epoch",
    "Miocene Epoch",
    "Neogene Period",
    "Ocean Animals",
    "Paleogene Period",
    "Pleistocene Epoch",
    "Pliocene Epoch",
    "Quaternary Period",
    "Real Animals",
  ],
  Mudpuppy: [...amphibianBase, "Things American"],
  Newt: [...amphibianBase],
  Salamander: [...amphibianBase],
  Toad: [...amphibianBase],
  "AAV-7": [
    "Amphibious",
    "1970s",
    "20th Century",
    "Military Ships",
    "Ships",
    "Things American",
    "US Navy",
    "Warships",
  ],
  "BRDM-2": [
    "Amphibious",
    "1960s",
    "20th Century",
    "Cold War",
    "Military Ships",
    "Ships",
    "Things Russian",
    "Warships",
  ],
  DUKW: [
    "Amphibious",
    "1940s",
    "20th Century",
    "Military Ships",
    "Ships",
    "Things American",
    "US Navy",
    "World War II",
  ],
  LCAC: [
    "Amphibious",
    "1980s",
    "20th Century",
    "Acronyms",
    "Military Ships",
    "Ships",
    "Things American",
    "US Navy",
    "Warships",
  ],
  "LVT-4": [
    "Amphibious",
    "1940s",
    "20th Century",
    "Military Ships",
    "Ships",
    "Things American",
    "US Navy",
    "World War II",
    "Warships",
  ],
  "PT-76": [
    "Amphibious",
    "1950s",
    "20th Century",
    "Cold War",
    "Military Ships",
    "Ships",
    "Things Russian",
    "Warships",
  ],
};

let added = 0;
let merged = 0;
for (const [lemma, cats] of Object.entries(newLemmas)) {
  if (words[lemma]) {
    const set = new Set([...words[lemma], ...cats]);
    words[lemma] = [...set].sort();
    merged++;
  } else {
    words[lemma] = [...cats].sort();
    added++;
  }
}

const sorted = Object.keys(words)
  .sort((a, b) => a.localeCompare(b))
  .reduce((o, k) => {
    o[k] = words[k];
    return o;
  }, {});

fs.writeFileSync(wordsPath, JSON.stringify(sorted, null, 2), "utf8");
console.log(`Added "${AMP}" to ${opsTagged} lemmas with "${AMP_OPS}".`);
console.log(`New lemmas: ${added}, merged into existing: ${merged}.`);
