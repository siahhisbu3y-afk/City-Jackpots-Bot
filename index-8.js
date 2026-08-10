const {
  Client, GatewayIntentBits, Partials, PermissionsBitField,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, AuditLogEvent,
} = require("discord.js");

const fetch = globalThis.fetch || require("node-fetch"); // works on any Node version

const PREFIX = ",";
const TICKET_CATEGORY = "Tickets";
const STAFF_ROLE = "Staff";

// anti-raid/nuke thresholds
const RAID_JOINS = 6, RAID_WINDOW_MS = 10_000;      // 6 joins in 10s = raid
const NUKE_ACTIONS = 3, NUKE_WINDOW_MS = 10_000;    // 3 destructive actions in 10s = nuke
const MIN_ACCOUNT_AGE_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

// ---------- ALL DATA LIVES HERE (in-memory, resets on restart) ----------
const logChannels = new Map(); // guildId -> channelId
const snipes = new Map();      // channelId -> {author, content, avatar}
const warnings = new Map();    // userId -> [reasons]
const joinTimes = new Map();   // guildId -> [timestamps]
const actionTimes = new Map(); // "guildId-userId-type" -> [timestamps]
const lockedDown = new Set();  // guildIds currently in raid lockdown
const activeGames = new Map(); // channelId -> game lock/state (one game per channel)

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

// ---------- FUN COMMANDS (owo-style, real gifs via nekos.best) ----------
const funActions = {
  slap: "slapped", kiss: "kissed", hug: "hugged", pat: "patted", bite: "bit",
  punch: "punched", poke: "poked", cuddle: "cuddled", tickle: "tickled",
  highfive: "high-fived", feed: "fed", wink: "winked at", handhold: "held hands with",
  kill: "eliminated", // no gif for this one, text-only flavor below
};
const killLines = ["grabbed a rubber chicken and eliminated", "dropped an anvil on", "sent to the shadow realm"];

async function handleFun(message, cmd) {
  const target = message.mentions.users.first();
  const author = message.author;
  const targetName = target && target.id !== author.id ? `**${target.username}**` : "themselves";
  const verb = cmd === "kill" ? killLines[Math.floor(Math.random() * killLines.length)] : funActions[cmd];
  const embed = new EmbedBuilder().setDescription(`**${author.username}** ${verb} ${targetName}`).setColor(0x2b2d31);

  if (cmd !== "kill") {
    try {
      const res = await fetch(`https://nekos.best/api/v2/${cmd}`, {
        headers: { "User-Agent": "CapybaraBot/1.0 (https://justrunmy.app)" },
      });
      const gif = (await res.json()).results?.[0]?.url;
      if (gif) embed.setImage(gif);
      else console.log(`[gif] no result for ${cmd}:`, res.status);
    } catch (e) { console.log(`[gif] fetch failed for ${cmd}:`, e.message); }
  }
  message.channel.send({ embeds: [embed] });
}

// ---------- GAMES ----------
const checkFree = (m) => activeGames.has(m.channel.id) ? (m.reply("❌ A game is already active here. Use `,endgame` to force stop it."), false) : true;
const lock = (id, type) => activeGames.set(id, { type });
const unlock = (id) => activeGames.delete(id);

// Tic-Tac-Toe
function ttt3Win(b, s) {
  const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  return L.some((l) => l.every((i) => b[i] === s));
}
async function startTTT(message, opp) {
  const players = [message.author, opp]; let turn = 0;
  const board = Array(9).fill(null);
  const rows = () => { const r = []; for (let i = 0; i < 9; i += 3) r.push(new ActionRowBuilder().addComponents(
    [i, i+1, i+2].map((idx) => new ButtonBuilder().setCustomId(`t${idx}`).setLabel(board[idx] || "\u200b").setStyle(board[idx] === "❌" ? ButtonStyle.Danger : board[idx] === "⭕" ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!!board[idx])))); return r; };
  const embed = (extra) => new EmbedBuilder().setTitle("❌⭕ Tic-Tac-Toe").setDescription(extra || `${players[turn]}'s turn (${turn === 0 ? "❌" : "⭕"})`).setColor(0x2b2d31);
  const msg = await message.channel.send({ embeds: [embed()], components: rows() });
  const col = msg.createMessageComponentCollector({ time: 120_000 });
  col.on("collect", (i) => {
    if (i.user.id !== players[turn].id) return i.reply({ content: "Not your turn.", ephemeral: true });
    const idx = parseInt(i.customId.slice(1));
    board[idx] = turn === 0 ? "❌" : "⭕";
    if (ttt3Win(board, board[idx])) { col.stop(); return i.update({ embeds: [embed(`${players[turn]} wins! 🎉`)], components: rows() }); }
    if (board.every(Boolean)) { col.stop(); return i.update({ embeds: [embed("It's a draw!")], components: rows() }); }
    turn = 1 - turn;
    i.update({ embeds: [embed()], components: rows() });
  });
  col.on("end", () => unlock(message.channel.id));
}

