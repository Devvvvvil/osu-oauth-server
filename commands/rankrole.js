import { SlashCommandBuilder } from "discord.js";
import { syncOsuDigitRole } from "../rankRoles.js";

export default {
  data: new SlashCommandBuilder()
    .setName("rankrole")
    .setDescription("Refresh your osu digit role (2D–7D)"),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 }); // ephemeral

    const res = await syncOsuDigitRole(interaction.client, interaction.user.id);

    if (!res?.ok) {
      if (res?.reason === "not_linked") {
        return interaction.editReply("❌ You are not linked yet. Use **/connect** first.");
      }
      if (res?.reason === "no_rank") {
        return interaction.editReply("❌ Could not read your rank from osu. Try again.");
      }
      return interaction.editReply("❌ Failed to update your role. Make sure the bot has **Manage Roles** and its role is above the digit roles.");
    }

    return interaction.editReply(`✅ Updated! Your global rank is **#${Number(res.rank).toLocaleString()}**.`);
  },
};