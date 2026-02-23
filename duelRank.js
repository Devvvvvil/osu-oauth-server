import fs from "fs";

const PATH = "./data/duel_ranks.json";

function ensure() {
  const dir = "./data";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PATH)) fs.writeFileSync(PATH, "{}", "utf8");
}

function load() {
  ensure();
  const raw = fs.readFileSync(PATH, "utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { fs.writeFileSync(PATH, "{}", "utf8"); return {}; }
}

function save(data) {
  ensure();
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2), "utf8");
}

export function getDuelStats(userId) {
  const db = load();
  const s = db[userId];
  if (s) return s;

  // default
  return {
    rating: 0,
    winstreak: 0,
    losestreak: 0,
    wins: 0,
    losses: 0,
    games: 0,
  };
}

export function applyMatchResult(winnerId, loserId) {
  const db = load();

  const w = db[winnerId] ?? getDuelStats(winnerId);
  const l = db[loserId] ?? getDuelStats(loserId);

  // Winner +25
  w.rating += 25;
  w.wins += 1;
  w.games += 1;
  w.winstreak += 1;
  w.losestreak = 0;

  // Loser -25
  l.rating -= 25;
  l.losses += 1;
  l.games += 1;
  l.losestreak += 1;
  l.winstreak = 0;

  db[winnerId] = w;
  db[loserId] = l;

  save(db);

  return { winner: w, loser: l };
}