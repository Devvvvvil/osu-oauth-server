import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { getLinked, osuApiGet } from "./osuAuth.js";
import { applyMatchResult } from "./duelRank.js";

const QUEUE_PATH = "./data/duel_queue.json";
const DUELS_PATH = "./data/duels.json";
const META_PATH = "./data/duel_meta.json";

function ensureFile(path, fallback) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify(fallback, null, 2), "utf8");
}

function loadJSON(path, fallback) {
  ensureFile(path, fallback);
  const raw = fs.readFileSync(path, "utf8").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    fs.writeFileSync(path, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

function saveJSON(path, data) {
  ensureFile(path, data);
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function randomPassword(len = 10) {
  return crypto.randomBytes(32).toString("base64url").slice(0, len);
}

function pickStarter(aId, bId) {
  return Math.random() < 0.5 ? aId : bId;
}

function now() {
  return Date.now();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function beatmapLink(id) {
  return `https://osu.ppy.sh/b/${id}`;
}

// ------------------ osu app token (search) ------------------
let appToken = null;
async function getAppToken() {
  if (appToken) return appToken;

  const res = await axios.post("https://osu.ppy.sh/oauth/token", {
    client_id: process.env.OSU_CLIENT_ID,
    client_secret: process.env.OSU_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "public",
  });

  appToken = res.data.access_token;
  setTimeout(() => (appToken = null), (res.data.expires_in - 60) * 1000);
  return appToken;
}

async function searchBeatmapsetsRanked(page) {
  const t = await getAppToken();
  const res = await axios.get(
    `https://osu.ppy.sh/api/v2/beatmapsets/search?m=0&s=ranked&page=${page}`,
    { headers: { Authorization: `Bearer ${t}` } }
  );
  return res.data?.beatmapsets || [];
}

async function getPlayerStarSignal(discordId) {
  const link = getLinked(discordId);
  if (!link) return null;

  try {
    const me = await osuApiGet(link, "/me/osu");
    const best = await osuApiGet(link, `/users/${me.id}/scores/best?mode=osu&limit=20&legacy_only=0`);
    const stars = [];
    for (const s of best || []) {
      const sr = s?.beatmap?.difficulty_rating;
      if (typeof sr === "number") stars.push(sr);
    }
    if (!stars.length) return null;

    return {
      p50: percentile(stars, 0.5),
      username: me?.username || null,
    };
  } catch {
    return null;
  }
}

async function computePoolStarRange(aId, bId) {
  const A = await getPlayerStarSignal(aId);
  const B = await getPlayerStarSignal(bId);

  if (!A || !B) return { min: 4.5, max: 6.0, note: "default range" };

  const mid = ((A.p50 ?? 5.2) + (B.p50 ?? 5.2)) / 2;
  const min = clamp(mid - 0.35, 2.0, 11.0);
  const max = clamp(mid + 0.35, min + 0.2, 11.5);

  return { min, max, note: `auto from top plays (${A.username} vs ${B.username})` };
}

async function findRandomBeatmapInRange(min, max, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const page = 1 + Math.floor(Math.random() * 20);
    const sets = await searchBeatmapsetsRanked(page);
    if (!sets.length) continue;

    const set = sets[Math.floor(Math.random() * sets.length)];
    const beatmaps = set?.beatmaps || [];
    if (!beatmaps.length) continue;

    const bm = beatmaps[Math.floor(Math.random() * beatmaps.length)];
    const sr = bm?.difficulty_rating;
    if (typeof sr !== "number") continue;
    if (sr < min || sr > max) continue;

    return {
      beatmap_id: bm.id,
      version: bm.version,
      sr,
      bpm: bm.bpm,
      set_artist: set.artist,
      set_title: set.title,
      cover: set?.covers?.cover || null,
    };
  }
  return null;
}

async function generatePool(min, max) {
  const nm1 = await findRandomBeatmapInRange(min, max);
  const hd1 = await findRandomBeatmapInRange(min, max);
  const hr1 = await findRandomBeatmapInRange(min, max);
  const dt1 = await findRandomBeatmapInRange(min, max);
  const tb = await findRandomBeatmapInRange(min + 0.2, max + 0.4);

  const pool = [
    { slot: "NM1", mod: "NM", map: nm1 },
    { slot: "HD1", mod: "HD", map: hd1 },
    { slot: "HR1", mod: "HR", map: hr1 },
    { slot: "DT1", mod: "DT", map: dt1 },
    { slot: "TB", mod: "TB", map: tb },
  ];

  for (let i = 0; i < pool.length; i++) {
    if (!pool[i].map) {
      const isTb = pool[i].slot === "TB";
      pool[i].map = await findRandomBeatmapInRange(isTb ? min + 0.2 : min, isTb ? max + 0.4 : max, 140);
    }
  }

  return pool;
}

// ------------------ Duel state ------------------
function getDuelKey(duelId) {
  return String(duelId);
}

function sideOf(duel, userId) {
  if (userId === duel.players.a.id) return "a";
  if (userId === duel.players.b.id) return "b";
  return null;
}

function otherSide(side) {
  return side === "a" ? "b" : "a";
}

function allocDuelId() {
  const meta = loadJSON(META_PATH, { counter: 0 });
  meta.counter = (meta.counter || 0) + 1;
  saveJSON(META_PATH, meta);
  return meta.counter;
}

function saveDuel(duel) {
  const duels = loadJSON(DUELS_PATH, {});
  duels[getDuelKey(duel.id)] = duel;
  saveJSON(DUELS_PATH, duels);
}

function loadDuel(duelId) {
  const duels = loadJSON(DUELS_PATH, {});
  return duels[getDuelKey(duelId)] || null;
}

function loadDuelByChannel(channelId) {
  const duels = loadJSON(DUELS_PATH, {});
  return Object.values(duels).find((d) => d.channelId === channelId) || null;
}

function deleteDuel(duelId) {
  const duels = loadJSON(DUELS_PATH, {});
  delete duels[getDuelKey(duelId)];
  saveJSON(DUELS_PATH, duels);
}

function poolEmbed(duel) {
  const banned = new Set([...duel.bans.a, ...duel.bans.b]);
  const picked = new Set(duel.picks.map((p) => p.slot));

  const lines = duel.pool.map((p) => {
    const m = p.map;
    const status =
      banned.has(p.slot) ? "❌ BANNED" :
      picked.has(p.slot) ? "✅ PICKED" :
      (p.slot === "TB" ? "⭐ TB" : "—");

    const name = m ? `${m.set_artist} - ${m.set_title} [${m.version}]` : "—";
    const sr = m?.sr ? `${m.sr.toFixed(2)}★` : "—";
    const url = m?.beatmap_id ? beatmapLink(m.beatmap_id) : "";

    return `${p.slot} **(${p.mod})** — ${sr} — ${status}\n${url}\n${name}`;
  });

  const e = new EmbedBuilder()
    .setTitle(`Duel Pool — BO3`)
    .setDescription(lines.join("\n\n").slice(0, 3900))
    .addFields(
      { name: "Room", value: `**${duel.roomName}**`, inline: true },
      { name: "Password", value: `**${duel.password}**`, inline: true },
      { name: "Starter", value: `<@${duel.starterId}>`, inline: true },
      { name: "Score", value: `P1: **${duel.score.a}** — P2: **${duel.score.b}**`, inline: true },
      { name: "Range", value: `**${duel.starRange.min.toFixed(2)}–${duel.starRange.max.toFixed(2)}★**`, inline: true },
      { name: "Phase", value: `**${duel.phase}**`, inline: true },
    );

  const cover = duel.pool.find((x) => x.map?.cover)?.map?.cover;
  if (cover) e.setThumbnail(cover);
  return e;
}

function makeActionRowsForPhase(duel) {
  const banned = new Set([...duel.bans.a, ...duel.bans.b]);
  const picked = new Set(duel.picks.map((p) => p.slot));

  const allowed = duel.pool
    .filter((p) => p.slot !== "TB")
    .filter((p) => !banned.has(p.slot) && !picked.has(p.slot));

  const action = duel.phase.startsWith("BAN")
    ? "BAN"
    : duel.phase.startsWith("PICK")
      ? "PICK"
      : null;

  if (!action) return [];

  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;

  for (const p of allowed) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`duel:${duel.id}:${action}:${p.slot}`)
        .setStyle(action === "BAN" ? ButtonStyle.Danger : ButtonStyle.Primary)
        .setLabel(`${action} ${p.slot}`)
    );
    count++;
    if (count === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
      count = 0;
    }
  }
  if (count) rows.push(row);

  return rows;
}

