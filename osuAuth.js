import fs from "fs";
import crypto from "crypto";
import axios from "axios";

const LINKS_PATH = "./data/links.json";
const PENDING_PATH = "./data/pending.json";

function ensureFile(path) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, "{}", "utf8");
  }
}

// Safe JSON loader: fixes empty/invalid JSON automatically
function loadJSON(path) {
  ensureFile(path);

  const raw = fs.readFileSync(path, "utf8").trim();
  if (!raw) {
    fs.writeFileSync(path, "{}", "utf8");
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    // if corrupted, reset
    fs.writeFileSync(path, "{}", "utf8");
    return {};
  }
}

function saveJSON(path, data) {
  ensureFile(path);
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function createState(discordId) {
  const pending = loadJSON(PENDING_PATH);

  const nonce = crypto.randomBytes(24).toString("hex");
  const sig = crypto
    .createHmac("sha256", process.env.APP_SECRET)
    .update(`${discordId}.${nonce}`)
    .digest("hex");

  const state = `${discordId}.${nonce}.${sig}`;

  // expire in 10 minutes
  pending[state] = { discordId, createdAt: Date.now() };
  saveJSON(PENDING_PATH, pending);

  return state;
}

export function consumeState(state) {
  const pending = loadJSON(PENDING_PATH);
  const entry = pending[state];
  if (!entry) return null;

  const parts = String(state).split(".");
  if (parts.length !== 3) return null;

  const [discordId, nonce, sig] = parts;

  const expected = crypto
    .createHmac("sha256", process.env.APP_SECRET)
    .update(`${discordId}.${nonce}`)
    .digest("hex");

  if (sig !== expected) return null;

  // expire check (10 min)
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    delete pending[state];
    saveJSON(PENDING_PATH, pending);
    return null;
  }

  delete pending[state];
  saveJSON(PENDING_PATH, pending);

  return discordId;
}

export function getConnectUrl(state) {
  const redirectUri = `${process.env.BASE_URL}/osu/callback`;
  const scope = "public identify";

  return (
    `https://osu.ppy.sh/oauth/authorize` +
    `?client_id=${encodeURIComponent(process.env.OSU_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

export async function exchangeCodeForToken(code) {
  const redirectUri = `${process.env.BASE_URL}/osu/callback`;

  const body = new URLSearchParams();
  body.set("client_id", process.env.OSU_CLIENT_ID);
  body.set("client_secret", process.env.OSU_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  const res = await axios.post("https://osu.ppy.sh/oauth/token", body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  });

  return res.data;
}

export async function refreshToken(refresh_token) {
  const body = new URLSearchParams();
  body.set("client_id", process.env.OSU_CLIENT_ID);
  body.set("client_secret", process.env.OSU_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refresh_token);
  body.set("scope", "public identify");

  const res = await axios.post("https://osu.ppy.sh/oauth/token", body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  });

  return res.data;
}

export function saveLinked(discordId, linkData) {
  const links = loadJSON(LINKS_PATH);
  links[discordId] = linkData;
  saveJSON(LINKS_PATH, links);
}

export function getLinked(discordId) {
  const links = loadJSON(LINKS_PATH);
  return links[discordId] || null;
}

export async function osuApiGet(link, path) {
  // refresh if expired
  let accessToken = link.access_token;

  if (!link.expires_at || Date.now() >= link.expires_at) {
    const refreshed = await refreshToken(link.refresh_token);
    link.access_token = refreshed.access_token;
    link.refresh_token = refreshed.refresh_token ?? link.refresh_token;
    link.expires_at = Date.now() + refreshed.expires_in * 1000;

    saveLinked(link.discord_id, link);
    accessToken = link.access_token;
  }

  const res = await axios.get(`https://osu.ppy.sh/api/v2${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return res.data;
}