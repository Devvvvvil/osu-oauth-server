import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import axios from "axios";
import rosu from "rosu-pp-js";
import { getLinked, osuApiGet } from "../osuAuth.js";

const { Beatmap, Performance } = rosu;

// ---------- Helpers ----------
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

function normalizeMods(modsStr) {
  if (!modsStr) return [];
  const s = modsStr.toUpperCase().replace(/\s+/g, "");
  const tokens = s.includes(",") ? s.split(",") : s.match(/.{1,2}/g) || [];
  const valid = new Set(["HD", "HR", "DT", "NC", "EZ", "HT", "FL", "NF", "SD", "PF", "SO"]);
  // treat NC as DT for pp purposes in many tools; osu stores NC separately though
  return tokens.filter((m) => valid.has(m));
}

function modsToString(mods) {
  if (!mods || !mods.length) return "NM";
  return mods.join("");
}

// ---------- osu API: app token for searching beatmaps ----------
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

// Search beatmapsets and then we filter locally (stars/mods logic is local).
async function getRandomCandidateFromSearch({ pages = 12 }) {
  const t = await getAppToken();
  const page = 1 + Math.floor(Math.random() * pages);

  const res = await axios.get(
    `https://osu.ppy.sh/api/v2/beatmapsets/search?m=0&s=ranked&page=${page}`,
    { headers: { Authorization: `Bearer ${t}` } }
  );

  const sets = res.data?.beatmapsets || [];
  if (!sets.length) return null;

  const set = sets[Math.floor(Math.random() * sets.length)];
  const beatmaps = set.beatmaps || [];
  if (!beatmaps.length) return null;

  const beatmap = beatmaps[Math.floor(Math.random() * beatmaps.length)];
  return { set, beatmap };
}

// ---------- Personalized defaults ----------
async function getPersonalDefaults(discordId) {
  // Fallback defaults if user isn't linked or something fails.
  const fallback = {
    min: 4.5,
    max: 6.5,
    mods: [],
    reason: "fallback",
  };

  const link = getLinked(discordId);
  if (!link) return fallback;

  try {
    // Use user OAuth token to get their top plays (best scores)
    const me = await osuApiGet(link, "/me/osu");

    // Pull top 20 best scores (enough to infer stars + mods)
    const best = await osuApiGet(link, `/users/${me.id}/scores/best?mode=osu&limit=20&legacy_only=0`);

    const stars = [];
    const modCounts = new Map();

    for (const s of best || []) {
      const sr = s?.beatmap?.difficulty_rating;
      if (typeof sr === "number") stars.push(sr);

      const mods = Array.isArray(s?.mods) ? s.mods : [];
      for (const m of mods) modCounts.set(m, (modCounts.get(m) || 0) + 1);
    }

    // If no usable data, fallback
    if (!stars.length) return fallback;

    // Star logic:
    // - use 25th percentile as "comfortable"
    // - use 75th percentile as "stretch"
    // Then pad a bit and clamp to sane values.
    const p25 = percentile(stars, 0.25);
    const p75 = percentile(stars, 0.75);
    const med = median(stars);

    // Build range around your real plays
    // (keeps it from being too wide)
    let min = (p25 ?? med ?? 4.5) - 0.25;
    let max = (p75 ?? med ?? 6.5) + 0.25;

    // Safety clamps
    min = clamp(min, 1.0, 12.0);
    max = clamp(max, min + 0.2, 12.5);

    // Mods logic: pick most common “main” mod setup from top plays.
    // We’ll only auto-pick HD/HR/DT/NC (common) and ignore “support” mods like NF/SD/PF by default.
    const preferencePool = ["HD", "HR", "DT", "NC"];
    const ranked = preferencePool
      .map((m) => ({ m, c: modCounts.get(m) || 0 }))
      .sort((a, b) => b.c - a.c);

    const top = ranked[0];
    let mods = [];

    // Only apply auto-mods if it appears in a meaningful chunk of top plays
    // (>= 4 out of 20 is a good signal)
    if (top && top.c >= 4) {
      mods = [top.m];
      // If HD+HR both popular, allow combo (common)
      const hd = modCounts.get("HD") || 0;
      const hr = modCounts.get("HR") || 0;
      if (top.m === "HD" && hr >= 4) mods = ["HD", "HR"];
      if (top.m === "HR" && hd >= 4) mods = ["HD", "HR"];

      // If NC is top, prefer showing NC (some players like it)
      // PP calc tools often treat NC ~ DT; we keep NC label for display.
    }

    return { min, max, mods, reason: "profile" };
  } catch {
    return fallback;
  }
}

