import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActivityType } from 'discord.js';
import { handleDeposit, handleDepositButton, handleDepositModal, handleApproveDeposit, handleRejectDeposit } from './commands/deposit.js';
import { handleBalance } from './commands/balance.js';
import { handleCoinflip, handleCoinflipButton } from './commands/coinflip.js';
import { handleAdmin, handlePay } from './commands/admin.js';
import { handleWithdraw, handleWithdrawConfirm, handleWithdrawCancel, handleWithdrawModal, handleWithdrawSent, handleWithdrawRefund } from './commands/withdraw.js';
import { handleSlots } from './games/slots.js';
import { handleDice, handleDiceModalButton, handleDiceModalSubmit } from './games/dice.js';
import { handleBlackjack, handleBlackjackButton } from './games/blackjack.js';
import { handleMines, handleMinesTile, handleMinesCash } from './games/mines.js';
import { getTopBalances, addAdmin, isAdmin, isOwner } from './database.js';

const PREFIX = '.';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  client.user.setActivity('🎰 City JackPots', { type: ActivityType.Listening });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  try {
    switch (command) {
      case 'deposit': await handleDeposit(message); break;
      case 'balance': case 'bal': await handleBalance(message); break;
      case 'withdraw': case 'wd': await handleWithdraw(message, args); break;
      case 'leaderboard': case 'lb': await handleLeaderboard(message); break;
      case 'coinflip': case 'cf': await handleCoinflip(message, args); break;
      case 'slots': await handleSlots(message, args); break;
      case 'dice': await handleDice(message, args); break;
      case 'blackjack': case 'bj': await handleBlackjack(message, args); break;
      case 'mines': await handleMines(message, args); break;
      case 'admin': await handleAdmin(message, args); break;
      case 'addmoney': case 'pay': await handlePay(message, args); break;
      case 'makeadmin': {
        const isGuildOwner = message.guild && message.guild.ownerId === message.author.id;
        if (!isOwner(message.author.id, message.author.username) && !isGuildOwner) {
          return message.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Access Denied').setDescription('Only the bot owner or server owner can grant admin access.').setTimestamp()], allowedMentions: { repliedUser: false } });
        }
        const targetId = args[0]?.replace(/[<@!>]/g, '');
        if (!targetId) return message.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('🛡️ Make Admin').setDescription('**Usage:** `.makeadmin @user`').setTimestamp()], allowedMentions: { repliedUser: false } });
        if (isAdmin(targetId)) return message.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('ℹ️ Already Admin').setDescription(`<@${targetId}> already has admin access.`).setTimestamp()], allowedMentions: { repliedUser: false } });
        addAdmin(targetId, message.author.id);
        try { const u = await message.client.users.fetch(targetId); await u.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🛡️ Admin Access Granted!').setDescription('You now have admin access! Use `.admin` to manage the bot.').setTimestamp()] }); } catch {}
        return message.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Admin Granted').setDescription(`<@${targetId}> is now an admin and can use all \`.admin\` commands!`).setTimestamp()], allowedMentions: { repliedUser: false } });
      }
      case 'help': await handleHelp(message); break;
      default: break;
    }
  } catch (err) {
    console.error(`[Command Error] ${command}:`, err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'deposit_submit' || id === 'deposit_pending') {
        await handleDepositButton(interaction);
      } else if (id.startsWith('approve_deposit_')) {
        await handleApproveDeposit(interaction, parseInt(id.replace('approve_deposit_', '')));
      } else if (id.startsWith('reject_deposit_')) {
        await handleRejectDeposit(interaction, parseInt(id.replace('reject_deposit_', '')));
      } else if (id.startsWith('cf_heads_') || id.startsWith('cf_tails_')) {
        await handleCoinflipButton(interaction);
      } else if (id.startsWith('dice_modal_')) {
        await handleDiceModalButton(interaction);
      } else if (id.startsWith('bj_')) {
        await handleBlackjackButton(interaction);
      } else if (id.startsWith('mines_tile_')) {
        await handleMinesTile(interaction);
      } else if (id.startsWith('mines_cash_')) {
        await handleMinesCash(interaction);
      } else if (id.startsWith('withdraw_confirm_')) {
        await handleWithdrawConfirm(interaction);
      } else if (id.startsWith('withdraw_cancel_')) {
        await handleWithdrawCancel(interaction);
      } else if (id.startsWith('withdraw_sent_')) {
        await handleWithdrawSent(interaction);
      } else if (id.startsWith('withdraw_refund_')) {
        await handleWithdrawRefund(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'deposit_modal') {
        await handleDepositModal(interaction);
      } else if (interaction.customId.startsWith('withdraw_method_')) {
        await handleWithdrawModal(interaction);
      } else if (interaction.customId.startsWith('dicemodal_')) {
        await handleDiceModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error('[Interaction Error]:', err);
    try {
      const errMsg = { content: '⚠️ Something went wrong. Please try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(errMsg);
      else await interaction.reply(errMsg);
    } catch {}
  }
});

async function handleHelp(message) {
  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📖 Command List')
      .setDescription('Here\'s everything you can do!')
      .addFields(
        { name: '💳 Economy', value: '> `.deposit` — Add funds (LTC, CashApp, Apple Pay, Zelle)\n> `.balance` / `.bal` — Check your balance privately\n> `.withdraw <amt>` / `.wd` — Request a cashout\n> `.leaderboard` / `.lb` — Top 10 richest members' },
        { name: '🎮 Games', value: '> `.coinflip <amt>` / `.cf` — 50/50, win **1.9x**\n> `.slots <amt>` — Spin reels, win up to **30x**\n> `.dice <amt> [1-100]` — Guess exact roll for **80x**\n> `.blackjack <amt>` / `.bj` — Beat dealer, win **2.5x** (3x BJ)\n> `.mines <amt> [mines]` — Dodge mines, cash out any time! 💣' },
        { name: '🔧 Staff Only', value: '> `.addmoney @user <amt>` — Manually add funds\n> `.makeadmin @user` — Grant admin access *(owner only)*\n> `.admin add @user <amt>` — Add to balance\n> `.admin set @user <amt>` — Set balance\n> `.admin check @user` — Check balance\n> `.admin pending` — View pending deposits\n> `.admin setchannel` — Set notification channel' },
      )
      .setFooter({ text: '💰 All balances are private • Games are fair • Good luck! 🍀' })
      .setTimestamp()],
    allowedMentions: { repliedUser: false },
  });
}

async function handleLeaderboard(message) {
  const top = getTopBalances(10);
  if (top.length === 0) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 Leaderboard').setDescription('No balances yet — be the first to deposit and play!').setTimestamp()], allowedMentions: { repliedUser: false } });
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((row, i) => `${medals[i] || `\`#${i + 1}\``} <@${row.user_id}> — **$${Number(row.balance).toFixed(2)}**`);
  return message.reply({
    embeds: [new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 Balance Leaderboard').setDescription(lines.join('\n')).setFooter({ text: 'Top 10 • Use .deposit to climb the ranks!' }).setTimestamp()],
    allowedMentions: { repliedUser: false },
  });
}

client.login(process.env.DISCORD_BOT_TOKEN);
