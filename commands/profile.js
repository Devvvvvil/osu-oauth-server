import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getLinked, osuApiGet } from "../osuAuth.js";
import { syncOsuDigitRole } from "../rankRoles.js";
import { getDuelStats } from "../duelRank.js";

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

export default {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Show your linked osu! profile (pp, rank, acc, top plays)"),

  async execute(interaction) {
    await interaction.deferReply();

    const link = getLinked(interaction.user.id);
    if (!link) {
      return interaction.editReply("❌ You are not linked. Use **/connect** first.");
    }

    try {
      const me = await osuApiGet(link, "/me/osu");
      const stats = me.statistics;

      const rank = stats?.global_rank;
      const countryRank = stats?.country_rank;
      const pp = stats?.pp;
      const acc = stats?.hit_accuracy;
      const playcount = stats?.play_count;
      const level = stats?.level?.current;

      const best = await osuApiGet(
        link,
        `/users/${me.id}/scores/best?mode=osu&limit=5&legacy_only=0`
      );

      const topLines = (best || []).map((s, i) => {
        const title = `${s.beatmapset?.artist ?? "?"} - ${s.beatmapset?.title ?? "?"} [${s.beatmap?.version ?? "?"}]`;
        const scorePp = s.pp ? `${s.pp.toFixed(0)}pp` : "—";
        const scoreAcc = s.accuracy ? `${(s.accuracy * 100).toFixed(2)}%` : "—";
        const mods = Array.isArray(s.mods) && s.mods.length ? ` +${s.mods.join("")}` : "";
        return `**${i + 1}.** ${scorePp} • ${scoreAcc}${mods}\n${title}`;
      });

      // ✅ Duel Rank / streaks
      const duel = getDuelStats(interaction.user.id);
      const streakText =
        duel.winstreak > 0 ? `${duel.winstreak}W streak` :
        duel.losestreak > 0 ? `${duel.losestreak}L streak` :
        `No streak`;

      const embed = new EmbedBuilder()
        .setTitle(`${me.username} — osu! profile`)
        .setURL(`https://osu.ppy.sh/users/${me.id}`)
        .setThumbnail(me.avatar_url)
        .addFields(
          { name: "PP", value: `**${fmt(pp)}**`, inline: true },
          { name: "Global Rank", value: rank ? `**#${fmt(rank)}**` : "—", inline: true },
          { name: "Country Rank", value: countryRank ? `**#${fmt(countryRank)}**` : "—", inline: true },
          { name: "Accuracy", value: acc ? `**${acc.toFixed(2)}%**` : "—", inline: true },
          { name: "Level", value: level ? `**${fmt(level)}**` : "—", inline: true },
          { name: "Playcount", value: playcount ? `**${fmt(playcount)}**` : "—", inline: true },
          { name: "DuelRank", value: `**${duel.rating}**`, inline: true },
          { name: "Duel Record", value: `**${duel.wins}W / ${duel.losses}L** (${duel.games} games)\n**${streakText}**`, inline: true }
        )
        .addFields({
          name: "Top Plays (Best)",
          value: topLines.length ? topLines.join("\n\n").slice(0, 1024) : "No scores found.",
        });

      await interaction.editReply({ embeds: [embed] });

      // Update digit role after profile
      syncOsuDigitRole(interaction.client, interaction.user.id, interaction.guildId).catch(() => {});
    } catch (e) {
      console.error(e);
      await interaction.editReply("❌ Failed to fetch your osu profile. Try again, or /connect again if needed.");
    }
  },
};