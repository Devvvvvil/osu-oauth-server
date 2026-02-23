import { Client, GatewayIntentBits, Collection, Events } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import { startWebServer } from "./webServer.js";
import { handleDuelButton } from "./duelSystem.js";

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();

// ===== LOAD COMMANDS =====
const commandFiles = fs.readdirSync("./commands").filter((f) => f.endsWith(".js"));
for (const file of commandFiles) {
  const command = await import(`./commands/${file}`);
  client.commands.set(command.default.data.name, command.default);
}

// ===== READY =====
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Start OAuth server AFTER bot ready
  startWebServer(client);
});

// ===== INTERACTIONS =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Duel buttons
    if (interaction.isButton()) {
      if (interaction.customId?.startsWith("duel:")) {
        await handleDuelButton(interaction);
        return;
      }
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    await command.execute(interaction, client);
  } catch (e) {
    console.error(e);
    const msg = "❌ Error while running this interaction.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: 64 }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);