function mapResultButtons(duel, slot) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`duel:${duel.id}:REPORT:WIN:${slot}`)
        .setStyle(ButtonStyle.Success)
        .setLabel("I WON"),
      new ButtonBuilder()
        .setCustomId(`duel:${duel.id}:REPORT:LOSE:${slot}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel("I LOST")
    ),
  ];
}

function nextPhase(duel) {
  if (duel.phase === "BAN_A") return "BAN_B";
  if (duel.phase === "BAN_B") return "PICK_A";
  if (duel.phase === "PICK_A") return "PICK_B";
  if (duel.phase === "PICK_B") return "PLAYING";
  return duel.phase;
}

function currentTurnSide(duel) {
  const starterSide = duel.starterId === duel.players.a.id ? "a" : "b";
  const other = otherSide(starterSide);

  if (duel.phase === "BAN_A" || duel.phase === "PICK_A") return starterSide;
  if (duel.phase === "BAN_B" || duel.phase === "PICK_B") return other;
  return null;
}

function getMapBySlot(duel, slot) {
  return duel.pool.find((p) => p.slot === slot) || null;
}

function ensureReportsEntry(duel, slot) {
  duel.reports ||= {};
  duel.reports[slot] ||= { a: null, b: null };
  return duel.reports[slot];
}

function expectedSlot(duel) {
  const sum = duel.score.a + duel.score.b;
  const tb = duel.score.a === 1 && duel.score.b === 1;

  if (sum === 0) return duel.picks[0]?.slot || null;
  if (sum === 1) return duel.picks[1]?.slot || null;
  if (tb && sum === 2) return "TB";
  return null;
}

async function announceNextMap(channel, duel) {
  const slot = expectedSlot(duel);
  if (!slot) return;

  const mapEntry = getMapBySlot(duel, slot);
  const m = mapEntry?.map;

  const msg =
    `🗺️ **Next Map:** **${slot}** (${mapEntry.mod})\n` +
    `${m?.beatmap_id ? beatmapLink(m.beatmap_id) : ""}\n` +
    `${m ? `${m.set_artist} - ${m.set_title} [${m.version}] — ${m.sr.toFixed(2)}★` : ""}\n\n` +
    `📸 Post screenshot evidence here.\n` +
    `After playing, BOTH players must report result:`;

  await channel.send({ content: msg, components: mapResultButtons(duel, slot) });
}

async function lockAndScheduleDelete(channel, duel) {
  const mins = Number(process.env.DUEL_DELETE_MINUTES || 5);
  await channel.send(`🧹 This duel channel will auto-delete in **${mins}** minute(s).`);

  setTimeout(async () => {
    try {
      await channel.delete("Duel finished - auto cleanup");
    } catch {}
  }, mins * 60 * 1000);
}

async function finishMatch(channel, duel, winnerSide) {
  duel.phase = "FINISHED";
  saveDuel(duel);

  const winnerId = duel.players[winnerSide].id;
  const loserId = duel.players[otherSide(winnerSide)].id;

  // ✅ Apply rank changes (+25 / -25) + streaks
  const update = applyMatchResult(winnerId, loserId);

  await channel.send(
    `🏁 **Match finished!** Winner: <@${winnerId}> | Loser: <@${loserId}>\n` +
    `Final score: **${duel.score.a}-${duel.score.b}**\n\n` +
    `🏆 Winner DuelRank: **${update.winner.rating}** (+25) | Streak: **${update.winner.winstreak}W**\n` +
    `💀 Loser DuelRank: **${update.loser.rating}** (-25) | Streak: **${update.loser.losestreak}L**`
  );

  // Lock chat for players after finish (support can still chat)
  const overwrites = [
    { id: channel.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: duel.players.a.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: duel.players.b.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
  ];

  if (process.env.SUPPORT_ROLE_ID) {
    overwrites.push({
      id: process.env.SUPPORT_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  await channel.permissionOverwrites.set(overwrites).catch(() => {});

  // remove duel from storage
  deleteDuel(duel.id);

  // ✅ auto delete channel
  await lockAndScheduleDelete(channel, duel);
}

// ------------------ Queue API ------------------
export function addToQueue(userId) {
  const q = loadJSON(QUEUE_PATH, []);

  if (q.includes(userId)) return { ok: false, reason: "already_queued" };
  q.push(userId);

  saveJSON(QUEUE_PATH, q);
  return { ok: true, size: q.length };
}

export function removeFromQueue(userId) {
  const q = loadJSON(QUEUE_PATH, []);
  const idx = q.indexOf(userId);

  if (idx === -1) return { ok: false, reason: "not_in_queue" };
  q.splice(idx, 1);

  saveJSON(QUEUE_PATH, q);
  return { ok: true, size: q.length };
}

export function queueStatus() {
  const q = loadJSON(QUEUE_PATH, []);
  return { size: q.length, users: q };
}

// ------------------ Matchmaking / Channel Create ------------------
export async function tryMatchmakeAndCreate(client, guild) {
  let q = loadJSON(QUEUE_PATH, []);
  if (q.length < 2) return null;

  // ✅ Ensure both players are linked (skip unlinked)
  const nextLinked = () => {
    while (q.length) {
      const id = q.shift();
      if (getLinked(id)) return id;
    }
    return null;
  };

  const aId = nextLinked();
  const bId = nextLinked();

  // save updated queue after removing unlinked/skipped
  saveJSON(QUEUE_PATH, q);

  if (!aId || !bId) return null;

  const duelId = allocDuelId();
  const roomName = `${process.env.DUEL_CHANNEL_PREFIX || "duel"}-${duelId}`;
  const password = randomPassword(10);
  const starterId = pickStarter(aId, bId);

  const categoryId = process.env.DUEL_CATEGORY_ID || null;
  const supportRoleId = process.env.SUPPORT_ROLE_ID || null;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: aId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: bId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
  ];

  if (supportRoleId) {
    overwrites.push({
      id: supportRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    });
  }

  const channel = await guild.channels.create({
    name: roomName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites: overwrites,
  });

  const range = await computePoolStarRange(aId, bId);
  const pool = await generatePool(range.min, range.max);

  const duel = {
    id: duelId,
    channelId: channel.id,
    guildId: guild.id,
    roomName,
    password,
    players: { a: { id: aId }, b: { id: bId } },
    starterId,
    phase: "BAN_A",
    bans: { a: [], b: [] },
    picks: [],
    pool,
    score: { a: 0, b: 0 },
    reports: {},
    createdAt: now(),
    starRange: range,
  };

  saveDuel(duel);

  const intro =
    `🎮 **Duel Found!**\nPlayers: <@${aId}> vs <@${bId}>\n` +
    `Room: **${duel.roomName}** | Password: **${duel.password}**\n` +
    `Starter (random): <@${starterId}>\n` +
    `Range: **${range.min.toFixed(2)}–${range.max.toFixed(2)}★** (${range.note})\n\n` +
    `**Ban & Pick Rules (BO3):**\n` +
    `• Starter bans 1, then other bans 1.\n` +
    `• Starter picks Map 1, other picks Map 2.\n` +
    `• If 1–1 → play **TB**.\n\n` +
    `📸 Post screenshots as evidence here.`;

  await channel.send({
    content: intro,
    embeds: [poolEmbed(duel)],
    components: makeActionRowsForPhase(duel),
  });

  return duel;
}

async function updatePoolMessage(channel, duel) {
  await channel.send({
    embeds: [poolEmbed(duel)],
    components: makeActionRowsForPhase(duel),
  });
}

// ------------------ Buttons handler ------------------
export async function handleDuelButton(interaction) {
  const parts = interaction.customId.split(":");
  if (parts.length < 4) return;

  const duelId = Number(parts[1]);
  const action = parts[2];

  const duel = loadDuel(duelId);
  if (!duel) return interaction.reply({ content: "❌ Duel not found (maybe ended).", flags: 64 });
  if (interaction.channelId !== duel.channelId) return interaction.reply({ content: "❌ Wrong channel.", flags: 64 });

  const userId = interaction.user.id;
  const side = sideOf(duel, userId);
  if (!side) return interaction.reply({ content: "❌ You are not a player in this duel.", flags: 64 });

  const channel = await interaction.guild.channels.fetch(duel.channelId);

  // BAN/PICK
  if (action === "BAN" || action === "PICK") {
    if (!duel.phase.startsWith("BAN") && !duel.phase.startsWith("PICK")) {
      return interaction.reply({ content: "❌ Ban/Pick is over.", flags: 64 });
    }

    const expected = currentTurnSide(duel);
    if (expected !== side) return interaction.reply({ content: "❌ Not your turn.", flags: 64 });

    const slot = parts[3];
    if (slot === "TB") return interaction.reply({ content: "❌ TB cannot be banned/picked.", flags: 64 });

    const banned = new Set([...duel.bans.a, ...duel.bans.b]);
    const picked = new Set(duel.picks.map((p) => p.slot));

    if (banned.has(slot)) return interaction.reply({ content: "❌ Already banned.", flags: 64 });
    if (picked.has(slot)) return interaction.reply({ content: "❌ Already picked.", flags: 64 });

    if (action === "BAN") {
      duel.bans[side].push(slot);
      duel.phase = nextPhase(duel);
      saveDuel(duel);

      await interaction.reply({ content: `✅ <@${userId}> banned **${slot}**` });
      await updatePoolMessage(channel, duel);

      if (duel.phase === "PICK_A") await channel.send("🎯 **Pick phase begins.** Starter picks first.");
      return;
    }

    if (action === "PICK") {
      duel.picks.push({ slot, pickedBy: userId });
      duel.phase = nextPhase(duel);
      saveDuel(duel);

      await interaction.reply({ content: `✅ <@${userId}> picked **${slot}**` });
      await updatePoolMessage(channel, duel);

      if (duel.phase === "PLAYING") {
        await channel.send("✅ **Picks locked.** Match starts now!");
        await announceNextMap(channel, duel);
      }
      return;
    }
  }

  // REPORT
  if (action === "REPORT") {
    const result = parts[3]; // WIN / LOSE
    const slot = parts[4];

    if (duel.phase !== "PLAYING" && duel.phase !== "DISPUTE") {
      return interaction.reply({ content: "❌ Not in reporting state.", flags: 64 });
    }

    const exp = expectedSlot(duel);
    if (!exp || exp !== slot) return interaction.reply({ content: "❌ That map is not active.", flags: 64 });

    const entry = ensureReportsEntry(duel, slot);
    entry[side] = result;
    saveDuel(duel);

    await interaction.reply({ content: `📌 Saved: **${result}** on **${slot}**`, flags: 64 });

    const aRes = entry.a;
    const bRes = entry.b;

    if (aRes && bRes) {
      const ok =
        (aRes === "WIN" && bRes === "LOSE") ||
        (aRes === "LOSE" && bRes === "WIN");

      if (!ok) {
        duel.phase = "DISPUTE";
        saveDuel(duel);

        const sup = process.env.SUPPORT_ROLE_ID ? `<@&${process.env.SUPPORT_ROLE_ID}>` : "**Support**";
        await channel.send(
          `⚠️ **Conflict!** Both players reported the same result on **${slot}**.\n` +
          `${sup} please decide using **/resolve**.\nPlayers: <@${duel.players.a.id}> <@${duel.players.b.id}>`
        );
        return;
      }

      const winnerSide = aRes === "WIN" ? "a" : "b";
      duel.score[winnerSide] += 1;
      duel.phase = "PLAYING";
      saveDuel(duel);

      await channel.send(`✅ **Result confirmed** for **${slot}**. Winner: <@${duel.players[winnerSide].id}>`);

      // BO3 end
      if (duel.score.a >= 2) return finishMatch(channel, duel, "a");
      if (duel.score.b >= 2) return finishMatch(channel, duel, "b");

      await announceNextMap(channel, duel);
    }
    return;
  }
}

// ------------------ Support resolve (command uses this) ------------------
export async function supportResolve(client, channelId, winnerUserId) {
  const duel = loadDuelByChannel(channelId);
  if (!duel) return { ok: false, reason: "no_duel" };

  const winnerSide =
    winnerUserId === duel.players.a.id ? "a" :
    winnerUserId === duel.players.b.id ? "b" :
    null;

  if (!winnerSide) return { ok: false, reason: "winner_not_player" };

  const slot = expectedSlot(duel);
  if (!slot) return { ok: false, reason: "no_active_map" };

  // Force result
  duel.reports ||= {};
  duel.reports[slot] = winnerSide === "a"
    ? { a: "WIN", b: "LOSE" }
    : { a: "LOSE", b: "WIN" };

  duel.score[winnerSide] += 1;
  duel.phase = "PLAYING";
  saveDuel(duel);

  const guild = await client.guilds.fetch(duel.guildId);
  const channel = await guild.channels.fetch(duel.channelId);

  await channel.send(`🛡️ **Support resolved**: <@${winnerUserId}> wins **${slot}**. Score: **${duel.score.a}-${duel.score.b}**`);

  if (duel.score.a >= 2) {
    await finishMatch(channel, duel, "a");
    return { ok: true, finished: true };
  }
  if (duel.score.b >= 2) {
    await finishMatch(channel, duel, "b");
    return { ok: true, finished: true };
  }

  await announceNextMap(channel, duel);
  return { ok: true, finished: false };
}