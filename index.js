const {
  Client, GatewayIntentBits, Partials, PermissionsBitField,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, AuditLogEvent,
} = require("discord.js");

const PREFIX = ",";
const TICKET_CATEGORY = "Tickets";
const STAFF_ROLE = "Staff";

// anti-raid/nuke thresholds
const RAID_JOINS = 6, RAID_WINDOW_MS = 10_000;      // 6 joins in 10s = raid
const NUKE_ACTIONS = 3, NUKE_WINDOW_MS = 10_000;    // 3 destructive actions in 10s = nuke
const MIN_ACCOUNT_AGE_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

// ---------- ALL DATA LIVES HERE (in-memory, resets on restart) ----------
const logChannels = new Map(); // guildId -> channelId
const snipes = new Map();      // channelId -> {author, content, avatar}
const warnings = new Map();    // userId -> [reasons]
const joinTimes = new Map();   // guildId -> [timestamps]
const actionTimes = new Map(); // "guildId-userId-type" -> [timestamps]
const lockedDown = new Set();  // guildIds currently in raid lockdown

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------- HELPERS ----------
async function log(guild, title, desc, color = 0x1abc9c) {
  const chId = logChannels.get(guild.id);
  if (!chId) return;
  const ch = guild.channels.cache.get(chId);
  if (!ch) return;
  const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

function hit(map, key, windowMs) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  map.set(key, arr);
  return arr.length;
}

async function getExecutor(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 1 });
    const entry = logs.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 15_000) return entry.executor;
  } catch { /* missing perms */ }
  return null;
}

async function punishNuker(guild, user, reason) {
  try {
    const member = await guild.members.fetch(user.id);
    if (member.bannable) await member.ban({ reason });
    else await member.roles.set([]);
  } catch { /* can't punish (e.g. owner) */ }
  log(guild, "🚨 Anti-Nuke Triggered", `${user.tag} was punished for: ${reason}`, 0xe74c3c);
}

// ---------- ANTI-RAID ----------
client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  log(guild, "📥 Member Joined", `${member.user.tag} (${member.id})`);

  const count = hit(joinTimes, guild.id, RAID_WINDOW_MS);
  const accountAge = Date.now() - member.user.createdTimestamp;

  if (count >= RAID_JOINS && !lockedDown.has(guild.id)) {
    lockedDown.add(guild.id);
    log(guild, "🚨 Raid Detected", `${count} joins in ${RAID_WINDOW_MS / 1000}s. Locking verification & kicking new accounts.`, 0xe74c3c);
    try { await guild.setVerificationLevel(4); } catch {}
    setTimeout(() => lockedDown.delete(guild.id), 60_000);
  }

  if (lockedDown.has(guild.id) && accountAge < MIN_ACCOUNT_AGE_MS) {
    member.kick("Anti-raid: new account during active raid").catch(() => {});
    log(guild, "👢 Raid Kick", `${member.user.tag} kicked (account too new).`, 0xe67e22);
  }
});

client.on("guildMemberRemove", (member) => {
  log(member.guild, "📤 Member Left", `${member.user.tag} (${member.id})`);
});

// ---------- ANTI-NUKE ----------
client.on("channelDelete", async (channel) => {
  const guild = channel.guild;
  log(guild, "🗑️ Channel Deleted", `#${channel.name}`, 0xe67e22);
  const exec = await getExecutor(guild, AuditLogEvent.ChannelDelete);
  if (!exec || exec.id === client.user.id || exec.id === guild.ownerId) return;
  if (hit(actionTimes, `${guild.id}-${exec.id}-chan`, NUKE_WINDOW_MS) >= NUKE_ACTIONS) {
    punishNuker(guild, exec, "Mass channel deletion");
  }
});

client.on("roleCreate", (role) => log(role.guild, "✨ Role Created", `@${role.name}`, 0x2ecc71));

client.on("guildMemberUpdate", (oldM, newM) => {
  const added = newM.roles.cache.filter((r) => !oldM.roles.cache.has(r.id));
  const removed = oldM.roles.cache.filter((r) => !newM.roles.cache.has(r.id));
  added.forEach((r) => log(newM.guild, "➕ Role Given", `${r} given to ${newM.user.tag}`, 0x2ecc71));
  removed.forEach((r) => log(newM.guild, "➖ Role Removed", `${r} removed from ${newM.user.tag}`, 0xe67e22));
});

