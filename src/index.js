require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const store = require('./store');
const rolimons = require('./rolimons');
const rolimonsApi = require('./rolimons-api');
const { TRADE_TAGS } = require('./constants');
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (bot stayed alive):', err);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// Keep open browser sessions in memory between /startlogin and /confirm,
// keyed by Discord user ID. These are temporary, not the saved long-term
// session (that gets written to disk only after a successful /confirm).
const pendingVerifications = new Map();

// Tracks active /start posting loops so /stop can cancel them.
const activeLoops = new Map();

const ERRORS_CHANNEL_ID = process.env.ERRORS_CHANNEL_ID;
const SUCCESS_CHANNEL_ID = process.env.SUCCESS_CHANNEL_ID;

async function postError(guild, userId, message) {
  const channel = guild.channels.cache.get(ERRORS_CHANNEL_ID);
  if (!channel) {
    console.error('ERRORS_CHANNEL_ID not found in this server. Check your .env file.');
    return;
  }
  await channel.send(`<@${userId}> ${message}`);
}

async function postSuccess(guild, robloxUsername) {
  const channel = guild.channels.cache.get(SUCCESS_CHANNEL_ID);
  if (!channel) {
    console.error('SUCCESS_CHANNEL_ID not found in this server. Check your .env file.');
    return;
  }
  await channel.send(`✅ Posted trade ad for **${robloxUsername}**`);
}