// ---------- PP calc ----------
async function calcPP(beatmapId, mods = [], acc = 98) {
  const file = await axios.get(`https://osu.ppy.sh/osu/${beatmapId}`);
  const map = new Beatmap(file.data);

  const perf = new Performance({
    acc,
    mods: mods || [],
  });

  const res = perf.calculate(map);
  return Math.round(res.pp);
}

// ---------- Main command ----------
export default {
  data: new SlashCommandBuilder()
    .setName("r")
    .setDescription("Random osu map (auto-personalized if your profile is linked)")
    .addNumberOption((o) =>
      o.setName("min").setDescription("Min stars (override)").setRequired(false)
    )
    .addNumberOption((o) =>
      o.setName("max").setDescription("Max stars (override)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("mods").setDescription("Mods override (e.g. HDHR, DT, NM)").setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 }); // ephemeral

    // Personalized defaults
    const personal = await getPersonalDefaults(interaction.user.id);

    // Overrides
    const minOpt = interaction.options.getNumber("min");
    const maxOpt = interaction.options.getNumber("max");
    const modsOpt = interaction.options.getString("mods");

    let min = typeof minOpt === "number" ? minOpt : personal.min;
    let max = typeof maxOpt === "number" ? maxOpt : personal.max;

    // Keep min/max sane
    min = clamp(min, 0.5, 12.0);
    max = clamp(max, min + 0.2, 12.5);

    let mods = personal.mods;
    if (typeof modsOpt === "string") {
      const parsed = normalizeMods(modsOpt);
      // allow explicit "NM"
      mods = modsOpt.trim().toUpperCase() === "NM" ? [] : parsed;
    }

    // Search & filter tries
    const MAX_TRIES = 40;
    const SEARCH_PAGES = 15;

    try {
      let picked = null;

      for (let i = 0; i < MAX_TRIES; i++) {
        const candidate = await getRandomCandidateFromSearch({ pages: SEARCH_PAGES });
        if (!candidate) continue;

        const { set, beatmap } = candidate;

        const sr = beatmap?.difficulty_rating;
        if (typeof sr !== "number") continue;

        if (sr < min || sr > max) continue;

        // If user uses DT/NC a lot, SR in api is NM SR; DT will feel harder.
        // We adjust: if mods contain DT/NC, allow slightly lower NM SR.
        if ((mods.includes("DT") || mods.includes("NC")) && sr > max - 0.3) {
          // still ok; not blocking here
        }

        picked = { set, beatmap };
        break;
      }

      if (!picked) {
        return interaction.editReply(
          `❌ Couldn't find a map in **${min.toFixed(2)}–${max.toFixed(2)}★** after many tries. Try widening the range.`
        );
      }

      const { set, beatmap } = picked;

      const pp = await calcPP(beatmap.id, mods, 98);

      const embed = new EmbedBuilder()
        .setTitle(`${set.artist} - ${set.title} [${beatmap.version}]`)
        .setURL(`https://osu.ppy.sh/b/${beatmap.id}`)
        .setDescription(
          `⭐ **${beatmap.difficulty_rating.toFixed(2)}**  |  🎵 **${beatmap.bpm ?? "?"} BPM**\n` +
          `Mods: **${modsToString(mods)}**  |  98% → **${pp}pp**\n` +
          `Range used: **${min.toFixed(2)}–${max.toFixed(2)}★**` +
          (personal.reason === "profile" ? ` (auto from your top plays)` : ` (default)`)
        )
        .setThumbnail(set?.covers?.cover || null);

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      console.error(e);
      await interaction.editReply("❌ Failed to get a random map.");
    }
  },
};