client.on("roleDelete", async (role) => {
  const guild = role.guild;
  log(guild, "🗑️ Role Deleted", `@${role.name}`, 0xe67e22);
  const exec = await getExecutor(guild, AuditLogEvent.RoleDelete);
  if (!exec || exec.id === client.user.id || exec.id === guild.ownerId) return;
  if (hit(actionTimes, `${guild.id}-${exec.id}-role`, NUKE_WINDOW_MS) >= NUKE_ACTIONS) {
    punishNuker(guild, exec, "Mass role deletion");
  }
});

client.on("guildBanAdd", async (ban) => {
  const guild = ban.guild;
  log(guild, "🔨 Member Banned", `${ban.user.tag}`, 0xe67e22);
  const exec = await getExecutor(guild, AuditLogEvent.MemberBanAdd);
  if (!exec || exec.id === client.user.id || exec.id === guild.ownerId) return;
  if (hit(actionTimes, `${guild.id}-${exec.id}-ban`, NUKE_WINDOW_MS) >= NUKE_ACTIONS) {
    punishNuker(guild, exec, "Mass banning members");
  }
});

// ---------- SNIPE ----------
client.on("messageDelete", (message) => {
  if (!message.author || message.author.bot) return;
  snipes.set(message.channel.id, { author: message.author.tag, content: message.content || "*[no text content]*", avatar: message.author.displayAvatarURL() });
  log(message.guild, "✂️ Message Deleted", `**${message.author.tag}** in ${message.channel}: ${message.content || "*[no text]*"}`, 0x95a5a6);
});

