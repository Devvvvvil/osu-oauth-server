import { SlashCommandBuilder } from "discord.js";
import { addToQueue, tryMatchmakeAndCreate } from "../duelSystem.js";
import { getLinked } from "../osuAuth.js";

export default {
  data: new SlashCommandBuilder()
    .setName("duel")
    .setDescription("Join the duel queue (BO3)."),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: "❌ Use this in a server.", flags: 64 });
    }

    // ✅ Queue-room restriction
    if (process.env.DUEL_QUEUE_CHANNEL_ID && interaction.channelId !== process.env.DUEL_QUEUE_CHANNEL_ID) {
      return interaction.reply({ content: "❌ You can only queue in the duel-queue channel.", flags: 64 });
    }

    // ✅ Must be linked
    if (!getLinked(interaction.user.id)) {
      return interaction.reply({ content: "❌ You must link your osu first. Use **/connect**.", flags: 64 });
    }

    const res = addToQueue(interaction.user.id);
    if (!res.ok) {
      return interaction.reply({ content: "❌ You're already in the duel queue.", flags: 64 });
    }

    await interaction.reply({ content: `✅ Joined duel queue. Queue size: **${res.size}**`, flags: 64 });

    // Try match now
    const guild = await interaction.client.guilds.fetch(interaction.guildId);
    await tryMatchmakeAndCreate(interaction.client, guild);
  },
};