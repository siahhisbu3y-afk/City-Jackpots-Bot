const {
  Client, GatewayIntentBits, Partials, PermissionsBitField,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType,
} = require("discord.js");

const PREFIX = ",";
const TICKET_CATEGORY = "Tickets";
const STAFF_ROLE = "Staff";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const snipes = new Map();   // channelId -> {author, content, avatar}
const warnings = new Map(); // memberId -> [reasons]

client.once("ready", () => console.log(`🦫 Capybara is online as ${client.user.tag}`));

// ---------- SNIPE CAPTURE ----------
client.on("messageDelete", (message) => {
  if (!message.author || message.author.bot) return;
  snipes.set(message.channel.id, {
    author: message.author.tag,
    content: message.content || "*[no text content]*",
    avatar: message.author.displayAvatarURL(),
  });
});

// ---------- TICKET BUTTON HANDLING ----------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "capybara_open_ticket") {
    const guild = interaction.guild;
    let category = guild.channels.cache.find(
      (c) => c.name === TICKET_CATEGORY && c.type === ChannelType.GuildCategory
    );
    if (!category) category = await guild.channels.create({ name: TICKET_CATEGORY, type: ChannelType.GuildCategory });

    const channelName = `ticket-${interaction.user.username}`.toLowerCase();
    const existing = guild.channels.cache.find((c) => c.name === channelName);
    if (existing) {
      return interaction.reply({ content: `You already have a ticket: ${existing}`, ephemeral: true });
    }

    const staffRole = guild.roles.cache.find((r) => r.name === STAFF_ROLE);
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ];
    if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
    });

    const embed = new EmbedBuilder()
      .setTitle("🦫 Capybara Support Ticket")
      .setDescription(`Welcome ${interaction.user}! Staff will be with you shortly.\nExplain your issue below.`)
      .setColor(0x1abc9c);

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("capybara_close_ticket").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [closeRow] });
    return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
  }

  if (interaction.customId === "capybara_close_ticket") {
    await interaction.reply("Closing ticket in 5 seconds...");
    await interaction.channel.send(`🔒 Ticket closed by ${interaction.user}`);
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }
});

// ---------- COMMAND HANDLING ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const member = message.member;

  const need = (perm, name) => {
    if (!member.permissions.has(perm)) {
      message.reply(`❌ You need **${name}** permission to do that.`);
      return false;
    }
    return true;
  };

  try {
    switch (cmd) {
      case "help": {
        const embed = new EmbedBuilder()
          .setTitle("🦫 Capybara Bot Commands")
          .setColor(0x1abc9c)
          .addFields(
            { name: "Moderation", value: ",kick @user [reason]\n,ban @user [reason]\n,unban <id>\n,mute @user <minutes> [reason]\n,unmute @user\n,warn @user [reason]\n,warnings @user\n,clear <amount>\n,lock\n,unlock\n,slowmode <seconds>" },
            { name: "Tickets", value: ",ticketsetup — post the ticket panel (admin)" },
            { name: "Fun/Utility", value: ",s — snipe last deleted message" },
          );
        await message.channel.send({ embeds: [embed] });
        break;
      }

      case "ticketsetup": {
        if (!need(PermissionsBitField.Flags.ManageGuild, "Manage Server")) break;
        const embed = new EmbedBuilder()
          .setTitle("🦫 Capybara Ticket System")
          .setDescription("Need help? Click the button below to open a private ticket with staff.")
          .setColor(0x1abc9c)
          .setFooter({ text: "Capybara Bot • Support" });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("capybara_open_ticket").setLabel("Open Ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary)
        );
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
        break;
      }

      case "ban": {
        if (!need(PermissionsBitField.Flags.BanMembers, "Ban Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to ban.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await target.ban({ reason });
        message.channel.send(`🔨 **${target.user.tag}** was banned. Reason: ${reason}`);
        break;
      }

      case "unban": {
        if (!need(PermissionsBitField.Flags.BanMembers, "Ban Members")) break;
        const id = args[0];
        if (!id) return message.reply("❌ Provide a user ID to unban.");
        await message.guild.members.unban(id);
        message.channel.send(`✅ Unbanned user with ID **${id}**.`);
        break;
      }

      case "mute": {
        if (!need(PermissionsBitField.Flags.ModerateMembers, "Timeout Members")) break;
        const target = message.mentions.members.first();
        const minutes = parseInt(args[1]);
        if (!target || !minutes) return message.reply("❌ Usage: ,mute @user <minutes> [reason]");
        const reason = args.slice(2).join(" ") || "No reason provided";
        await target.timeout(minutes * 60 * 1000, reason);
        message.channel.send(`🔇 **${target.user.tag}** was muted for ${minutes}m. Reason: ${reason}`);
        break;
      }

      case "unmute": {
        if (!need(PermissionsBitField.Flags.ModerateMembers, "Timeout Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to unmute.");
        await target.timeout(null);
        message.channel.send(`🔊 **${target.user.tag}** was unmuted.`);
        break;
      }

      case "warn": {
        if (!need(PermissionsBitField.Flags.KickMembers, "Kick Members")) break;
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to warn.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        const list = warnings.get(target.id) || [];
        list.push(reason);
        warnings.set(target.id, list);
        message.channel.send(`⚠️ **${target.user.tag}** was warned. Reason: ${reason} (Total: ${list.length})`);
        break;
      }

      case "warnings": {
        const target = message.mentions.members.first();
        if (!target) return message.reply("❌ Mention a member to check.");
        const list = warnings.get(target.id) || [];
        if (!list.length) return message.channel.send(`**${target.user.tag}** has no warnings.`);
        message.channel.send(`⚠️ Warnings for **${target.user.tag}**:\n${list.map((w, i) => `${i + 1}. ${w}`).join("\n")}`);
        break;
      }

      case "clear": {
        if (!need(PermissionsBitField.Flags.ManageMessages, "Manage Messages")) break;
        const amount = parseInt(args[0]) || 5;
        const deleted = await message.channel.bulkDelete(amount + 1, true);
        const msg = await message.channel.send(`🧹 Cleared ${deleted.size - 1} messages.`);
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

      case "s": {
        const data = snipes.get(message.channel.id);
        if (!data) return message.channel.send("Nothing to snipe here.");
        const embed = new EmbedBuilder()
          .setDescription(data.content)
          .setAuthor({ name: data.author, iconURL: data.avatar })
          .setFooter({ text: "🦫 Capybara Snipe" })
          .setColor(0x1abc9c);
        message.channel.send({ embeds: [embed] });
        break;
      }
    }
  } catch (err) {
    console.error(err);
    message.reply(`⚠️ Error: ${err.message}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
