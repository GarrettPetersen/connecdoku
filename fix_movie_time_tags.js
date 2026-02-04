import fs from 'fs';

const words = JSON.parse(fs.readFileSync('./data/words.json', 'utf8'));

const decadeRegex = /^\d{3}0s$/;
const yearRegex = /^\d{4}$/;

// Well-known movie release years - we can add these
const movieYears = {
    // Movies missing both
    "101 Dalmatians": "1961",
    "A Charlie Brown Christmas": "1965",
    "Alice in Wonderland": "1951",
    "Arthur Christmas": "2011",
    "Atlantis": "2001",
    "Bambi": "1942",
    "Beauty and the Beast": "1991",
    "Big Hero 6": "2014",
    "Bolt": "2008",
    "Brave": "2012",
    "Brother Bear": "2003",
    "Cars": "2006",
    "Chicken Little": "2005",
    "Coco": "2017",
    "Dumbo": "1941",
    "Elemental": "2023",
    "Encanto": "2021",
    "Fantasia": "1940",
    "Fantasia 2000": "1999",
    "Finding Nemo": "2003",
    "Four Christmases": "2008",
    "From Up on Poppy Hill": "2011",
    "Frozen": "2013",
    "Hercules": "1997",
    "Holes": "2003",
    "Home on the Range": "2004",
    "How the Grinch Stole Christmas": "2000",
    "Howl's Moving Castle": "2004",
    "Inside Out": "2015",
    "Kate & Leopold": "2001",
    "Lady and the Tramp": "1955",
    "Lilo & Stitch": "2002",
    "Live Free or Die Hard": "2007",
    "Luca": "2021",
    "Meet the Robinsons": "2007",
    "Monsters Inc": "2001",
    "Monsters University": "2013",
    "Mulan": "1998",
    "Oliver & Company": "1988",
    "Only Yesterday": "1991",
    "Pocahontas": "1995",
    "Pom Poko": "1994",
    "Ponyo": "2008",
    "Ratatouille": "2007",
    "Raya and the Last Dragon": "2021",
    "Red Dragon": "2002",
    "Rise of the Guardians": "2012",
    "Robin Hood": "1973",
    "Snow White and the Seven Dwarfs": "1937",
    "Soul": "2020",
    "Strange World": "2022",
    "Tales from Earthsea": "2006",
    "Tangled": "2010",
    "Tarzan": "1999",
    "The Aristocats": "1970",
    "The Black Cauldron": "1985",
    "The Cat Returns": "2002",
    "The Emperor's New Groove": "2000",
    "The Great Mouse Detective": "1986",
    "The Grinch": "2018",
    "The Hunchback of Notre Dame": "1996",
    "The Incredibles": "2004",
    "The Lion King": "1994",
    "The Little Mermaid": "1989",
    "The Many Adventures of Winnie the Pooh": "1977",
    "The Princess and the Frog": "2009",
    "The Rescuers": "1977",
    "The Rescuers Down Under": "1990",
    "The Sword in the Stone": "1963",
    "The Tale of the Princess Kaguya": "2013",
    "The Wind Rises": "2013",
    "Toy Story": "1995",
    "Treasure Planet": "2002",
    "Turning Red": "2022",
    "Up": "2009",
    "Vantage Point": "2008",
    "WALL-E": "2008",
    "When Marnie Was There": "2014",
    "Whisper of the Heart": "1995",
    "Winnie the Pooh": "2011",
    "Wish": "2023",
    "Wreck-It Ralph": "2012",
    "Zootopia": "2016",
    
    // Movies with decade but missing year - well-known ones
    "2001: A Space Odyssey": "1968",
    "A Clockwork Orange": "1971",
    "Alien": "1979",
    "Annie Hall": "1977",
    "Apollo 13": "1995",
    "Ben-Hur": "1959",
    "Bridge on the River Kwai": "1957",
    "Brief Encounter": "1945",
    "Cabaret": "1972",
    "Carrie": "1976",
    "Casablanca": "1942",
    "Chinatown": "1974",
    "Cinderella": "1950",
    "Citizen Kane": "1941",
    "Cleopatra": "1963",
    "Daredevil": "2003",
    "Death Wish": "1974",
    "Dog Day Afternoon": "1975",
    "Don't Look Now": "1973",
    "Dr. Strangelove": "1964",
    "Easy Rider": "1969",
    "Everest": "2015",
    "Fiddler on the Roof": "1971",
    "Get Carter": "1971",
    "Godspell": "1973",
    "Gone with the Wind": "1939",
    "Grease": "1978",
    "High and Low": "1963",
    "If....": "1968",
    "Ikiru": "1952",
    "It's a Wonderful Life": "1946",
    "Jaws": "1975",
    "Jesus Christ Superstar": "1973",
    "Kind Hearts and Coronets": "1949",
    "King Kong": "1933",
    "Kramer vs. Kramer": "1979",
    "Lawrence of Arabia": "1962",
    "Manhattan": "1979",
    "Mary Poppins": "1964",
    "Metropolis": "1927",
    "Midnight Cowboy": "1969",
    "Miracle on 34th Street": "1947",
    "My Fair Lady": "1964",
    "O Lucky Man!": "1973",
    "Oliver!": "1968",
    "One Flew Over the Cuckoo's Nest": "1975",
    "Performance": "1970",
    "Peyton Place": "1957",
    "Poseidon": "2006",
    "Psycho": "1960",
    "Rashomon": "1950",
    "Rear Window": "1954",
    "Red Beard": "1965",
    "Rock Around the Clock": "1956",
    "Rocky": "1976",
    "Rocky Horror Picture Show": "1975",
    "Sanjuro": "1962",
    "Serpico": "1973",
    "Seven Samurai": "1954",
    "Singin' in the Rain": "1952",
    "Sleeping Beauty": "1959",
    "South Pacific": "1958",
    "Spartacus": "1960",
    "Star Wars": "1977",
    "Superman": "1978",
    "The Big Sleep": "1946",
    "The Dam Busters": "1955",
    "The Deer Hunter": "1978",
    "The Exorcist": "1973",
    "The French Connection": "1971",
    "The Godfather": "1972",
    "The Godfather Part II": "1974",
    "The Good, the Bad and the Ugly": "1966",
    "The Graduate": "1967",
    "The Grapes of Wrath": "1940",
    "The Great Gatsby": "1974",
    "The Hidden Fortress": "1958",
    "The Italian Job": "1969",
    "The King and I": "1956",
    "The Ladykillers": "1955",
    "The Magnificent Seven": "1960",
    "The Maltese Falcon": "1941",
    "The Man Who Fell to Earth": "1976",
    "The Red Shoes": "1948",
    "The Searchers": "1956",
    "The Sound of Music": "1965",
    "The Third Man": "1949",
    "The Three Little Pigs": "1933",
    "The Wicker Man": "1973",
    "The Wizard of Oz": "1939",
    "Throne of Blood": "1957",
    "To Kill a Mockingbird": "1962",
    "Triumph of the Will": "1935",
    "Walkabout": "1971",
    "West Side Story": "1961",
    "White Christmas": "1954",
    "Yojimbo": "1961",
    "Zulu": "1964",
    
    // Remaining movies with specific versions
    "2046": "2004",  // Wong Kar-wai
    "Beethoven": "1992",  // Brian Levant
    "Oscar": "1991",  // John Landis
    "Pompeii": "2014",  // Paul W.S. Anderson
    "Dracula": "1931",  // Tod Browning with Bela Lugosi
    "Frankenstein": "1931",  // James Whale with Boris Karloff
    "Jane Eyre": "2011",  // Cary Fukunaga
    "Krakatoa": "1969",  // Bernard L. Kowalski
    "Little Women": "2019",  // Greta Gerwig
    "Moby Dick": "1956",  // John Huston version
    "Peter Pan": "1953",  // Disney version (has 1950s tag)
    "Pinocchio": "1940",  // Disney version (has 1940s tag)
    "Pride and Prejudice": "2005",  // Joe Wright
    "The Jungle Book": "1967",  // Disney version (has 1960s tag)
    "The Secret Garden": "1993",  // Agnieszka Holland
    "Waterloo": "1970",  // Sergei Bondarchuk (has 1970s tag)
    "Wuthering Heights": "2011",  // Andrea Arnold
};

