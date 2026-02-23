import { SlashCommandBuilder } from "discord.js";
import { removeFromQueue } from "../duelSystem.js";

export default {
  data: new SlashCommandBuilder()
    .setName("duelleave")
    .setDescription("Leave the duel queue."),

  async execute(interaction) {
    if (process.env.DUEL_QUEUE_CHANNEL_ID && interaction.channelId !== process.env.DUEL_QUEUE_CHANNEL_ID) {
      return interaction.reply({ content: "❌ Use this only in the duel-queue channel.", flags: 64 });
    }

    const res = removeFromQueue(interaction.user.id);
    if (!res.ok) return interaction.reply({ content: "❌ You're not in the queue.", flags: 64 });

    return interaction.reply({ content: `✅ Left duel queue. Queue size: **${res.size}**`, flags: 64 });
  },
};