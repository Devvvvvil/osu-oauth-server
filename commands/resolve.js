import { SlashCommandBuilder } from "discord.js";
import { supportResolve } from "../duelSystem.js";

export default {
  data: new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("Support: resolve dispute by selecting who won the CURRENT map.")
    .addUserOption(o => o.setName("winner").setDescription("Who won").setRequired(true)),

  async execute(interaction) {
    const supportRoleId = process.env.SUPPORT_ROLE_ID;
    if (!supportRoleId || !interaction.member.roles.cache.has(supportRoleId)) {
      return interaction.reply({ content: "❌ Support only.", flags: 64 });
    }

    const winner = interaction.options.getUser("winner");
    const res = await supportResolve(interaction.client, interaction.channelId, winner.id);

    if (!res.ok) {
      if (res.reason === "no_duel") return interaction.reply({ content: "❌ No active duel here.", flags: 64 });
      if (res.reason === "winner_not_player") return interaction.reply({ content: "❌ Winner must be one of the duel players.", flags: 64 });
      if (res.reason === "no_active_map") return interaction.reply({ content: "❌ No active map to resolve.", flags: 64 });
      return interaction.reply({ content: "❌ Resolve failed.", flags: 64 });
    }

    return interaction.reply({ content: "✅ Resolved.", flags: 64 });
  },
};