// ---------- TICKET BUTTONS ----------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "capybara_open_ticket") {
    const guild = interaction.guild;
    let category = guild.channels.cache.find((c) => c.name === TICKET_CATEGORY && c.type === ChannelType.GuildCategory);
    if (!category) category = await guild.channels.create({ name: TICKET_CATEGORY, type: ChannelType.GuildCategory });

    const channelName = `ticket-${interaction.user.username}`.toLowerCase();
    if (guild.channels.cache.find((c) => c.name === channelName)) {
      return interaction.reply({ content: "You already have a ticket open.", ephemeral: true });
    }

    const staffRole = guild.roles.cache.find((r) => r.name === STAFF_ROLE);
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ];
    if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });

    const channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites });
    const embed = new EmbedBuilder().setTitle("🦫 Need Help?").setDescription(`Welcome ${interaction.user}! Staff will be with you shortly — describe your issue below.`).setColor(0x2b2d31);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("capybara_close_ticket").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger));
    await channel.send({ embeds: [embed], components: [row] });
    log(guild, "🎫 Ticket Opened", `${interaction.user.tag} opened ${channel}`);
    return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  }

  if (interaction.customId === "capybara_close_ticket") {
    await interaction.reply("Closing ticket in 5 seconds...");
    log(interaction.guild, "🔒 Ticket Closed", `${interaction.user.tag} closed ${interaction.channel.name}`);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

// ---------- AUTOMOD ----------
// Add whatever slurs/banned terms you want blocked to SLUR_LIST — left empty by default.
const SLUR_LIST = [];
const SEXUAL_WORDS = ["dick", "pussy", "cock", "cum", "porn", "nsfw"]; // cursing is NOT blocked, only explicit sexual terms
const INVITE_REGEX = /(discord\.gg\/|discord(app)?\.com\/invite\/)/i;

function automodCheck(content) {
  const lower = content.toLowerCase();
  if (INVITE_REGEX.test(lower)) return "Posting Discord invite links isn't allowed.";
  if ([...SEXUAL_WORDS, ...SLUR_LIST].some((w) => w && lower.includes(w))) return "Your message contained explicit or hateful language.";
  return null;
}

async function runAutomod(message) {
  if (message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return false;
  const reason = automodCheck(message.content);
  if (!reason) return false;

  await message.delete().catch(() => {});
  const list = warnings.get(message.author.id) || [];
  list.push(`Automod: ${reason}`);
  warnings.set(message.author.id, list);

  message.author.send(`⚠️ You were warned in **${message.guild.name}**.\nReason: ${reason}`).catch(() => {});
  log(message.guild, "🛡️ Automod Warn", `${message.author.tag} in ${message.channel}\nReason: ${reason}\nMessage: ${message.content}`, 0xe74c3c);
  return true;
}

// ---------- FUN COMMANDS (compact, shared handler) ----------
const funActions = {
  kill: ["{a} grabbed a rubber chicken and eliminated {b} 🍗💥", "{a} dropped an anvil on {b} 🪨💀", "{a} sent {b} into the shadow realm 🌑"],
  slap: ["{a} slapped {b} across the face 👋💥", "{a} smacked {b} with a fish 🐟"],
  hug: ["{a} wrapped {b} in a warm hug 🤗", "{a} gave {b} a big cozy hug 💞"],
  kiss: ["{a} kissed {b} 😘", "{a} planted a kiss on {b} 💋"],
  punch: ["{a} punched {b} straight in the face 🥊", "{a} threw hands with {b} 👊"],
  bite: ["{a} bit {b} out of nowhere 🦷", "{a} chomped down on {b} 😬"],
  pat: ["{a} gently patted {b} on the head 🖐️", "{a} pat pat {b} 🐾"],
};

async function handleFun(message, cmd, args) {
  const target = message.mentions.users.first() || message.author;
  const line = funActions[cmd][Math.floor(Math.random() * funActions[cmd].length)]
    .replace("{a}", `**${message.author.username}**`).replace("{b}", `**${target.username}**`);
  message.channel.send({ embeds: [new EmbedBuilder().setDescription(line).setColor(0x2b2d31)] });
}


client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (await runAutomod(message)) return;
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const member = message.member;
  const need = (perm, name) => {
    if (!member.permissions.has(perm)) { message.reply(`❌ You need **${name}** permission.`); return false; }
    return true;
  };

  try {
    if (funActions[cmd]) return handleFun(message, cmd, args);

    switch (cmd) {
      case "help": {
        const embed = new EmbedBuilder().setTitle("🦫 Capybara Bot Commands").setColor(0x1abc9c).addFields(
          { name: "Moderation", value: ",kick @user [reason]\n,ban @user [reason]\n,unban <id>\n,mute @user <minutes> [reason]\n,unmute @user\n,warn @user [reason]\n,warnings @user\n,purge <amount> [@user]\n,lock\n,unlock\n,slowmode <seconds>\n,nick @user <name>" },
          { name: "Tickets", value: ",ticketsetup — post ticket panel (admin)" },
          { name: "Security", value: ",setlogs #channel — set log channel (admin)\nAnti-raid & anti-nuke run automatically." },
          { name: "Utility", value: ",say <message>\n,ping\n,userinfo @user\n,serverinfo\n,avatar @user\n,announce <message>\n,s — snipe last deleted message" },
          { name: "Fun", value: ",kill @user\n,slap @user\n,hug @user\n,kiss @user\n,punch @user\n,bite @user\n,pat @user" },
        );
        await message.channel.send({ embeds: [embed] });
        break;
      }
      case "setlogs": {
        if (!need(PermissionsBitField.Flags.ManageGuild, "Manage Server")) break;
        const ch = message.mentions.channels.first();
        if (!ch) return message.reply("❌ Mention a channel: ,setlogs #logs");
        logChannels.set(message.guild.id, ch.id);
        message.channel.send(`✅ Logs will be sent to ${ch}.`);
        break;
      }
      case "ticketsetup": {
        if (!need(PermissionsBitField.Flags.ManageGuild, "Manage Server")) break;
        const embed = new EmbedBuilder()
          .setTitle("Need Help?")
          .setDescription("Click the button below to open a private ticket.")
          .setColor(0x2b2d31)
          .setFooter({ text: "🦫 Capybara" });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("capybara_open_ticket").setLabel("Open a ticket").setStyle(ButtonStyle.Primary));
        await message.channel.send({ embeds: [embed], components: [row] });
        break;
      }
      case "kick": {
        if (!need(PermissionsBitField.Flags.KickMembers, "Kick Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to kick.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await target.kick(reason);
        message.channel.send(`👢 **${target.user.tag}** was kicked. Reason: ${reason}`);
        log(message.guild, "👢 Kick", `${target.user.tag} kicked by ${message.author.tag}\nReason: ${reason}`, 0xe67e22);
        break;
      }
      case "ban": {
        if (!need(PermissionsBitField.Flags.BanMembers, "Ban Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to ban.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await target.ban({ reason });
        message.channel.send(`🔨 **${target.user.tag}** was banned. Reason: ${reason}`);
        log(message.guild, "🔨 Ban", `${target.user.tag} banned by ${message.author.tag}\nReason: ${reason}`, 0xe74c3c);
        break;
      }
      case "unban": {
        if (!need(PermissionsBitField.Flags.BanMembers, "Ban Members")) break;
        const id = args[0];
        if (!id) return message.reply("❌ Provide a user ID.");
        await message.guild.members.unban(id);
        message.channel.send(`✅ Unbanned **${id}**.`);
        log(message.guild, "✅ Unban", `${id} unbanned by ${message.author.tag}`);
        break;
      }
      case "mute": {
        if (!need(PermissionsBitField.Flags.ModerateMembers, "Timeout Members")) break;
        const target = message.mentions.members.first();
        const minutes = parseInt(args[1]);
        if (!target || !minutes) return message.reply("❌ Usage: ,mute @user <minutes> [reason]");
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.timeout(minutes * 60 * 1000, reason);
        message.channel.send(`🔇 **${target.user.tag}** muted for ${minutes}m. Reason: ${reason}`);
        log(message.guild, "🔇 Mute", `${target.user.tag} muted for ${minutes}m by ${message.author.tag}`, 0xe67e22);
        break;
      }
      case "unmute": {
        if (!need(PermissionsBitField.Flags.ModerateMembers, "Timeout Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member.");
        await target.timeout(null);
        message.channel.send(`🔊 **${target.user.tag}** unmuted.`);
        break;
      }
      case "warn": {
        if (!need(PermissionsBitField.Flags.KickMembers, "Kick Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        const list = warnings.get(target.id) || [];
        list.push(reason);
        warnings.set(target.id, list);
        message.channel.send(`⚠️ **${target.user.tag}** warned. Reason: ${reason} (Total: ${list.length})`);
        log(message.guild, "⚠️ Warn", `${target.user.tag} warned by ${message.author.tag}\nReason: ${reason}`, 0xf1c40f);
        break;
      }
      case "warnings": {
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member.");
        const list = warnings.get(target.id) || [];
        message.channel.send(list.length ? `⚠️ Warnings for **${target.user.tag}**:\n${list.map((w, i) => `${i + 1}. ${w}`).join("\n")}` : `**${target.user.tag}** has no warnings.`);
        break;
      }
      case "purge":
      case "clear": {
        if (!need(PermissionsBitField.Flags.ManageMessages, "Manage Messages")) break;
        const amount = parseInt(args[0]) || 5;
        const target = message.mentions.members.first();
        const fetched = await message.channel.messages.fetch({ limit: Math.min(amount + 1, 100) });
        const toDelete = target ? fetched.filter((m) => m.author.id === target.id) : fetched;
        const deleted = await message.channel.bulkDelete(toDelete, true);
        const msg = await message.channel.send(`🧹 Purged ${deleted.size} message(s)${target ? ` from **${target.user.tag}**` : ""}.`);
        log(message.guild, "🧹 Purge", `${message.author.tag} purged ${deleted.size} message(s) in ${message.channel}${target ? ` from ${target.user.tag}` : ""}`, 0x95a5a6);
        setTimeout(() => msg.delete().catch(() => {}), 3000);
        break;
      }
      case "lock": {
        if (!need(PermissionsBitField.Flags.ManageChannels, "Manage Channels")) break;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        message.channel.send("🔒 Channel locked.");
        break;
      }
      case "unlock": {
        if (!need(PermissionsBitField.Flags.ManageChannels, "Manage Channels")) break;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });
        message.channel.send("🔓 Channel unlocked.");
        break;
      }
      case "slowmode": {
        if (!need(PermissionsBitField.Flags.ManageChannels, "Manage Channels")) break;
        const seconds = parseInt(args[0]);
        if (isNaN(seconds)) return message.reply("❌ Usage: ,slowmode <seconds>");
        await message.channel.setRateLimitPerUser(seconds);
        message.channel.send(`🐌 Slowmode set to ${seconds}s.`);
        break;
      }
      case "nick": {
        if (!need(PermissionsBitField.Flags.ManageNicknames, "Manage Nicknames")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Usage: ,nick @user <new name>");
        const newNick = args.slice(1).join(" ") || null;
        await target.setNickname(newNick);
        message.channel.send(`✏️ Nickname updated for **${target.user.tag}**.`);
        break;
      }
      case "announce": {
        if (!need(PermissionsBitField.Flags.ManageGuild, "Manage Server")) break;
        const text = args.join(" ");
        if (!text) return message.reply("❌ Usage: ,announce <message>");
        const embed = new EmbedBuilder().setTitle("📢 Announcement").setDescription(text).setColor(0x1abc9c).setFooter({ text: `By ${message.author.tag}` });
        message.channel.send({ embeds: [embed] });
        message.delete().catch(() => {});
        break;
      }
      case "say": {
        if (!need(PermissionsBitField.Flags.ManageMessages, "Manage Messages")) break;
        const text = args.join(" ");
        if (!text) return message.reply("❌ Usage: ,say <message>");
        message.delete().catch(() => {});
        message.channel.send(text);
        log(message.guild, "💬 Say Used", `${message.author.tag} in ${message.channel}: ${text}`, 0x95a5a6);
        break;
      }
      case "ping": {
        message.channel.send(`🏓 Pong! Latency: ${Date.now() - message.createdTimestamp}ms | API: ${Math.round(client.ws.ping)}ms`);
        break;
      }
      case "avatar": {
        const target = message.mentions.users.first() || message.author;
        const embed = new EmbedBuilder().setTitle(`${target.tag}'s Avatar`).setImage(target.displayAvatarURL({ size: 512 })).setColor(0x1abc9c);
        message.channel.send({ embeds: [embed] });
        break;
      }
      case "userinfo": {
        const target = message.mentions.members.first() || member;
        const embed = new EmbedBuilder()
          .setTitle(`👤 ${target.user.tag}`)
          .setThumbnail(target.user.displayAvatarURL())
          .addFields(
            { name: "ID", value: target.id, inline: true },
            { name: "Joined Server", value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
            { name: "Account Created", value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: "Roles", value: target.roles.cache.map((r) => r.toString()).filter((r) => r !== "@everyone").join(", ") || "None" },
          ).setColor(0x1abc9c);
        message.channel.send({ embeds: [embed] });
        break;
      }
      case "serverinfo": {
        const g = message.guild;
        const embed = new EmbedBuilder()
          .setTitle(`🏰 ${g.name}`)
          .setThumbnail(g.iconURL())
          .addFields(
            { name: "Members", value: `${g.memberCount}`, inline: true },
            { name: "Channels", value: `${g.channels.cache.size}`, inline: true },
            { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
            { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
            { name: "Owner", value: `<@${g.ownerId}>`, inline: true },
          ).setColor(0x1abc9c);
        message.channel.send({ embeds: [embed] });
        break;
      }
      case "s": {
        const d = snipes.get(message.channel.id);
        if (!d) return message.channel.send("Nothing to snipe here.");
        const embed = new EmbedBuilder().setDescription(d.content).setAuthor({ name: d.author, iconURL: d.avatar }).setFooter({ text: "🦫 Capybara Snipe" }).setColor(0x1abc9c);
        message.channel.send({ embeds: [embed] });
        break;
      }
    }
  } catch (err) {
    console.error(err);
    message.reply(`⚠️ Error: ${err.message}`);
  }
});

client.once("ready", () => {
  console.log(`🦫 Capybara is online as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "Join Afterhours Today! 🦫", type: 3 }], // type 3 = Watching
    status: "online",
  });
});
client.login(process.env.DISCORD_TOKEN);