// Connect Four
function c4Win(g, r, c, t) {
  return [[0,1],[1,0],[1,1],[1,-1]].some(([dr, dc]) => {
    let count = 1;
    for (const s of [1, -1]) { let rr = r + dr*s, cc = c + dc*s; while (g[rr]?.[cc] === t) { count++; rr += dr*s; cc += dc*s; } }
    return count >= 4;
  });
}
async function startConnect4(message, opp) {
  const players = [message.author, opp]; let turn = 0;
  const grid = Array.from({ length: 6 }, () => Array(7).fill("⚪"));
  const colRow = new ActionRowBuilder().addComponents([...Array(7)].map((_, c) => new ButtonBuilder().setCustomId(`c${c}`).setLabel(`${c + 1}`).setStyle(ButtonStyle.Secondary)));
  const embed = (extra) => new EmbedBuilder().setTitle("🔴🟡 Connect Four").setDescription(`${grid.map((r) => r.join("")).join("\n")}\n\n${extra || `${players[turn]}'s turn (${turn === 0 ? "🔴" : "🟡"})`}`).setColor(0x2b2d31);
  const msg = await message.channel.send({ embeds: [embed()], components: [colRow] });
  const col = msg.createMessageComponentCollector({ time: 180_000 });
  col.on("collect", (i) => {
    if (i.user.id !== players[turn].id) return i.reply({ content: "Not your turn.", ephemeral: true });
    const c = parseInt(i.customId.slice(1));
    let row = -1; for (let r = 5; r >= 0; r--) if (grid[r][c] === "⚪") { row = r; break; }
    if (row === -1) return i.reply({ content: "Column full.", ephemeral: true });
    const token = turn === 0 ? "🔴" : "🟡";
    grid[row][c] = token;
    if (c4Win(grid, row, c, token)) { col.stop(); return i.update({ embeds: [embed(`${players[turn]} connects four! 🎉`)], components: [] }); }
    if (grid.every((r) => r.every((v) => v !== "⚪"))) { col.stop(); return i.update({ embeds: [embed("It's a draw!")], components: [] }); }
    turn = 1 - turn;
    i.update({ embeds: [embed()], components: [colRow] });
  });
  col.on("end", () => unlock(message.channel.id));
}

// Rock Paper Scissors
async function startRPS(message, opp) {
  const players = [message.author, opp]; const choices = {};
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rock").setLabel("🪨 Rock").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("paper").setLabel("📄 Paper").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("scissors").setLabel("✂️ Scissors").setStyle(ButtonStyle.Secondary));
  const msg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🪨📄✂️ Rock Paper Scissors").setDescription(`${players[0]} vs ${players[1]} — pick your move!`).setColor(0x2b2d31)], components: [row] });
  const col = msg.createMessageComponentCollector({ time: 60_000 });
  col.on("collect", async (i) => {
    if (!players.some((p) => p.id === i.user.id)) return i.reply({ content: "You're not in this game.", ephemeral: true });
    if (choices[i.user.id]) return i.reply({ content: "You already chose.", ephemeral: true });
    choices[i.user.id] = i.customId;
    await i.reply({ content: `You picked ${i.customId}.`, ephemeral: true });
    if (Object.keys(choices).length === 2) {
      col.stop();
      const [a, b] = players, beat = { rock: "scissors", paper: "rock", scissors: "paper" };
      const result = choices[a.id] === choices[b.id] ? "It's a tie!" : beat[choices[a.id]] === choices[b.id] ? `${a} wins! 🎉` : `${b} wins! 🎉`;
      msg.edit({ embeds: [new EmbedBuilder().setTitle("🪨📄✂️ Rock Paper Scissors").setDescription(`${a}: ${choices[a.id]}\n${b}: ${choices[b.id]}\n\n${result}`).setColor(0x2ecc71)], components: [] });
    }
  });
  col.on("end", () => unlock(message.channel.id));
}

// Blackjack
const DECK = [2,3,4,5,6,7,8,9,10,10,10,10,11];
const draw = () => DECK[Math.floor(Math.random() * DECK.length)];
function handTotal(h) { let t = h.reduce((a, b) => a + b, 0), aces = h.filter((v) => v === 11).length; while (t > 21 && aces > 0) { t -= 10; aces--; } return t; }
async function startBlackjack(message) {
  const player = [draw(), draw()], dealer = [draw(), draw()];
  const render = (reveal) => `**${message.author.username}**: ${player.join(", ")} (${handTotal(player)})\n**Dealer**: ${reveal ? dealer.join(", ") + ` (${handTotal(dealer)})` : dealer[0] + ", ❓"}`;
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("hit").setLabel("Hit").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("stand").setLabel("Stand").setStyle(ButtonStyle.Secondary));
  const msg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🃏 Blackjack").setDescription(render(false)).setColor(0x2b2d31)], components: [row] });
  const col = msg.createMessageComponentCollector({ time: 60_000, filter: (i) => i.user.id === message.author.id });
  const finish = async (i) => {
    while (handTotal(dealer) < 17) dealer.push(draw());
    const p = handTotal(player), d = handTotal(dealer);
    const result = p > 21 ? "You busted! Dealer wins." : d > 21 || p > d ? "You win! 🎉" : p < d ? "Dealer wins." : "It's a push!";
    col.stop();
    await i.update({ embeds: [new EmbedBuilder().setTitle("🃏 Blackjack").setDescription(render(true) + `\n\n${result}`).setColor(0x2ecc71)], components: [] });
  };
  col.on("collect", (i) => {
    if (i.customId === "hit") {
      player.push(draw());
      if (handTotal(player) > 21) return finish(i);
      i.update({ embeds: [new EmbedBuilder().setTitle("🃏 Blackjack").setDescription(render(false)).setColor(0x2b2d31)], components: [row] });
    } else finish(i);
  });
  col.on("end", () => unlock(message.channel.id));
}

