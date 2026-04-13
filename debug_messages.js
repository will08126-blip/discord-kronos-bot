const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const configPath = path.join(__dirname, 'paper_analysis_config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { token, channelId } = config.discord;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const channel = await client.channels.fetch(channelId);
    const messages = await channel.messages.fetch({ limit: 20 });
    console.log(`\nLast 20 messages in #${channel.name}:\n`);
    messages.forEach((msg, idx) => {
      console.log(`--- Message ${idx + 1} ---`);
      console.log(`Author: ${msg.author.tag}`);
      console.log(`Content: ${msg.content}`);
      if (msg.embeds && msg.embeds.length > 0) {
        console.log(`Embeds: ${msg.embeds.length}`);
        msg.embeds.forEach((emb, i) => {
          console.log(`  Embed ${i + 1}:`);
          console.log(`    Title: ${emb.title}`);
          console.log(`    Description: ${emb.description}`);
          console.log(`    Fields: ${JSON.stringify(emb.fields)}`);
        });
      }
      console.log('');
    });
  } catch (err) {
    console.error(err);
  } finally {
    await client.destroy();
  }
});

client.login(token).catch(err => console.error(err));