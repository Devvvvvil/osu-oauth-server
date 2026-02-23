import express from "express";
import dotenv from "dotenv";
import { consumeState, exchangeCodeForToken, saveLinked, osuApiGet } from "./osuAuth.js";

dotenv.config();

const app = express();

app.get("/", (req, res) => {
  res.send("osu OAuth server running ✅");
});

app.get("/osu/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send("Missing code/state.");
    }

    const discordId = consumeState(String(state));
    if (!discordId) {
      return res.status(400).send("Invalid/expired state. Run /connect again.");
    }

    const token = await exchangeCodeForToken(String(code));

    const link = {
      discord_id: discordId,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      linked_at: Date.now(),
    };

    const me = await osuApiGet(link, "/me/osu");
    link.osu_user_id = me.id;
    link.osu_username = me.username;

    saveLinked(discordId, link);

    return res.send(`
      <html>
        <body style="font-family: Arial; padding: 20px;">
          <h2>✅ Linked successfully!</h2>
          <p>You linked osu! account: <b>${me.username}</b></p>
          <p>You can now go back to Discord and use <b>/profile</b>.</p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error during linking.");
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🌐 OAuth server running on port ${port}`);
});