// Starts a posting loop for a given Discord user ID + their stored user
// record. Shared by /start (self) and /forcestart (admin, on someone
// else's behalf). Returns { ok: true } or { ok: false, reason }.
function startPostingLoop(targetDiscordId, targetUser, guild) {
  if (activeLoops.has(targetDiscordId)) {
    return { ok: false, reason: 'already_running' };
  }
  if (!rolimons.hasSession(targetDiscordId)) {
    return { ok: false, reason: 'not_logged_in' };
  }

  const adConfig = targetUser.adConfig;
  if (!adConfig || !adConfig.offer || adConfig.offer.length === 0) {
    return { ok: false, reason: 'no_offer' };
  }
  const reqCount = (adConfig.request || []).length + (adConfig.tags || []).length;
  if (reqCount > 4) {
    return { ok: false, reason: 'too_many_slots' };
  }

  const cooldownMs = (adConfig.cooldownMinutes || 15) * 60 * 1000;

  const runPost = async () => {
    const playerId = await rolimonsApi.getPlayerIdByUsername(targetUser.robloxUsername);
    const result = await rolimonsApi.postTradeAd(targetDiscordId, {
      offerItemIds: adConfig.offer.map(i => i.id),
      requestItemIds: (adConfig.request || []).map(i => i.id),
      requestTags: adConfig.tags || [],
      robux: adConfig.robux || 0,
    }, playerId);

    if (result.ok) {
      await postSuccess(guild, targetUser.robloxUsername);
    } else {
      const messages = {
        daily_limit: '24 hour ad creation limit has been hit',
        cooldown: 'your cooldown time has not been reached',
        missing_items: 'player does not have all offered items',
        logged_out: 'user logged out, please log back in',
        not_logged_in: 'user logged out, please log back in',
        unknown: 'your trade ad had an unknown error',
      };
      await postError(guild, targetDiscordId, messages[result.reason] || messages.unknown);

      if (result.reason === 'logged_out' || result.reason === 'not_logged_in') {
        clearInterval(activeLoops.get(targetDiscordId));
        activeLoops.delete(targetDiscordId);
      }
    }
  };

  runPost(); // post once immediately
  const intervalHandle = setInterval(runPost, cooldownMs);
  activeLoops.set(targetDiscordId, intervalHandle);
  return { ok: true, cooldownMinutes: adConfig.cooldownMinutes || 15 };
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Auto-stop a user's posting loop if they leave the server.
client.on('guildMemberRemove', (member) => {
  const handle = activeLoops.get(member.id);
  if (handle) {
    clearInterval(handle);
    activeLoops.delete(member.id);
    console.log(`Stopped posting loop for ${member.id} (left the server).`);
  }
});

// ---------- Autocomplete (live suggestions while typing in a slot) ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (interaction.commandName !== 'create') return;

  const discordId = interaction.user.id;
  const adPart = interaction.options.getString('ad_part');
  const focused = interaction.options.getFocused();

  try {
    if (adPart === 'offer') {
      const user = store.getUser(discordId);
      if (!user) {
        return interaction.respond([{ name: 'Log in first with /startlogin', value: '' }]);
      }
      const inventory = await rolimonsApi.getPlayerInventory(user.robloxUsername);
      const matches = inventory
        .filter(item => item.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      if (matches.length === 0) {
        return interaction.respond([{ name: 'No options match your search', value: '' }]);
      }
      return interaction.respond(
        matches.map(item => ({
          name: `${item.name} (${item.acronym || '—'})`,
          value: String(item.instanceId),
        }))
      );
    }

    if (adPart === 'request') {
      const matches = await rolimonsApi.searchItemCatalog(focused);
      const options = [{ name: 'none (clear request items)', value: 'NONE' }, ...matches];
      if (matches.length === 0 && focused) {
        return interaction.respond([
          { name: 'none (clear request items)', value: 'NONE' },
          { name: 'No other options match your search', value: '' },
        ]);
      }
      return interaction.respond(
        options.slice(0, 25).map(item =>
          item.value === 'NONE' || item.value === ''
            ? item
            : { name: `${item.name} (${item.acronym || '—'})`, value: item.id }
        )
      );
    }

    if (adPart === 'tags') {
      const matches = TRADE_TAGS.filter(tag => tag.includes(focused.toLowerCase()));
      const options = [{ name: 'none (clear tags)', value: 'NONE' }, ...matches.map(tag => ({ name: tag, value: tag }))];
      return interaction.respond(options.slice(0, 25));
    }

    // robux / cooldown don't use slots, nothing to autocomplete.
    return interaction.respond([]);
  } catch (err) {
    console.error('autocomplete error:', err);
    return interaction.respond([]).catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const discordId = interaction.user.id;

  // ---------- /startlogin ----------
  if (interaction.commandName === 'startlogin') {
    const robloxUsername = interaction.options.getString('roblox_username');

    if (!robloxUsername || robloxUsername.trim().length === 0) {
      return interaction.reply({
        content: '❌ Please enter your Roblox username.',
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: '🔄 Starting login... this can take a few seconds.',
      ephemeral: true,
    });

    try {
      const { browser, context, page, phrase } = await rolimons.startVerification(robloxUsername);

      // Store the open browser so /confirm can reuse it.
      pendingVerifications.set(discordId, { browser, context, page, robloxUsername });

      await interaction.followUp({
        content:
          `**Here's your phrase — put this in your Roblox profile "About" section:**\n\n` +
          `\`${phrase}\`\n\n` +
          `Once it's saved on your profile, come back and run **/confirm**.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error('startlogin error:', err);
      await interaction.followUp({
        content: '❌ Something went wrong starting verification. Please try again in a moment.',
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- /confirm ----------
  if (interaction.commandName === 'confirm') {
    const pending = pendingVerifications.get(discordId);

    if (!pending) {
      return interaction.reply({
        content: '❌ You haven\'t started a login. Run **/startlogin** first.',
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: '🔄 Checking your profile...',
      ephemeral: true,
    });

    const { browser, context, page, robloxUsername } = pending;
    const success = await rolimons.confirmVerification(discordId, page, context, browser);
    pendingVerifications.delete(discordId);

    if (success) {
      store.setUser(discordId, { robloxUsername, verifiedAt: Date.now() });
      await interaction.followUp({
        content: '✅ You\'re verified and logged in! You can now use **/create** to make a trade ad.',
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content:
          '❌ Verification failed. Make sure the exact phrase is saved in your Roblox bio, ' +
          'then run **/startlogin** again to get a fresh phrase.',
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- /status ----------
  if (interaction.commandName === 'status') {
    const hasSession = rolimons.hasSession(discordId);
    const user = store.getUser(discordId);

    if (hasSession && user) {
      await interaction.reply({
        content: `✅ You're logged in (Roblox username: ${user.robloxUsername}).`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: '❌ You\'re not logged in. Run **/startlogin** to begin.',
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- /logout ----------
  if (interaction.commandName === 'logout') {
    const fs = require('fs');
    const path = require('path');
    const sessionPath = path.join(__dirname, '..', 'sessions', `${discordId}.json`);
    const sessionPath = path.join(__dirname, '..', 'storage', 'sessions', `${discordId}.json`);
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    store.deleteUser(discordId);

    await interaction.reply({
      content: '✅ You\'ve been logged out. Your saved session has been deleted.',
      ephemeral: true,
    });
    return;
  }
  // ---------- /create ----------
  if (interaction.commandName === 'create') {
    const user = store.getUser(discordId);
    if (!user) {
      return interaction.reply({
        content: '❌ You need to log in first. Run **/startlogin** to begin.',
        ephemeral: true,
      });
    }

    const adPart = interaction.options.getString('ad_part');
    const rawSlots = [1, 2, 3, 4].map(i => interaction.options.getString(`slot${i}`));

    // "NONE" is our explicit clear-this-part option from autocomplete.
    // If picked in any slot, treat it as "clear request/tags entirely",
    // ignoring whatever (if anything) is in the other slots.
    if (rawSlots.includes('NONE')) {
      const adConfig = user.adConfig || { offer: [], request: [], tags: [], robux: 0, cooldownMinutes: 15 };
      if (adPart === 'request') {
        adConfig.request = [];
        store.setUser(discordId, { adConfig });
        return interaction.reply({ content: '✅ Request items cleared.', ephemeral: true });
      }
      if (adPart === 'tags') {
        adConfig.tags = [];
        store.setUser(discordId, { adConfig });
        return interaction.reply({ content: '✅ Tags cleared.', ephemeral: true });
      }
    }

    const slots = rawSlots.filter(Boolean);
    const amount = interaction.options.getInteger('amount');

    const adConfig = user.adConfig || { offer: [], request: [], tags: [], robux: 0, cooldownMinutes: 15 };

    if (adPart === 'offer') {
      if (slots.length === 0) {
        return interaction.reply({
          content: '❌ You need at least 1 item in your offer. Pick from the slot1-4 suggestions.',
          ephemeral: true,
        });
      }
      if (slots.length > 4) {
        return interaction.reply({
          content: '❌ Offer can have at most 4 items.',
          ephemeral: true,
        });
      }

      const inventory = await rolimonsApi.getPlayerInventory(user.robloxUsername);
      const chosen = slots.map(val => inventory.find(item => String(item.instanceId) === val)).filter(Boolean);

      if (chosen.length !== slots.length) {
        return interaction.reply({
          content: '❌ One or more items weren\'t recognized. Please pick directly from the autocomplete suggestions.',
          ephemeral: true,
        });
      }

      adConfig.offer = chosen;
      store.setUser(discordId, { adConfig });

      return interaction.reply({
        content: `✅ Offer set to: ${chosen.map(i => `${i.name} (${i.acronym})`).join(', ')}`,
        ephemeral: true,
      });
    }

    if (adPart === 'request' || adPart === 'tags') {
      // Request items and tags share a combined max of 4 slots. Each
      // /create call fully replaces THIS part (request or tags), but we
      // must check against whatever's currently saved in the OTHER part.
      const otherPart = adPart === 'request' ? 'tags' : 'request';
      const otherCount = (adConfig[otherPart] || []).length;

      if (slots.length + otherCount > 4) {
        return interaction.reply({
          content:
            `❌ Too many items/tags. Request items and tags share a maximum of 4 slots combined ` +
            `(you currently have ${otherCount} ${otherPart} saved, so this part can use at most ${4 - otherCount}).`,
          ephemeral: true,
        });
      }

      if (adPart === 'request') {
        const fullCatalog = await rolimonsApi.getItemCatalog();
        const chosen = slots
          .map(id => fullCatalog.find(item => item.id === id))
          .filter(Boolean);

        if (chosen.length !== slots.length) {
          return interaction.reply({
            content: '❌ One or more items weren\'t recognized. Please pick directly from the autocomplete suggestions.',
            ephemeral: true,
          });
        }

        adConfig.request = chosen;
        store.setUser(discordId, { adConfig });

        return interaction.reply({
          content: `✅ Request items set to: ${chosen.map(i => `${i.name} (${i.acronym})`).join(', ') || '(none)'}`,
          ephemeral: true,
        });
      }

      if (adPart === 'tags') {
        const invalid = slots.filter(t => !TRADE_TAGS.includes(t.toLowerCase()));
        if (invalid.length > 0) {
          return interaction.reply({
            content: `❌ Unknown tag(s): ${invalid.join(', ')}. Valid tags: ${TRADE_TAGS.join(', ')}`,
            ephemeral: true,
          });
        }

        adConfig.tags = slots.map(t => t.toLowerCase());
        store.setUser(discordId, { adConfig });

        return interaction.reply({
          content: `✅ Tags set to: ${adConfig.tags.join(', ') || '(none)'}`,
          ephemeral: true,
        });
      }
    }

    if (adPart === 'robux') {
      if (amount === null) {
        return interaction.reply({
          content: '❌ Please provide the `amount` option with how much robux to offer (0 to remove).',
          ephemeral: true,
        });
      }
      if (amount < 0) {
        return interaction.reply({ content: '❌ Robux amount can\'t be negative.', ephemeral: true });
      }

      adConfig.robux = amount;
      store.setUser(discordId, { adConfig });

      return interaction.reply({
        content: amount === 0
          ? '✅ Robux offer removed from your ad.'
          : `✅ Offering ${amount} robux added to your ad.`,
        ephemeral: true,
      });
    }

    if (adPart === 'cooldown') {
      if (amount === null) {
        return interaction.reply({
          content: '❌ Please provide the `amount` option with your cooldown in minutes (minimum 15).',
          ephemeral: true,
        });
      }
      if (amount < 15) {
        return interaction.reply({
          content: '❌ The minimum cooldown is 15 minutes.',
          ephemeral: true,
        });
      }

      adConfig.cooldownMinutes = amount;
      store.setUser(discordId, { adConfig });

      return interaction.reply({
        content: `✅ Cooldown set to ${amount} minutes.`,
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- /myad ----------
  if (interaction.commandName === 'myad') {
    const user = store.getUser(discordId);
    if (!user || !user.adConfig) {
      return interaction.reply({
        content: 'You haven\'t set up an ad yet. Use **/create** to get started.',
        ephemeral: true,
      });
    }

    const c = user.adConfig;
    const lines = [
      `**Offer:** ${c.offer?.length ? c.offer.map(i => `${i.name} (${i.acronym})`).join(', ') : '(none)'}`,
      `**Request items:** ${c.request?.length ? c.request.map(i => `${i.name} (${i.acronym})`).join(', ') : '(none)'}`,
      `**Tags:** ${c.tags?.length ? c.tags.join(', ') : '(none)'}`,
      `**Robux:** ${c.robux || 0}`,
      `**Cooldown:** ${c.cooldownMinutes || 15} minutes`,
    ];

    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  // ---------- /viewad ----------
  if (interaction.commandName === 'viewad') {
    const user = store.getUser(discordId);
    if (!user || !user.adConfig) {
      return interaction.reply({
        content: 'You haven\'t set up an ad yet. Use **/create** to get started.',
        ephemeral: true,
      });
    }

    const c = user.adConfig;
    const offerStr = c.offer?.length ? c.offer.map(i => `${i.name} (${i.acronym})`).join(', ') : 'none';
    const requestStr = c.request?.length ? c.request.map(i => `${i.name} (${i.acronym})`).join(', ') : 'none';
    const tagsStr = c.tags?.length ? c.tags.join(', ') : 'none';

    const lines = [
      `offer: ${offerStr}`,
      `request: ${requestStr}`,
      `tags: ${tagsStr}`,
      `robux: ${c.robux || 0}`,
      `cooldown: ${c.cooldownMinutes || 15}`,
    ];

    return interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', ephemeral: true });
  }

  // ---------- /start ----------
  if (interaction.commandName === 'start') {
    const user = store.getUser(discordId);
    if (!user || !rolimons.hasSession(discordId)) {
      return interaction.reply({
        content: '❌ You need to log in first. Run **/startlogin** to begin.',
        ephemeral: true,
      });
    }

    const result = startPostingLoop(discordId, user, interaction.guild);
    const errorMessages = {
      already_running: '⚠️ You already have posting running. Use **/stop** first if you want to change anything.',
      not_logged_in: '❌ You need to log in first. Run **/startlogin** to begin.',
      no_offer: '❌ You need at least 1 offer item set up. Use **/create** first.',
      too_many_slots: '❌ Your request items + tags exceed 4 combined. Fix this with **/create** before starting.',
    };

    if (!result.ok) {
      return interaction.reply({ content: errorMessages[result.reason], ephemeral: true });
    }

    return interaction.reply({
      content: `✅ Started! Your ad will post every ${result.cooldownMinutes} minutes. Use **/stop** to cancel.`,
      ephemeral: true,
    });
  }

  // ---------- /stop ----------
  if (interaction.commandName === 'stop') {
    const handle = activeLoops.get(discordId);
    if (!handle) {
      return interaction.reply({
        content: 'You don\'t have automatic posting running right now.',
        ephemeral: true,
      });
    }

    clearInterval(handle);
    activeLoops.delete(discordId);

    return interaction.reply({ content: '✅ Stopped automatic posting.', ephemeral: true });
  }

  // ---------- /forcestop (admin) ----------
  if (interaction.commandName === 'forcestop') {
    const targetUser = interaction.options.getUser('user');
    const handle = activeLoops.get(targetUser.id);

    if (!handle) {
      return interaction.reply({
        content: `${targetUser.username} doesn't have automatic posting running right now.`,
        ephemeral: true,
      });
    }

    clearInterval(handle);
    activeLoops.delete(targetUser.id);

    return interaction.reply({
      content: `✅ Stopped automatic posting for ${targetUser.username}.`,
      ephemeral: true,
    });
  }

  // ---------- /forcestart (admin) ----------
  if (interaction.commandName === 'forcestart') {
    const targetUser = interaction.options.getUser('user');
    const targetUserData = store.getUser(targetUser.id);

    if (!targetUserData) {
      return interaction.reply({
        content: `❌ ${targetUser.username} hasn't logged in yet (no /startlogin completed).`,
        ephemeral: true,
      });
    }

    const result = startPostingLoop(targetUser.id, targetUserData, interaction.guild);
    const errorMessages = {
      already_running: `⚠️ ${targetUser.username} already has posting running.`,
      not_logged_in: `❌ ${targetUser.username} needs to log in again (session expired or missing).`,
      no_offer: `❌ ${targetUser.username} doesn't have an offer item set up.`,
      too_many_slots: `❌ ${targetUser.username}'s request items + tags exceed 4 combined.`,
    };

    if (!result.ok) {
      return interaction.reply({ content: errorMessages[result.reason], ephemeral: true });
    }

    return interaction.reply({
      content: `✅ Started posting for ${targetUser.username}, every ${result.cooldownMinutes} minutes.`,
      ephemeral: true,
    });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