// Cops & Robbers
async function startCops(message, opp) {
  const cop = { u: message.author, pos: [0, 0] }, robber = { u: opp, pos: [4, 4] };
  let turn = 0, rounds = 0; const MAXR = 10;
  const dirs = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  const render = () => { const g = Array.from({ length: 5 }, () => Array(5).fill("⬛")); g[cop.pos[0]][cop.pos[1]] = "👮"; g[robber.pos[0]][robber.pos[1]] = "🏃"; return g.map((r) => r.join("")).join("\n"); };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("up").setLabel("⬆️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("down").setLabel("⬇️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("left").setLabel("⬅️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("right").setLabel("➡️").setStyle(ButtonStyle.Secondary));
  const embed = (extra) => new EmbedBuilder().setTitle("👮 Cops & Robbers 🏃").setDescription(`${render()}\n\n${extra || `${turn === 0 ? cop.u : robber.u}'s move (${turn === 0 ? "Cop" : "Robber"}) — round ${rounds + 1}/${MAXR}`}`).setColor(0x2b2d31);
  const msg = await message.channel.send({ embeds: [embed()], components: [row] });
  const col = msg.createMessageComponentCollector({ time: 180_000 });
  col.on("collect", (i) => {
    const active = turn === 0 ? cop.u : robber.u;
    if (i.user.id !== active.id) return i.reply({ content: "Not your turn.", ephemeral: true });
    const [dr, dc] = dirs[i.customId], actor = turn === 0 ? cop : robber;
    actor.pos = [Math.min(4, Math.max(0, actor.pos[0] + dr)), Math.min(4, Math.max(0, actor.pos[1] + dc))];
    if (cop.pos[0] === robber.pos[0] && cop.pos[1] === robber.pos[1]) { col.stop(); return i.update({ embeds: [embed(`👮 ${cop.u} caught the robber! Cop wins! 🎉`)], components: [] }); }
    if (turn === 1) { rounds++; if (rounds >= MAXR) { col.stop(); return i.update({ embeds: [embed(`🏃 ${robber.u} escaped! Robber wins! 🎉`)], components: [] }); } }
    turn = 1 - turn;
    i.update({ embeds: [embed()], components: [row] });
  });
  col.on("end", () => unlock(message.channel.id));
}

// Racing
async function startRace(message) {
  const TRACK = 20;
  const joinMsg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏎️ Race — Join Now!").setDescription("Click to join! Race starts in 15s.").setColor(0x2b2d31)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("join").setLabel("🏁 Join Race").setStyle(ButtonStyle.Success))] });
  const racers = new Map();
  const jc = joinMsg.createMessageComponentCollector({ time: 15_000 });
  jc.on("collect", (i) => { if (!racers.has(i.user.id)) racers.set(i.user.id, { user: i.user, pos: 0 }); i.reply({ content: "You joined the race! 🏁", ephemeral: true }); });
  jc.on("end", async () => {
    if (racers.size < 1) { unlock(message.channel.id); return joinMsg.edit({ embeds: [new EmbedBuilder().setTitle("🏎️ Race").setDescription("Not enough racers, race cancelled.").setColor(0xe74c3c)], components: [] }); }
    const dashRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("dash").setLabel("💨 Dash!").setStyle(ButtonStyle.Primary));
    const render = () => [...racers.values()].map((r) => `${r.user.username}: ${"🟩".repeat(r.pos)}🏎️${"⬜".repeat(TRACK - r.pos)}🏁`).join("\n");
    const raceMsg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏎️ Race Started! Spam Dash!").setDescription(render()).setColor(0x2b2d31)], components: [dashRow] });
    const cooldowns = new Map();
    const rc = raceMsg.createMessageComponentCollector({ time: 60_000 });
    rc.on("collect", (i) => {
      if (!racers.has(i.user.id)) return i.reply({ content: "You're not in this race.", ephemeral: true });
      if (Date.now() - (cooldowns.get(i.user.id) || 0) < 1500) return i.reply({ content: "⏳ Wait a moment before dashing again!", ephemeral: true });
      cooldowns.set(i.user.id, Date.now());
      const r = racers.get(i.user.id); r.pos = Math.min(TRACK, r.pos + Math.ceil(Math.random() * 3));
      if (r.pos >= TRACK) { rc.stop(); return i.update({ embeds: [new EmbedBuilder().setTitle("🏎️ Race Finished!").setDescription(render() + `\n\n🏆 ${r.user} wins the race!`).setColor(0x2ecc71)], components: [] }); }
      i.update({ embeds: [new EmbedBuilder().setTitle("🏎️ Race Started! Spam Dash!").setDescription(render()).setColor(0x2b2d31)], components: [dashRow] });
    });
    rc.on("end", () => unlock(message.channel.id));
  });
}

// Hangman
const HANGMAN_WORDS = ["discord", "capybara", "python", "javascript", "ticket", "server", "moderator", "keyboard", "pancake", "wizard"];
const HANGMAN_STAGES = ["🙂", "😐 (1 wrong)", "😟 (2 wrong)", "😨 (3 wrong)", "😱 (4 wrong)", "💀 (5 wrong)", "☠️ GAME OVER"];
const hangmanDisplay = (s) => s.word.split("").map((l) => (s.guessed.includes(l) ? l : "▢")).join(" ");
async function sendHangman(channel, state) {
  channel.send({ embeds: [new EmbedBuilder().setTitle("🎯 Hangman").setDescription(`${HANGMAN_STAGES[state.wrong]}\n\n\`${hangmanDisplay(state)}\`\n\nGuessed: ${state.guessed.join(", ") || "none"}\nType a single letter to guess!`).setColor(0x2b2d31)] });
}

// Chess (casual — no check/checkmate/legal-move validation, just piece movement)
const CHESS_START = [
  ["♜","♞","♝","♛","♚","♝","♞","♜"], Array(8).fill("♟"),
  Array(8).fill(""), Array(8).fill(""), Array(8).fill(""), Array(8).fill(""),
  Array(8).fill("♙"), ["♖","♘","♗","♕","♔","♗","♘","♖"],
];
const renderChess = (b) => "  a b c d e f g h\n" + b.map((row, r) => `${8 - r} ${row.map((p) => p || "·").join(" ")} ${8 - r}`).join("\n") + "\n  a b c d e f g h";
const chessEmbed = (s) => new EmbedBuilder().setTitle("♟️ Chess").setDescription("```\n" + renderChess(s.board) + "\n```\n" + `${s.players[s.turn]}'s turn (${s.turn === 0 ? "White" : "Black"})`).setColor(0x2b2d31);

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (await runAutomod(message)) return;

  const hm = activeGames.get(message.channel.id);
  if (hm?.type === "hangman" && /^[a-z]$/i.test(message.content)) {
    const letter = message.content.toLowerCase();
    if (!hm.guessed.includes(letter)) {
      hm.guessed.push(letter);
      if (!hm.word.includes(letter)) hm.wrong++;
      if (hm.wrong >= 6) { message.channel.send(`💀 Game over! The word was **${hm.word}**.`); unlock(message.channel.id); }
      else if (hm.word.split("").every((l) => hm.guessed.includes(l))) { message.channel.send(`🎉 ${message.author} solved it! The word was **${hm.word}**.`); unlock(message.channel.id); }
      else await sendHangman(message.channel, hm);
    }
    return;
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();
  const member = message.member;
  const need = (perm, name) => {
    if (!member.permissions.has(perm)) { message.reply(`❌ You need **${name}** permission.`); return false; }
    return true;
  };

  try {
    if (funActions[cmd]) return handleFun(message, cmd);

    switch (cmd) {
      case "help": {
        const embed = new EmbedBuilder().setTitle("🦫 Capybara Bot Commands").setColor(0x1abc9c).addFields(
          { name: "Moderation", value: ",kick @user [reason]\n,ban @user [reason]\n,unban <id>\n,bans — list banned users\n,mute @user <minutes> [reason]\n,unmute @user\n,warn @user [reason]\n,warnings @user\n,purge <amount> [@user]\n,lock\n,unlock\n,slowmode <seconds>\n,nick @user <name>" },
          { name: "Tickets", value: ",ticketsetup — post ticket panel (admin)" },
          { name: "Security", value: ",setlogs #channel — set log channel (admin)\nAnti-raid & anti-nuke run automatically." },
          { name: "Utility", value: ",dm @user <message> — DM a user through the bot\n,say <message>\n,ping\n,userinfo @user\n,serverinfo\n,avatar @user\n,announce <message>\n,s — snipe last deleted message" },
          { name: "Fun", value: ",slap ,kiss ,hug ,pat ,bite ,punch ,poke ,cuddle ,tickle ,highfive ,feed ,wink ,handhold ,kill — all take @user" },
          { name: "Games", value: ",ttt @user\n,connect4 @user\n,rps @user\n,blackjack\n,slots\n,cops @user\n,race\n,hangman\n,chess @user (then `,move e2 e4`)\n,endgame — force stop a stuck game" },
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
      case "bans": {
        if (!need(PermissionsBitField.Flags.BanMembers, "Ban Members")) break;
        const bans = await message.guild.bans.fetch();
        if (!bans.size) return message.channel.send("✅ No banned users.");
        const list = [...bans.values()].slice(0, 25).map((b) => `**${b.user.tag}** — \`${b.user.id}\``).join("\n");
        const embed = new EmbedBuilder().setTitle(`🔨 Banned Users (${bans.size})`).setDescription(list + (bans.size > 25 ? `\n…and ${bans.size - 25} more` : "")).setColor(0xe74c3c);
        message.channel.send({ embeds: [embed] });
        break;
      }
      case "dm": {
        if (!need(PermissionsBitField.Flags.ManageGuild, "Manage Server")) break;
        const target = message.mentions.users.first();
        const text = args.slice(1).join(" ");
        if (!target || !text) return message.reply("❌ Usage: ,dm @user <message>");

        const embed = new EmbedBuilder()
          .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() })
          .setTitle("📩 Message from Staff")
          .setDescription(text)
          .setColor(0x2b2d31)
          .setFooter({ text: `Sent by ${message.author.tag}` })
          .setTimestamp();

        try {
          await target.send({ embeds: [embed] });
          message.channel.send(`✅ Sent your message to **${target.tag}**.`);
          log(message.guild, "📩 DM Sent", `${message.author.tag} → ${target.tag}\nMessage: ${text}`, 0x2b2d31);
        } catch {
          message.reply(`❌ Couldn't DM **${target.tag}** — their DMs are likely closed.`);
        }
        break;
      }
      case "ttt": case "tictactoe": {
        if (!checkFree(message)) break;
        const opp = message.mentions.users.first();
        if (!opp || opp.bot || opp.id === message.author.id) return message.reply("❌ Mention someone to challenge.");
        lock(message.channel.id, "ttt");
        startTTT(message, opp);
        break;
      }
      case "connect4": {
        if (!checkFree(message)) break;
        const opp = message.mentions.users.first();
        if (!opp || opp.bot || opp.id === message.author.id) return message.reply("❌ Mention someone to challenge.");
        lock(message.channel.id, "connect4");
        startConnect4(message, opp);
        break;
      }
      case "rps": {
        if (!checkFree(message)) break;
        const opp = message.mentions.users.first();
        if (!opp || opp.bot || opp.id === message.author.id) return message.reply("❌ Mention someone to challenge.");
        lock(message.channel.id, "rps");
        startRPS(message, opp);
        break;
      }
      case "blackjack": case "bj": {
        if (!checkFree(message)) break;
        lock(message.channel.id, "blackjack");
        startBlackjack(message);
        break;
      }
      case "slots": {
        const symbols = ["🍒", "🍋", "🔔", "⭐", "7️⃣"];
        const spin = [0, 1, 2].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
        const win = spin[0] === spin[1] && spin[1] === spin[2];
        message.channel.send({ embeds: [new EmbedBuilder().setTitle("🎰 Slots").setDescription(`[ ${spin.join(" | ")} ]\n\n${win ? "🎉 Jackpot!" : "No luck, try again!"}`).setColor(win ? 0x2ecc71 : 0x2b2d31)] });
        break;
      }
      case "cops": {
        if (!checkFree(message)) break;
        const opp = message.mentions.users.first();
        if (!opp || opp.bot || opp.id === message.author.id) return message.reply("❌ Mention someone to play robber.");
        lock(message.channel.id, "cops");
        startCops(message, opp);
        break;
      }
      case "race": {
        if (!checkFree(message)) break;
        lock(message.channel.id, "race");
        startRace(message);
        break;
      }
      case "hangman": {
        if (!checkFree(message)) break;
        const word = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)];
        lock(message.channel.id, "hangman");
        const state = activeGames.get(message.channel.id);
        state.word = word; state.guessed = []; state.wrong = 0;
        sendHangman(message.channel, state);
        break;
      }
      case "chess": {
        if (!checkFree(message)) break;
        const opp = message.mentions.users.first();
        if (!opp || opp.bot || opp.id === message.author.id) return message.reply("❌ Mention someone to challenge.");
        lock(message.channel.id, "chess");
        const state = activeGames.get(message.channel.id);
        state.board = JSON.parse(JSON.stringify(CHESS_START)); state.players = [message.author, opp]; state.turn = 0;
        message.channel.send({ embeds: [chessEmbed(state)] });
        break;
      }
      case "move": {
        const state = activeGames.get(message.channel.id);
        if (!state || state.type !== "chess") return message.reply("❌ No chess game active. Start one with `,chess @user`.");
        if (message.author.id !== state.players[state.turn].id) return message.reply("❌ Not your turn.");
        const [from, to] = args;
        if (!from || !to) return message.reply("❌ Usage: ,move e2 e4");
        const parse = (sq) => [8 - parseInt(sq[1]), sq[0].toLowerCase().charCodeAt(0) - 97];
        const [fr, fc] = parse(from), [tr, tc] = parse(to);
        if ([fr, fc, tr, tc].some((n) => n < 0 || n > 7)) return message.reply("❌ Invalid square.");
        const piece = state.board[fr][fc];
        const whitePieces = "♙♖♘♗♕♔";
        if (!piece) return message.reply("❌ No piece on that square.");
        if (whitePieces.includes(piece) !== (state.turn === 0)) return message.reply("❌ That's not your piece.");
        const destPiece = state.board[tr][tc];
        if (destPiece && whitePieces.includes(destPiece) === whitePieces.includes(piece)) return message.reply("❌ You already have a piece there.");
        state.board[tr][tc] = piece; state.board[fr][fc] = "";
        state.turn = 1 - state.turn;
        message.channel.send({ embeds: [chessEmbed(state)] });
        break;
      }
      case "endgame": {
        if (!activeGames.has(message.channel.id)) return message.reply("No active game here.");
        unlock(message.channel.id);
        message.channel.send("🛑 Game ended.");
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
