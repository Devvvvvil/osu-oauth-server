import { REST, Routes } from "discord.js";
import dotenv from "dotenv";

import r from "./commands/r.js";
import connect from "./commands/connect.js";
import profile from "./commands/profile.js";
import rankrole from "./commands/rankrole.js";

import duel from "./commands/duel.js";
import duelleave from "./commands/duelleave.js";
import resolve from "./commands/resolve.js";

dotenv.config();

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: [
    r.data.toJSON(),
    connect.data.toJSON(),
    profile.data.toJSON(),
    rankrole.data.toJSON(),
    duel.data.toJSON(),
    duelleave.data.toJSON(),
    resolve.data.toJSON(),
  ]}
);

console.log("✅ Commands deployed");