let changed = 0;

for (const [word, tags] of Object.entries(words)) {
    if (!tags.includes('Movies')) continue;
    
    const decades = tags.filter(t => decadeRegex.test(t));
    const years = tags.filter(t => yearRegex.test(t));
    const hasDecade = decades.length > 0;
    const hasYear = years.length > 0;
    
    let entryChanged = false;
    const newTags = [...tags];
    
    // If we have a known year for this movie, add it
    if (movieYears[word] && !hasYear) {
        if (!newTags.includes(movieYears[word])) {
            newTags.push(movieYears[word]);
            entryChanged = true;
        }
    }
    
    // If we have a year but no decade, add the decade
    if (hasYear && !hasDecade) {
        const year = years[0];
        const decade = `${year.substring(0, 3)}0s`;
        if (!newTags.includes(decade)) {
            newTags.push(decade);
            entryChanged = true;
        }
    }
    
    // If we have a decade but no year, and we just added a year, add the decade from that year
    if (entryChanged && movieYears[word]) {
        const year = movieYears[word];
        const decade = `${year.substring(0, 3)}0s`;
        if (!newTags.includes(decade)) {
            newTags.push(decade);
        }
    }
    
    if (entryChanged) {
        newTags.sort();
        words[word] = newTags;
        changed++;
    }
}

if (changed > 0) {
    fs.writeFileSync('./data/words.json', JSON.stringify(words, null, 2));
    console.log(`Updated ${changed} movie entries with time tags.`);
} else {
    console.log("No changes needed.");
}

