import express from "express";
import {
  consumeState,
  exchangeCodeForToken,
  saveLinked,
  osuApiGet,
} from "./osuAuth.js";



export function startWebServer() {
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
        return res.status(400).send("Invalid/expired state.");
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
        <h2>✅ Linked successfully!</h2>
        <p>You linked osu account: <b>${me.username}</b></p>
        <p>You can return to Discord.</p>
      `);
    } catch (e) {
      console.error(e);
      return res.status(500).send("OAuth error.");
    }
  });

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log("🌐 OAuth server running on port", port);
  });
}