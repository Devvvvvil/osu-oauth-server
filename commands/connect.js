import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { createState, getConnectUrl } from "../osuAuth.js";

export default {
  data: new SlashCommandBuilder()
    .setName("connect")
    .setDescription("Connect your osu! profile (OAuth link)"),

  async execute(interaction) {
    const state = createState(interaction.user.id);
    const url = getConnectUrl(state);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url)
        .setLabel("Link your osu! account")
    );

    await interaction.reply({
      content: "Click the button to link your osu! account:",
      components: [row],
      flags: 64, // ephemeral
    });
  },
};