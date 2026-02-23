import { getLinked, osuApiGet } from "./osuAuth.js";

function pickDigitRoleId(rank) {
  if (!rank) return null;

  // 2-digit: 1-99
  if (rank <= 99) return process.env.ROLE_2D;

  // 3-digit: 100-999
  if (rank <= 999) return process.env.ROLE_3D;

  // 4-digit: 1,000-9,999
  if (rank <= 9_999) return process.env.ROLE_4D;

  // 5-digit: 10,000-99,999
  if (rank <= 99_999) return process.env.ROLE_5D;

  // 6-digit: 100,000-999,999
  if (rank <= 999_999) return process.env.ROLE_6D;

  // 7-digit: 1,000,000-9,999,999 (or more, if you want)
  if (rank <= 9_999_999) return process.env.ROLE_7D;

  // If you don't have 8D role, just keep them as 7D (or return null)
  return process.env.ROLE_7D || null;
}

export async function syncOsuDigitRole(client, discordUserId) {
  const link = getLinked(discordUserId);
  if (!link) return { ok: false, reason: "not_linked" };

  try {
    // fetch osu profile via OAuth
    const me = await osuApiGet(link, "/me/osu");
    const rank = me?.statistics?.global_rank;

    if (!rank) return { ok: false, reason: "no_rank" };

    // fetch member in your guild
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(discordUserId);

    const newRoleId = pickDigitRoleId(rank);
    if (!newRoleId) return { ok: false, reason: "no_role_match" };

    const digitRoles = [
      process.env.ROLE_2D,
      process.env.ROLE_3D,
      process.env.ROLE_4D,
      process.env.ROLE_5D,
      process.env.ROLE_6D,
      process.env.ROLE_7D,
    ].filter(Boolean);

    // remove any old digit roles (except the one we want)
    for (const r of digitRoles) {
      if (r !== newRoleId && member.roles.cache.has(r)) {
        await member.roles.remove(r).catch(() => {});
      }
    }

    // add correct digit role
    if (!member.roles.cache.has(newRoleId)) {
      await member.roles.add(newRoleId).catch(() => {});
    }

    return { ok: true, rank, roleId: newRoleId };
  } catch (e) {
    console.log("Role sync error:", e?.message || e);
    return { ok: false, reason: "error" };
  }
}