const GRID_SIZE = 4;
const MAX_ATTEMPTS = 3;
const PUZZLE_START_DATE = new Date('2025-07-21T00:00:00Z'); // day-zero for daily rotation

const gridEl     = document.getElementById('grid');
const submitBtn  = document.getElementById('submitBtn');
const modal      = document.getElementById('modal');
const shareTa    = document.getElementById('shareText');
const copyBtn    = document.getElementById('copyBtn');

let puzzles, puzzle, correctRows, correctCols;
let gridWords   = [];            // flattened 16-word grid (current)
let locked      = Array(16).fill(false);
let wordLockedAt= Array(16).fill(null); // attempt # when it got locked
let selectedIdx = -1;
let attempts    = 0;

/* ---------- helpers ---------- */
const shuffle = arr => arr.map(v=>[Math.random(),v]).sort((a,b)=>a[0]-b[0]).map(v=>v[1]);
const idx     = (r,c)=>r*GRID_SIZE+c;
const rows    = g => Array.from({length:GRID_SIZE}, (_,r)=>g.slice(r*GRID_SIZE,r*GRID_SIZE+GRID_SIZE));
const cols    = g => Array.from({length:GRID_SIZE}, (_,c)=>g.filter((_,i)=>i%GRID_SIZE===c));
const setEq   = (a,b)=>a.length===b.length && a.every(x=>b.includes(x));

/* ---------- UI ---------- */
function renderGrid(){
  gridEl.innerHTML='';
  gridWords.forEach((word,i)=>{
    const cell=document.createElement('div');
    cell.className='cell'+(locked[i]?' locked':'')+(i===selectedIdx?' selected':'');
    cell.textContent=word;
    cell.onclick=()=>onCellClick(i);
    gridEl.appendChild(cell);
  });
}
function updateSubmitBtn(){
  const left = MAX_ATTEMPTS - attempts;
  submitBtn.textContent = attempts>=MAX_ATTEMPTS? 'No attempts left' : `Submit (${left} left)`;
  submitBtn.className   = `submit attempt-${Math.min(attempts+1,MAX_ATTEMPTS)}`;
  submitBtn.disabled    = attempts>=MAX_ATTEMPTS || locked.every(Boolean);
}

/* ---------- game logic ---------- */
function onCellClick(i){
  if(locked[i]) return;
  if(selectedIdx===i){ selectedIdx=-1; }
  else if(selectedIdx===-1){ selectedIdx=i; }
  else{
    // swap
    [gridWords[i],gridWords[selectedIdx]]=[gridWords[selectedIdx],gridWords[i]];
    selectedIdx=-1;
  }
  renderGrid();
}

function evaluate(){
  attempts++;
  // check rows / cols
  const playerRows = rows(gridWords);
  const playerCols = cols(gridWords);

  playerRows.forEach((rArr,r)=>{
    if(setEq(rArr, correctRows.find(x=>setEq(x,rArr))||[])){
      // lock entire row
      for(let c=0;c<GRID_SIZE;c++){
        const i=idx(r,c);
        if(!locked[i]){ locked[i]=true; wordLockedAt[i]=attempts;}
      }
    }
  });
  playerCols.forEach((cArr,c)=>{
    if(setEq(cArr, correctCols.find(x=>setEq(x,cArr))||[])){
      // lock entire col
      for(let r=0;r<GRID_SIZE;r++){
        const i=idx(r,c);
        if(!locked[i]){ locked[i]=true; wordLockedAt[i]=attempts;}
      }
    }
  });

  renderGrid();
  updateSubmitBtn();
  if(locked.every(Boolean)) showWinPopup();
}

function showWinPopup(){
  const squares = ['⬛','🟩','🟨','🟧']; // idx 0 unused (attempt# -> emoji)
  const gridEmoji = rows(wordLockedAt.map(n=>squares[n||0]))
                        .map(r=>r.join('')).join('\n');
  shareTa.value = `Connecdoku ${formatDate(new Date())}\n${gridEmoji}`;
  modal.classList.remove('hidden');
}

copyBtn.onclick=async()=>{
  await navigator.clipboard.writeText(shareTa.value);
  copyBtn.textContent='Copied!';
};

/* ---------- init ---------- */
function formatDate(d){ return d.toISOString().slice(0,10); }

async function init(){
  puzzles = await fetch('daily_puzzles/puzzles.json').then(r=>r.json());
  const today   = new Date(); today.setHours(0,0,0,0);
  const dayIdx  = Math.floor((today - PUZZLE_START_DATE)/86400000);
  puzzle        = puzzles[ dayIdx % puzzles.length ];

  correctRows   = puzzle.words;
  correctCols   = cols(correctRows.flat());

  gridWords     = shuffle(correctRows.flat());
  renderGrid();
  updateSubmitBtn();
  submitBtn.onclick=evaluate;
}
init();
