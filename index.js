const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.");
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DATA = path.join(DATA_DIR, "data.json");
let db = {};
if (fs.existsSync(DATA)) {
  try { db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch { db = {}; }
}
if (!db.voiceOwners) db.voiceOwners = {};
const emptyVoiceTimers = new Map();
const zeitplanPending = new Map();
const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

// XP-START
const xpCooldowns = new Map();
let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 15000);
}

function xpNeeded(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelFromXp(total) {
  let level = 0;
  let rest = total;
  while (rest >= xpNeeded(level)) {
    rest -= xpNeeded(level);
    level++;
  }
  return { level, current: rest, needed: xpNeeded(level) };
}

function xpTable(guildId) {
  const c = cfg(guildId);
  c.xp ??= {};
  return c.xp;
}

function xpRanking(guildId) {
  return Object.entries(xpTable(guildId)).sort((a, b) => b[1].xp - a[1].xp);
}

function progressBar(current, needed, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round((current / needed) * size)));
  return "█".repeat(filled) + "░".repeat(size - filled);
}

async function grantLevelRoles(member, level) {
  const roles = cfg(member.guild.id).levelRoles || {};
  for (const [lvl, roleId] of Object.entries(roles)) {
    if (Number(lvl) > level || member.roles.cache.has(roleId)) continue;
    await member.roles.add(roleId, `Level-Belohnung: Level ${lvl}`).catch(() => {});
  }
}

function announceLevelUp(member, level, fallbackChannel) {
  const c = cfg(member.guild.id);
  const channel = (c.levelChannel && member.guild.channels.cache.get(c.levelChannel)) || fallbackChannel;
  if (!channel?.isTextBased()) return;
  channel.send({
    embeds: [
      new EmbedBuilder()
        .setDescription(`🎉 ${member} ist jetzt **Level ${level}**!`)
        .setColor(0x9b5cff)
    ]
  }).catch(() => {});
}

async function addXp(member, amount, fallbackChannel = null) {
  const entry = (xpTable(member.guild.id)[member.id] ??= { xp: 0 });
  const before = levelFromXp(entry.xp).level;
  entry.xp += amount;
  const after = levelFromXp(entry.xp).level;
  saveSoon();

  if (after > before) {
    await grantLevelRoles(member, after);
    announceLevelUp(member, after, fallbackChannel);
  }
}

function startVoiceXp() {
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      for (const ch of guild.channels.cache.values()) {
        if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) continue;
        if (ch.id === guild.afkChannelId) continue;
        const humans = ch.members.filter(m => !m.user.bot);
        if (humans.size < 2) continue;
        for (const m of humans.values()) {
          if (m.voice.selfDeaf || m.voice.serverDeaf) continue;
          addXp(m, 10).catch(() => {});
        }
      }
    }
  }, 60000);
}
// XP-END

function save() {
  fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
}
function cfg(guildId) {
  if (!db[guildId]) db[guildId] = { welcomeChannel: null, logChannel: null, ticketCategory: null, joinCreateChannel: null, joinCreateCategory: null, emojiFormat: true, warnings: {} };
  return db[guildId];
}
function isStaff(member) {
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
         member.permissions.has(PermissionsBitField.Flags.ManageMessages);
}
function ok(interaction, perm) {
  return interaction.memberPermissions?.has(perm);
}
function safeName(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\-_]/gu, "").slice(0, 80) || "channel";
}

// ITEMS-START
function itemsTable(guildId) {
  const c = cfg(guildId);
  c.items ??= {};
  return c.items;
}
function itemId(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}
const verleihPending = new Map();
db.verleihRequests ??= {};
// ITEMS-END

function setVoiceOwner(channel, ownerId) {
  db.voiceOwners[channel.id] = {
    guildId: channel.guild.id,
    ownerId
  };
  save();
}

function removeVoiceOwner(channelId) {
  delete db.voiceOwners[channelId];
  save();
}

function getOwnedVoiceChannel(guild, userId) {
  const entry = Object.entries(db.voiceOwners).find(([, owner]) =>
    owner.guildId === guild.id && owner.ownerId === userId
  );

  if (!entry) return null;

  const channel = guild.channels.cache.get(entry[0]);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    removeVoiceOwner(entry[0]);
    return null;
  }

  return channel;
}

function clearVoiceDeletion(channelId) {
  const timer = emptyVoiceTimers.get(channelId);
  if (!timer) return;
  clearTimeout(timer);
  emptyVoiceTimers.delete(channelId);
}

function scheduleVoiceDeletion(channel) {
  if (!channel || channel.members.size > 0) return;
  clearVoiceDeletion(channel.id);

  const timer = setTimeout(async () => {
    emptyVoiceTimers.delete(channel.id);
    const current = channel.guild.channels.cache.get(channel.id);
    if (!current || current.members.size > 0) return;
    log(channel.guild, `${current.name} wurde nach 30 Sekunden Leerstand automatisch gelöscht.`);
    removeVoiceOwner(channel.id);
    await current.delete().catch(() => {});
  }, 30000);

  emptyVoiceTimers.set(channel.id, timer);
}

function voicePanel(channel) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`🎛️ ${channel.name}`)
        .setDescription("Verwalte hier deinen eigenen Join-to-Create-Call.")
        .setColor(0x9b5cff)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("voice_rename").setLabel("Umbenennen").setEmoji("✏️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("voice_limit").setLabel("Nutzerlimit").setEmoji("👥").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_kick").setLabel("Nutzer entfernen").setEmoji("🚪").setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("voice_lock").setLabel("Sperren").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_unlock").setLabel("Entsperren").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_hide").setLabel("Verstecken").setEmoji("🙈").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_show").setLabel("Anzeigen").setEmoji("👀").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_delete").setLabel("Löschen").setEmoji("🗑️").setStyle(ButtonStyle.Danger)
      )
    ]
  };
}

function ticketPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("🎫 Support & Verleih")
        .setDescription("Wähle unten aus, worum es geht. Es öffnet sich ein Formular, danach wird ein privater Kanal für dich erstellt.")
        .setColor(0x9b5cff)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_open_verleih").setLabel("Item ausleihen").setEmoji("📦").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_open_support").setLabel("Support").setEmoji("🛠️").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

async function openTicketChannel(guild, user, { prefix, topic, category, embed, extraRow }) {
  const chan = await guild.channels.create({
    name: `${prefix}-${safeName(user.username)}`,
    type: ChannelType.GuildText,
    parent: category || null,
    topic,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] }
    ]
  });
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Ticket schließen").setEmoji("🔒").setStyle(ButtonStyle.Danger)
  );
  const rows = extraRow ? [extraRow, closeRow] : [closeRow];
  await chan.send({ content: `${user}`, embeds: [embed], components: rows });
  return chan;
}

const leadingEmojiPattern = /^((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*)/u;

function formatChannelName(name) {
  let channelName = name.trim();
  const alreadyFormatted = channelName.match(/^『([^』]+)』\s*(.*)$/u);

  if (alreadyFormatted) {
    const emoji = alreadyFormatted[1].trim();
    channelName = alreadyFormatted[2].trim();
    return emoji && channelName ? `『${emoji}』${channelName}` : null;
  }

  const emojiMatch = channelName.match(leadingEmojiPattern);
  if (!emojiMatch) return null;

  const emoji = emojiMatch[1];
  channelName = channelName
    .slice(emoji.length)
    .trim()
    .replace(/^[|｜]\s*/, "");

  return channelName ? `『${emoji}』${channelName}` : null;
}

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Zeigt alle Bot-Funktionen"),
  new SlashCommandBuilder().setName("setup").setDescription("Erstellt wichtige Bot-Kanäle und Grundkonfiguration"),
  new SlashCommandBuilder().setName("config").setDescription("Zeigt die aktuelle Bot-Konfiguration"),
  new SlashCommandBuilder().setName("setlogs").setDescription("Setzt diesen Textkanal als Log-Kanal"),
  new SlashCommandBuilder().setName("clear").setDescription("Löscht Nachrichten")
    .addIntegerOption(o => o.setName("anzahl").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("kick").setDescription("Kickt ein Mitglied")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))
    .addStringOption(o => o.setName("grund").setDescription("Grund").setRequired(false)),
  new SlashCommandBuilder().setName("ban").setDescription("Bannt ein Mitglied")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))
    .addStringOption(o => o.setName("grund").setDescription("Grund").setRequired(false)),
  new SlashCommandBuilder().setName("timeout").setDescription("Gibt einem Mitglied einen Timeout")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))
    .addIntegerOption(o => o.setName("minuten").setDescription("1-40320").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName("grund").setDescription("Grund").setRequired(false)),
  new SlashCommandBuilder().setName("warn").setDescription("Verwarnt ein Mitglied")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))
    .addStringOption(o => o.setName("grund").setDescription("Grund").setRequired(true)),
  new SlashCommandBuilder().setName("warnings").setDescription("Zeigt Verwarnungen")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true)),
  new SlashCommandBuilder().setName("announce").setDescription("Sendet eine Ankündigung")
    .addStringOption(o => o.setName("text").setDescription("Text").setRequired(true)),
  new SlashCommandBuilder().setName("poll").setDescription("Erstellt eine Umfrage")
    .addStringOption(o => o.setName("frage").setDescription("Frage").setRequired(true)),
  new SlashCommandBuilder().setName("say").setDescription("Sendet Text als Bot")
    .addStringOption(o => o.setName("text").setDescription("Text").setRequired(true)),
  new SlashCommandBuilder().setName("lock").setDescription("Sperrt den aktuellen Kanal"),
  new SlashCommandBuilder().setName("unlock").setDescription("Entsperrt den aktuellen Kanal"),
  new SlashCommandBuilder().setName("slowmode").setDescription("Setzt den Slowmode")
    .addIntegerOption(o => o.setName("sekunden").setDescription("0-21600").setRequired(true).setMinValue(0).setMaxValue(21600)),
  new SlashCommandBuilder().setName("ticket").setDescription("Erstellt ein Ticket-Panel"),
  new SlashCommandBuilder().setName("joincreate").setDescription("Setzt den aktuellen Voice-Kanal als Join-to-Create-Kanal"),
  new SlashCommandBuilder().setName("voicepanel").setDescription("Öffnet die Verwaltung deines eigenen Join-to-Create-Calls"),
  new SlashCommandBuilder().setName("format").setDescription("Formatiert einen Kanal mit passendem Emoji")
    .addChannelOption(o => o.setName("kanal").setDescription("Kanal").setRequired(false)),
  new SlashCommandBuilder().setName("glowup").setDescription("Verpasst einem Textkanal ein komplettes Glow Up")
    .addChannelOption(o => o.setName("kanal").setDescription("Der zu verschönernde Textkanal").setRequired(false))
    .addStringOption(o => o.setName("name").setDescription("Neuer Name, optional mit Emoji").setRequired(false).setMaxLength(90))
    .addStringOption(o => o.setName("beschreibung").setDescription("Beschreibung für Kanal und Info-Embed").setRequired(false).setMaxLength(1024)),
  new SlashCommandBuilder().setName("zeitplan").setDescription("Erstellt einen Zeitplan für Videos oder Streams")
    .addStringOption(o => o.setName("typ").setDescription("Video oder Stream").setRequired(true)
      .addChoices({ name: "🎬 Video", value: "video" }, { name: "📺 Stream", value: "stream" }))
    .addStringOption(o => o.setName("uhrzeit").setDescription("Uhrzeit, z. B. 18:00").setRequired(true).setMaxLength(5))
    .addStringOption(o => o.setName("titel").setDescription("Titel oder Thema (optional)").setRequired(false).setMaxLength(100))
    .addStringOption(o => o.setName("notiz").setDescription("Zusätzlicher Hinweis (optional)").setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName("rank").setDescription("Zeigt Level und XP")
    .addUserOption(o => o.setName("mitglied").setDescription("Mitglied (optional)").setRequired(false)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Zeigt die XP-Bestenliste")
    .addIntegerOption(o => o.setName("seite").setDescription("Seite (optional)").setRequired(false).setMinValue(1)),
  new SlashCommandBuilder().setName("levelrole").setDescription("Rollen-Belohnungen für Level verwalten")
    .addSubcommand(s => s.setName("setzen").setDescription("Rolle ab einem Level vergeben")
      .addIntegerOption(o => o.setName("level").setDescription("Ab diesem Level").setRequired(true).setMinValue(1).setMaxValue(200))
      .addRoleOption(o => o.setName("rolle").setDescription("Rolle").setRequired(true)))
    .addSubcommand(s => s.setName("entfernen").setDescription("Belohnung für ein Level entfernen")
      .addIntegerOption(o => o.setName("level").setDescription("Level").setRequired(true).setMinValue(1).setMaxValue(200)))
    .addSubcommand(s => s.setName("liste").setDescription("Zeigt alle Level-Rollen")),
  new SlashCommandBuilder().setName("levelchannel").setDescription("Kanal für Level-Up-Nachrichten festlegen (ohne Angabe: zurücksetzen)")
    .addChannelOption(o => o.setName("kanal").setDescription("Textkanal").addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder().setName("xp").setDescription("XP von Mitgliedern verwalten")
    .addSubcommand(s => s.setName("geben").setDescription("Gibt einem Mitglied XP")
      .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))
      .addIntegerOption(o => o.setName("menge").setDescription("Anzahl XP").setRequired(true).setMinValue(1).setMaxValue(1000000)))
    .addSubcommand(s => s.setName("reset").setDescription("Setzt die XP eines Mitglieds zurück")
      .addUserOption(o => o.setName("mitglied").setDescription("Mitglied").setRequired(true))),
  new SlashCommandBuilder().setName("item").setDescription("Verwaltet den Verleih-Katalog")
    .addSubcommand(s => s.setName("hinzufuegen").setDescription("Fügt ein Item zum Verleih-Katalog hinzu")
      .addStringOption(o => o.setName("name").setDescription("Name des Items").setRequired(true).setMaxLength(80))
      .addStringOption(o => o.setName("beschreibung").setDescription("Beschreibung (optional)").setRequired(false).setMaxLength(300)))
    .addSubcommand(s => s.setName("entfernen").setDescription("Entfernt ein Item aus dem Katalog")
      .addStringOption(o => o.setName("name").setDescription("Name des Items").setRequired(true).setMaxLength(80)))
    .addSubcommand(s => s.setName("liste").setDescription("Zeigt den Verleih-Katalog"))
].map(c => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

function log(guild, text) {
  const channelId = cfg(guild.id).logChannel;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (channel?.isTextBased()) {
    channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(`📝 ${text}`)
          .setColor(0x9b5cff)
          .setTimestamp()
      ]
    }).catch(() => {});
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  startVoiceXp();
  try {
    await registerCommands();
    console.log("Slash commands registered.");
  } catch (e) {
    console.error("Command registration failed:", e);
  }
});

client.on("guildMemberAdd", async member => {
  const c = cfg(member.guild.id);
  if (!c.welcomeChannel) return;
  const channel = member.guild.channels.cache.get(c.welcomeChannel);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle("👋 Willkommen bei Squizyys!")
    .setDescription(`Hey ${member}, schön dass du da bist!`)
    .setThumbnail(member.user.displayAvatarURL())
    .setColor(0x9b5cff);
  channel.send({ embeds: [embed] }).catch(() => {});
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (xpCooldowns.get(key) || 0) < 60000) return;
  xpCooldowns.set(key, now);

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  await addXp(member, 15 + Math.floor(Math.random() * 11), message.channel).catch(console.error);
});

client.on("channelCreate", async channel => {
  if (!channel.guild || !cfg(channel.guild.id).emojiFormat) return;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) return;
  const newName = formatChannelName(channel.name);
  if (!newName || channel.name === newName) return;
  await channel.setName(newName).catch(() => {});
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
    if (oldChannel && db.voiceOwners[oldChannel.id] && oldChannel.members.size === 0) {
      scheduleVoiceDeletion(oldChannel);
    }
  }

  if (newState.channelId && db.voiceOwners[newState.channelId]) {
    clearVoiceDeletion(newState.channelId);
  }

  const c = cfg(newState.guild.id);
  if (!c.joinCreateChannel || newState.channelId !== c.joinCreateChannel) return;
  if (!newState.member) return;
  const existingCall = getOwnedVoiceChannel(newState.guild, newState.member.id);
  if (existingCall) {
    await newState.setChannel(existingCall).catch(() => {});
    return;
  }
  const category = c.joinCreateCategory ? newState.guild.channels.cache.get(c.joinCreateCategory) : newState.channel?.parent;
  try {
    const ch = await newState.guild.channels.create({
      name: `🔊｜${newState.member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: category?.id || null,
      permissionOverwrites: [{ id: newState.member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }]
    });
    setVoiceOwner(ch, newState.member.id);
    await newState.setChannel(ch);
    await ch.send(voicePanel(ch)).catch(error => {
      console.error("Voice-Panel konnte nicht gesendet werden:", error);
    });
    log(newState.guild, `${newState.member.user.tag} hat den Voice-Call ${ch.name} erstellt.`);
  } catch (e) { console.error("Join-to-create:", e); }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isModalSubmit() && interaction.customId === "voice_rename_modal") {
    const voice = interaction.guild ? getOwnedVoiceChannel(interaction.guild, interaction.user.id) : null;
    if (!voice) return interaction.reply({ content: "❌ Du hast keinen eigenen Join-to-Create-Call.", ephemeral: true });

    const requestedName = interaction.fields.getTextInputValue("voice_name").trim();
    if (!requestedName) return interaction.reply({ content: "❌ Der Name darf nicht leer sein.", ephemeral: true });

    const newName = formatChannelName(requestedName) || requestedName;
    await voice.setName(newName.slice(0, 100));
    return interaction.reply({ content: `✅ Dein Call heißt jetzt ${voice}.`, ephemeral: true });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "voice_limit_select") {
    const voice = interaction.guild ? getOwnedVoiceChannel(interaction.guild, interaction.user.id) : null;
    if (!voice) return interaction.reply({ content: "❌ Du hast keinen eigenen Join-to-Create-Call.", ephemeral: true });

    const limit = Number(interaction.values[0]);
    await voice.setUserLimit(limit);
    return interaction.reply({
      content: limit === 0 ? "✅ Das Nutzerlimit ist aufgehoben." : `✅ Das Nutzerlimit ist auf ${limit} gesetzt.`,
      ephemeral: true
    });
  }

  if (interaction.isUserSelectMenu() && interaction.customId === "voice_kick_select") {
    const voice = interaction.guild ? getOwnedVoiceChannel(interaction.guild, interaction.user.id) : null;
    if (!voice) return interaction.reply({ content: "❌ Du hast keinen eigenen Join-to-Create-Call.", ephemeral: true });

    const targetId = interaction.values[0];
    if (targetId === interaction.user.id) {
      return interaction.reply({ content: "❌ Du kannst dich nicht selbst entfernen.", ephemeral: true });
    }

    const target = voice.guild.members.cache.get(targetId);
    if (!target || !voice.members.has(targetId)) {
      return interaction.reply({ content: "❌ Dieses Mitglied ist nicht in deinem Call.", ephemeral: true });
    }

    await target.voice.disconnect("Vom Besitzer des Calls entfernt");
    return interaction.reply({ content: `✅ ${target.user.tag} wurde aus deinem Call entfernt.`, ephemeral: true });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "zeitplan_days") {
    const pending = zeitplanPending.get(interaction.user.id);
    if (!pending) {
      return interaction.update({ content: "❌ Diese Auswahl ist abgelaufen. Bitte führe /zeitplan erneut aus.", components: [] });
    }
    zeitplanPending.delete(interaction.user.id);

    const days = interaction.values.map(Number).sort((a, b) => a - b).map(v => WEEKDAYS[v - 1]);
    const isVideo = pending.typ === "video";
    const embed = new EmbedBuilder()
      .setTitle(`${isVideo ? "🎬 Video" : "📺 Stream"}-Zeitplan`)
      .setColor(0x9b5cff)
      .addFields(
        { name: "📅 Tage", value: days.length === 7 ? "Täglich" : days.join(", ") },
        { name: "🕒 Uhrzeit", value: `${pending.uhrzeit} Uhr` }
      )
      .setTimestamp();
    if (pending.titel) embed.setDescription(`**${pending.titel}**`);
    if (pending.notiz) embed.addFields({ name: "📝 Hinweis", value: pending.notiz });

    try {
      const target = interaction.guild?.channels.cache.get(pending.channelId) || interaction.channel;
      await target.send({ embeds: [embed] });
      log(interaction.guild, `${interaction.user.tag} hat einen ${isVideo ? "Video" : "Stream"}-Zeitplan gepostet.`);
      return interaction.update({ content: "✅ Zeitplan wurde gepostet.", components: [] });
    } catch (e) {
      console.error("Zeitplan:", e);
      return interaction.update({ content: "❌ Ich konnte den Zeitplan nicht senden. Prüfe meine Rechte im Kanal.", components: [] });
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith("voice_")) {
    const voice = interaction.guild ? getOwnedVoiceChannel(interaction.guild, interaction.user.id) : null;
    if (!voice) return interaction.reply({ content: "❌ Du hast keinen eigenen Join-to-Create-Call.", ephemeral: true });

    if (interaction.customId === "voice_rename") {
      const modal = new ModalBuilder()
        .setCustomId("voice_rename_modal")
        .setTitle("Call umbenennen");
      const input = new TextInputBuilder()
        .setCustomId("voice_name")
        .setLabel("Neuer Name")
        .setPlaceholder("z. B. ➕join to create")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(95)
        .setValue(voice.name.replace(/^『[^』]+』\s*/u, ""));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "voice_limit") {
      const select = new StringSelectMenuBuilder()
        .setCustomId("voice_limit_select")
        .setPlaceholder("Nutzerlimit auswählen")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("Unbegrenzt").setValue("0").setEmoji("♾️"),
          ...[2, 5, 10, 15, 25, 50].map(value =>
            new StringSelectMenuOptionBuilder().setLabel(`${value} Nutzer`).setValue(String(value)).setEmoji("👥")
          )
        );
      return interaction.reply({
        content: `Aktuelles Limit: ${voice.userLimit || "unbegrenzt"}`,
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true
      });
    }

    if (interaction.customId === "voice_kick") {
      const select = new UserSelectMenuBuilder()
        .setCustomId("voice_kick_select")
        .setPlaceholder("Mitglied aus deinem Call auswählen")
        .setMinValues(1)
        .setMaxValues(1);
      return interaction.reply({
        content: "Wähle ein Mitglied aus, das aus deinem Call entfernt werden soll.",
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true
      });
    }

    if (interaction.customId === "voice_lock") {
      await voice.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
      return interaction.reply({ content: "🔒 Dein Call ist jetzt gesperrt.", ephemeral: true });
    }

    if (interaction.customId === "voice_unlock") {
      await voice.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
      return interaction.reply({ content: "🔓 Dein Call ist wieder offen.", ephemeral: true });
    }

    if (interaction.customId === "voice_hide") {
      await voice.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
      return interaction.reply({ content: "🙈 Dein Call ist jetzt unsichtbar.", ephemeral: true });
    }

    if (interaction.customId === "voice_show") {
      await voice.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null });
      return interaction.reply({ content: "👀 Dein Call ist wieder sichtbar.", ephemeral: true });
    }

    if (interaction.customId === "voice_delete") {
      removeVoiceOwner(voice.id);
      await voice.delete();
      return interaction.reply({ content: "🗑️ Dein Call wurde gelöscht.", ephemeral: true });
    }
  }

  if (interaction.isButton() && interaction.customId === "ticket_open_support") {
    const modal = new ModalBuilder().setCustomId("support_modal").setTitle("Support-Anfrage");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("support_betreff").setLabel("Betreff").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("support_beschreibung").setLabel("Beschreibung").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
      )
    );
    return interaction.showModal(modal);
  }

  if (interaction.isButton() && interaction.customId === "ticket_open_verleih") {
    const items = Object.entries(itemsTable(interaction.guild.id)).filter(([, it]) => it.verfuegbar);
    if (!items.length) {
      return interaction.reply({ content: "❌ Aktuell ist kein Item im Katalog verfügbar. Wende dich an einen Admin.", ephemeral: true });
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId("verleih_item_select")
      .setPlaceholder("Wähle ein Item aus")
      .addOptions(items.slice(0, 25).map(([id, it]) =>
        new StringSelectMenuOptionBuilder().setLabel(it.name.slice(0, 100)).setValue(id).setDescription((it.beschreibung || "").slice(0, 100) || undefined)
      ));
    return interaction.reply({
      content: "Welches Item möchtest du ausleihen?",
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true
    });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "verleih_item_select") {
    const id = interaction.values[0];
    const item = itemsTable(interaction.guild.id)[id];
    if (!item || !item.verfuegbar) {
      return interaction.update({ content: "❌ Dieses Item ist nicht mehr verfügbar. Bitte erneut versuchen.", components: [] });
    }
    verleihPending.set(interaction.user.id, { itemId: id, guildId: interaction.guild.id });
    setTimeout(() => {
      const p = verleihPending.get(interaction.user.id);
      if (p && p.itemId === id) verleihPending.delete(interaction.user.id);
    }, 5 * 60 * 1000);

    const modal = new ModalBuilder().setCustomId("verleih_modal").setTitle(`Ausleihe: ${item.name}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("verleih_zeitraum").setLabel("Zeitraum (von – bis)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("verleih_notiz").setLabel("Notiz (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
      )
    );
    return interaction.showModal(modal);
  }

  if (interaction.isButton() && (interaction.customId === "verleih_approve" || interaction.customId === "verleih_decline")) {
    if (!isStaff(interaction.member)) return interaction.reply({ content: "❌ Nur das Team kann Anfragen bearbeiten.", ephemeral: true });
    const reqId = interaction.channel.id;
    const req = db.verleihRequests[reqId];
    if (!req) return interaction.reply({ content: "❌ Zu dieser Anfrage liegen keine Daten mehr vor.", ephemeral: true });

    const items = itemsTable(interaction.guild.id);
    const item = items[req.itemId];
    const approve = interaction.customId === "verleih_approve";

    if (approve) {
      if (item) item.verfuegbar = false;
      save();
      await interaction.reply({ embeds: [new EmbedBuilder().setDescription(`✅ Genehmigt von ${interaction.user}. Viel Spaß mit **${item?.name || req.itemName}**!`).setColor(0x57f287)] });
    } else {
      await interaction.reply({ embeds: [new EmbedBuilder().setDescription(`❌ Abgelehnt von ${interaction.user}.`).setColor(0xed4245)] });
    }

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verleih_approve").setLabel("Genehmigen").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("verleih_decline").setLabel("Ablehnen").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow, interaction.message.components[1]] }).catch(() => {});
    delete db.verleihRequests[reqId];
    save();
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket_close") {
    if (!isStaff(interaction.member)) return interaction.reply({ content: "❌ Nur das Team kann Tickets schließen.", ephemeral: true });
    const reqId = interaction.channel.id;
    if (db.verleihRequests[reqId]) {
      const item = itemsTable(interaction.guild.id)[db.verleihRequests[reqId].itemId];
      if (item) item.verfuegbar = true;
      delete db.verleihRequests[reqId];
      save();
    }
    await interaction.reply("🔒 Ticket wird geschlossen...");
    setTimeout(() => interaction.channel?.delete().catch(() => {}), 1500);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "support_modal") {
    const guild = interaction.guild, c = cfg(guild.id);
    const existing = guild.channels.cache.find(x => x.topic === `ticket:${interaction.user.id}`);
    if (existing) return interaction.reply({ content: `Du hast bereits ein offenes Support-Ticket: ${existing}`, ephemeral: true });

    const betreff = interaction.fields.getTextInputValue("support_betreff").trim();
    const beschreibung = interaction.fields.getTextInputValue("support_beschreibung").trim();
    const chan = await openTicketChannel(guild, interaction.user, {
      prefix: "support",
      topic: `ticket:${interaction.user.id}`,
      category: c.ticketCategory,
      embed: new EmbedBuilder()
        .setTitle(`🛠️ ${betreff}`)
        .setDescription(beschreibung)
        .setColor(0x9b5cff)
        .setFooter({ text: "Support-Ticket" })
    });
    log(guild, `${interaction.user.tag} hat ein Support-Ticket eröffnet: ${betreff}`);
    return interaction.reply({ content: `✅ Ticket erstellt: ${chan}`, ephemeral: true });
  }

  if (interaction.isModalSubmit() && interaction.customId === "verleih_modal") {
    const pending = verleihPending.get(interaction.user.id);
    if (!pending) return interaction.reply({ content: "❌ Deine Auswahl ist abgelaufen. Bitte starte erneut über den Button.", ephemeral: true });
    verleihPending.delete(interaction.user.id);

    const guild = interaction.guild, c = cfg(guild.id);
    const item = itemsTable(guild.id)[pending.itemId];
    if (!item || !item.verfuegbar) {
      return interaction.reply({ content: "❌ Dieses Item ist inzwischen nicht mehr verfügbar.", ephemeral: true });
    }
    const existing = guild.channels.cache.find(x => x.topic === `verleih:${interaction.user.id}`);
    if (existing) return interaction.reply({ content: `Du hast bereits eine offene Verleih-Anfrage: ${existing}`, ephemeral: true });

    const zeitraum = interaction.fields.getTextInputValue("verleih_zeitraum").trim();
    const notiz = interaction.fields.getTextInputValue("verleih_notiz")?.trim();

    const embed = new EmbedBuilder()
      .setTitle(`📦 Ausleihe: ${item.name}`)
      .setColor(0x9b5cff)
      .addFields(
        { name: "Antragsteller", value: `${interaction.user}`, inline: true },
        { name: "Zeitraum", value: zeitraum, inline: true }
      )
      .setFooter({ text: "Verleih-Anfrage – wartet auf Genehmigung" });
    if (item.beschreibung) embed.addFields({ name: "Item-Beschreibung", value: item.beschreibung });
    if (notiz) embed.addFields({ name: "Notiz", value: notiz });

    const approveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verleih_approve").setLabel("Genehmigen").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("verleih_decline").setLabel("Ablehnen").setEmoji("❌").setStyle(ButtonStyle.Danger)
    );

    const chan = await openTicketChannel(guild, interaction.user, {
      prefix: "verleih",
      topic: `verleih:${interaction.user.id}`,
      category: c.ticketCategory,
      embed,
      extraRow: approveRow
    });
    db.verleihRequests[chan.id] = { itemId: pending.itemId, itemName: item.name, userId: interaction.user.id, guildId: guild.id };
    save();
    log(guild, `${interaction.user.tag} möchte "${item.name}" ausleihen (${zeitraum}).`);
    return interaction.reply({ content: `✅ Anfrage erstellt: ${chan}`, ephemeral: true });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member, channel } = interaction;

  try {
    if (commandName === "help") {
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle("🤖 Squizyys Bot").setDescription(
        "**Moderation:** `/clear` `/kick` `/ban` `/timeout` `/warn` `/warnings`\n" +
        "**Community:** `/announce` `/poll` `/say` `/zeitplan`\n" +
        "**Level:** `/rank` `/leaderboard` `/levelrole` `/levelchannel` `/xp`\n" +
        "**Verleih:** `/item`\n" +
        "**Channels:** `/lock` `/unlock` `/slowmode` `/format` `/glowup`\n" +
        "**System:** `/setup` `/config` `/setlogs` `/ticket` `/joincreate` `/voicepanel`"
      ).setColor(0x9b5cff)] });
    }

    if (commandName === "setup") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: "❌ Du brauchst Server verwalten.", ephemeral: true });
      const category = await guild.channels.create({ name: "🎫｜SUPPORT", type: ChannelType.GuildCategory }).catch(() => null);
      const ticket = await guild.channels.create({ name: "🎫｜tickets", type: ChannelType.GuildText, parent: category?.id || null }).catch(() => null);
      if (ticket) {
        await ticket.send(ticketPanel());
      }
      if (category) cfg(guild.id).ticketCategory = category.id;
      save();
      return interaction.reply("✅ Grundsetup abgeschlossen. Ein Ticket-Bereich wurde erstellt.");
    }

    if (commandName === "setlogs") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "❌ Du brauchst die Berechtigung „Server verwalten“.", ephemeral: true });
      }
      if (channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: "❌ Führe den Befehl in einem Textkanal aus.", ephemeral: true });
      }

      cfg(guild.id).logChannel = channel.id;
      save();
      return interaction.reply(`✅ Alle Bot-Logs werden ab jetzt in ${channel} geschrieben.`);
    }

    if (commandName === "config") {
      const c = cfg(guild.id);
      return interaction.reply({ ephemeral: true, content:
        `⚙️ **Konfiguration**\nWelcome: ${c.welcomeChannel ? `<#${c.welcomeChannel}>` : "nicht gesetzt"}\nLogs: ${c.logChannel ? `<#${c.logChannel}>` : "nicht gesetzt"}\nTicket-Kategorie: ${c.ticketCategory ? `<#${c.ticketCategory}>` : "nicht gesetzt"}\nJoin-to-Create: ${c.joinCreateChannel ? `<#${c.joinCreateChannel}>` : "nicht gesetzt"}\nEmoji-Format: ${c.emojiFormat ? "an" : "aus"}\nLevel-Kanal: ${c.levelChannel ? `<#${c.levelChannel}>` : "Kanal der Nachricht"}\nLevel-Rollen: ${Object.keys(c.levelRoles || {}).length}`
      });
    }

    if (commandName === "clear") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageMessages)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const n = interaction.options.getInteger("anzahl");
      await interaction.deferReply({ ephemeral: true });
      const messages = await channel.bulkDelete(n, true);
      await interaction.editReply(`🧹 ${messages.size} Nachrichten gelöscht.`);
      return;
    }

    if (["kick", "ban", "timeout", "warn", "warnings"].includes(commandName)) {
      const user = interaction.options.getUser("mitglied");
      const target = await guild.members.fetch(user.id).catch(() => null);
      if (!target && commandName !== "warnings") return interaction.reply({ content: "❌ Mitglied nicht gefunden.", ephemeral: true });

      if (commandName === "kick") {
        if (!ok(interaction, PermissionsBitField.Flags.KickMembers)) return interaction.reply({ content: "❌ Keine Kick-Berechtigung.", ephemeral: true });
        if (!target.kickable) return interaction.reply({ content: "❌ Ich kann dieses Mitglied nicht kicken.", ephemeral: true });
        await target.kick(interaction.options.getString("grund") || "Kein Grund angegeben");
        await interaction.reply(`👢 ${user} wurde gekickt.`);
        return log(guild, `${user.tag} wurde von ${interaction.user.tag} gekickt.`);
      }
      if (commandName === "ban") {
        if (!ok(interaction, PermissionsBitField.Flags.BanMembers)) return interaction.reply({ content: "❌ Keine Ban-Berechtigung.", ephemeral: true });
        if (!target.bannable) return interaction.reply({ content: "❌ Ich kann dieses Mitglied nicht bannen.", ephemeral: true });
        await target.ban({ reason: interaction.options.getString("grund") || "Kein Grund angegeben" });
        await interaction.reply(`🔨 ${user} wurde gebannt.`);
        return log(guild, `${user.tag} wurde von ${interaction.user.tag} gebannt.`);
      }
      if (commandName === "timeout") {
        if (!ok(interaction, PermissionsBitField.Flags.ModerateMembers)) return interaction.reply({ content: "❌ Keine Timeout-Berechtigung.", ephemeral: true });
        await target.timeout(interaction.options.getInteger("minuten") * 60000, interaction.options.getString("grund") || "Kein Grund angegeben");
        await interaction.reply(`⏱️ ${user} erhielt einen Timeout.`);
        return log(guild, `${user.tag} erhielt von ${interaction.user.tag} einen Timeout.`);
      }
      if (commandName === "warn") {
        if (!isStaff(member)) return interaction.reply({ content: "❌ Nur das Team.", ephemeral: true });
        const reason = interaction.options.getString("grund");
        const c = cfg(guild.id);
        c.warnings[user.id] ??= [];
        c.warnings[user.id].push({ reason, moderator: interaction.user.id, at: new Date().toISOString() });
        save();
        await interaction.reply(`⚠️ ${user} wurde verwarnt.`);
        return log(guild, `${user.tag} wurde verwarnt: ${reason}`);
      }
      if (commandName === "warnings") {
        const list = cfg(guild.id).warnings[user.id] || [];
        return interaction.reply({ ephemeral: true, content: list.length ? list.map((w, i) => `${i + 1}. ${w.reason}`).join("\n") : "Keine Verwarnungen." });
      }
    }

    if (commandName === "announce") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const text = interaction.options.getString("text");
      await interaction.reply({ content: "✅ Gesendet.", ephemeral: true });
      return channel.send({ embeds: [new EmbedBuilder().setTitle("📢 Ankündigung").setDescription(text).setColor(0x9b5cff).setTimestamp()] });
    }

    if (commandName === "poll") {
      const q = interaction.options.getString("frage");
      const msg = await channel.send({ embeds: [new EmbedBuilder().setTitle("📊 Umfrage").setDescription(q).setColor(0x9b5cff)] });
      await msg.react("👍");
      await msg.react("👎");
      return interaction.reply({ content: "✅ Umfrage erstellt.", ephemeral: true });
    }

    if (commandName === "say") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageMessages)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const text = interaction.options.getString("text");
      await interaction.reply({ content: "✅", ephemeral: true });
      return channel.send(text);
    }

    if (commandName === "lock" || commandName === "unlock") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const deny = commandName === "lock";
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: deny });
      return interaction.reply(deny ? "🔒 Kanal gesperrt." : "🔓 Kanal entsperrt.");
    }

    if (commandName === "slowmode") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const sec = interaction.options.getInteger("sekunden");
      await channel.setRateLimitPerUser(sec);
      return interaction.reply(`🐢 Slowmode: ${sec} Sekunden.`);
    }

    if (commandName === "ticket") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      await channel.send(ticketPanel());
      return interaction.reply({ content: "✅ Ticket-Panel erstellt.", ephemeral: true });
    }

    if (commandName === "item") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: "❌ Du brauchst die Berechtigung „Server verwalten“.", ephemeral: true });
      const items = itemsTable(guild.id);
      const sub = interaction.options.getSubcommand();

      if (sub === "hinzufuegen") {
        const name = interaction.options.getString("name").trim();
        const id = itemId(name);
        if (items[id]) return interaction.reply({ content: "❌ Ein Item mit diesem Namen gibt es schon.", ephemeral: true });
        items[id] = { name, beschreibung: interaction.options.getString("beschreibung")?.trim() || null, verfuegbar: true };
        save();
        return interaction.reply({ content: `✅ **${name}** wurde zum Verleih-Katalog hinzugefügt.`, ephemeral: true });
      }

      if (sub === "entfernen") {
        const id = itemId(interaction.options.getString("name").trim());
        if (!items[id]) return interaction.reply({ content: "❌ Dieses Item gibt es nicht im Katalog.", ephemeral: true });
        delete items[id];
        save();
        return interaction.reply({ content: "✅ Item wurde entfernt.", ephemeral: true });
      }

      const entries = Object.values(items);
      if (!entries.length) return interaction.reply({ content: "Der Verleih-Katalog ist leer.", ephemeral: true });
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📦 Verleih-Katalog")
            .setColor(0x9b5cff)
            .setDescription(entries.map(it => `${it.verfuegbar ? "🟢" : "🔴"} **${it.name}**${it.beschreibung ? ` – ${it.beschreibung}` : ""}`).join("\n"))
        ],
        ephemeral: true
      });
    }

    if (commandName === "joincreate") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      if (channel.type !== ChannelType.GuildVoice) return interaction.reply({ content: "❌ Nutze den Befehl in einem Voice-Channel.", ephemeral: true });
      const c = cfg(guild.id);
      c.joinCreateChannel = channel.id;
      c.joinCreateCategory = channel.parentId;
      save();
      return interaction.reply(`🔊 ${channel} ist jetzt dein Join-to-Create-Kanal.`);
    }

    if (commandName === "voicepanel") {
      const voice = getOwnedVoiceChannel(guild, interaction.user.id);
      if (!voice) return interaction.reply({ content: "❌ Du hast keinen eigenen Join-to-Create-Call.", ephemeral: true });
      await voice.send(voicePanel(voice));
      return interaction.reply({ content: `✅ Das Verwaltungs-Panel wurde in ${voice} gepostet.`, ephemeral: true });
    }

    if (commandName === "format") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      const target = interaction.options.getChannel("kanal") || channel;
      const newName = formatChannelName(target.name);
      if (!newName) return interaction.reply({ content: "❌ Der Kanalname muss mit einem Emoji beginnen, z. B. ➕join to create.", ephemeral: true });
      await target.setName(newName);
      return interaction.reply(`✅ ${target} formatiert.`);
    }

    if (commandName === "rank") {
      const user = interaction.options.getUser("mitglied") || interaction.user;
      if (user.bot) return interaction.reply({ content: "❌ Bots sammeln keine XP.", ephemeral: true });
      const entry = xpTable(guild.id)[user.id];
      if (!entry) return interaction.reply({ content: `${user} hat noch keine XP gesammelt.`, ephemeral: true });
      const position = xpRanking(guild.id).findIndex(([id]) => id === user.id) + 1;
      const { level, current, needed } = levelFromXp(entry.xp);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📈 Rang von ${user.username}`)
            .setThumbnail(user.displayAvatarURL())
            .setColor(0x9b5cff)
            .addFields(
              { name: "Rang", value: `#${position}`, inline: true },
              { name: "Level", value: String(level), inline: true },
              { name: "Gesamt-XP", value: String(entry.xp), inline: true },
              { name: "Fortschritt", value: `${progressBar(current, needed)} ${current}/${needed} XP` }
            )
        ]
      });
    }

    if (commandName === "leaderboard") {
      const ranking = xpRanking(guild.id);
      if (!ranking.length) return interaction.reply({ content: "Noch niemand hat XP gesammelt.", ephemeral: true });
      const pages = Math.ceil(ranking.length / 10);
      const page = Math.min(interaction.options.getInteger("seite") || 1, pages);
      const start = (page - 1) * 10;
      const medals = ["🥇", "🥈", "🥉"];
      const lines = ranking.slice(start, start + 10).map(([id, e], i) => {
        const pos = start + i;
        return `${medals[pos] || `**${pos + 1}.**`} <@${id}> – Level ${levelFromXp(e.xp).level} · ${e.xp} XP`;
      });
      const own = ranking.findIndex(([id]) => id === interaction.user.id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🏆 Leaderboard")
            .setDescription(lines.join("\n"))
            .setColor(0x9b5cff)
            .setFooter({ text: `Seite ${page}/${pages}${own >= 0 ? ` • Dein Rang: #${own + 1}` : ""}` })
        ]
      });
    }

    if (commandName === "levelrole") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: "❌ Du brauchst die Berechtigung „Rollen verwalten“.", ephemeral: true });
      }
      const c = cfg(guild.id);
      c.levelRoles ??= {};
      const sub = interaction.options.getSubcommand();

      if (sub === "setzen") {
        const level = interaction.options.getInteger("level");
        const role = interaction.options.getRole("rolle");
        const me = guild.members.me ?? await guild.members.fetchMe();
        if (role.managed || role.id === guild.id) {
          return interaction.reply({ content: "❌ Diese Rolle kann nicht vergeben werden.", ephemeral: true });
        }
        if (role.position >= me.roles.highest.position) {
          return interaction.reply({ content: "❌ Die Rolle steht auf oder über meiner höchsten Rolle. Schiebe die Bot-Rolle in der Rollenliste nach oben.", ephemeral: true });
        }
        c.levelRoles[level] = role.id;
        save();
        return interaction.reply({ content: `✅ Ab Level ${level} gibt es ${role}.`, ephemeral: true });
      }

      if (sub === "entfernen") {
        const level = interaction.options.getInteger("level");
        if (!c.levelRoles[level]) return interaction.reply({ content: "❌ Für dieses Level ist keine Rolle eingestellt.", ephemeral: true });
        delete c.levelRoles[level];
        save();
        return interaction.reply({ content: `✅ Die Belohnung für Level ${level} wurde entfernt.`, ephemeral: true });
      }

      const entries = Object.entries(c.levelRoles).sort((a, b) => Number(a[0]) - Number(b[0]));
      return interaction.reply({
        content: entries.length ? entries.map(([lvl, roleId]) => `Level ${lvl} → <@&${roleId}>`).join("\n") : "Es sind noch keine Level-Rollen eingestellt.",
        ephemeral: true
      });
    }

    if (commandName === "levelchannel") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "❌ Du brauchst die Berechtigung „Server verwalten“.", ephemeral: true });
      }
      const target = interaction.options.getChannel("kanal");
      const c = cfg(guild.id);
      if (!target) {
        c.levelChannel = null;
        save();
        return interaction.reply({ content: "✅ Level-Ups werden wieder im jeweiligen Kanal angezeigt.", ephemeral: true });
      }
      c.levelChannel = target.id;
      save();
      return interaction.reply({ content: `✅ Level-Ups werden ab jetzt in ${target} angezeigt.`, ephemeral: true });
    }

    if (commandName === "xp") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "❌ Keine Berechtigung.", ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser("mitglied");
      if (user.bot) return interaction.reply({ content: "❌ Bots sammeln keine XP.", ephemeral: true });

      if (sub === "geben") {
        const amount = interaction.options.getInteger("menge");
        const target = await guild.members.fetch(user.id).catch(() => null);
        if (!target) return interaction.reply({ content: "❌ Mitglied nicht gefunden.", ephemeral: true });
        await addXp(target, amount, channel);
        const total = xpTable(guild.id)[user.id].xp;
        return interaction.reply({ content: `✅ ${user} hat ${amount} XP erhalten (jetzt Level ${levelFromXp(total).level}, ${total} XP).`, ephemeral: true });
      }

      delete xpTable(guild.id)[user.id];
      save();
      return interaction.reply({ content: `✅ Die XP von ${user} wurden zurückgesetzt.`, ephemeral: true });
    }

    if (commandName === "zeitplan") {
      if (!isStaff(member)) return interaction.reply({ content: "❌ Nur das Team kann Zeitpläne erstellen.", ephemeral: true });

      const typ = interaction.options.getString("typ");
      const timeMatch = interaction.options.getString("uhrzeit").trim().match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
      if (!timeMatch) {
        return interaction.reply({ content: "❌ Bitte gib die Uhrzeit im Format HH:MM an, z. B. 18:00.", ephemeral: true });
      }

      const entry = {
        typ,
        uhrzeit: `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`,
        titel: interaction.options.getString("titel")?.trim() || null,
        notiz: interaction.options.getString("notiz")?.trim() || null,
        channelId: channel.id
      };
      zeitplanPending.set(interaction.user.id, entry);
      setTimeout(() => {
        if (zeitplanPending.get(interaction.user.id) === entry) zeitplanPending.delete(interaction.user.id);
      }, 5 * 60 * 1000);

      const select = new StringSelectMenuBuilder()
        .setCustomId("zeitplan_days")
        .setPlaceholder("Wähle die Tage aus")
        .setMinValues(1)
        .setMaxValues(7)
        .addOptions(WEEKDAYS.map((name, i) =>
          new StringSelectMenuOptionBuilder().setLabel(name).setValue(String(i + 1))
        ));

      return interaction.reply({
        content: `${typ === "video" ? "🎬 Video" : "📺 Stream"} um ${entry.uhrzeit} Uhr – an welchen Tagen?`,
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true
      });
    }

    if (commandName === "glowup") {
      if (!ok(interaction, PermissionsBitField.Flags.ManageChannels)) {
        return interaction.reply({ content: "❌ Du brauchst die Berechtigung „Kanäle verwalten“.", ephemeral: true });
      }

      const target = interaction.options.getChannel("kanal") || channel;
      if (!target || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(target.type)) {
        return interaction.reply({ content: "❌ `/glowup` funktioniert nur in Text- oder Ankündigungskanälen.", ephemeral: true });
      }

      const requestedName = interaction.options.getString("name")?.trim();
      const currentBaseName = target.name.replace(/^『[^』]+』\s*/u, "").trim();
      const nameSource = requestedName || currentBaseName;
      const formattedName = formatChannelName(nameSource) || formatChannelName(`✨ ${nameSource}`);
      if (!formattedName) {
        return interaction.reply({ content: "❌ Der Kanalname konnte nicht formatiert werden.", ephemeral: true });
      }

      const requestedDescription = interaction.options.getString("beschreibung")?.trim();
      const description = (requestedDescription || target.topic || `✨ Willkommen in ${target}! Bitte bleibt freundlich und respektvoll.`).slice(0, 1024);

      await target.setName(formattedName.slice(0, 100));
      await target.setTopic(description);
      await target.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        AddReactions: true
      });
      await target.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`✨ ${target.name}`)
            .setDescription(description)
            .setColor(0x9b5cff)
            .setFooter({ text: "Channel Glow Up" })
            .setTimestamp()
        ]
      });

      log(guild, `${interaction.user.tag} hat ${target.name} ein Channel-Glow-Up gegeben.`);
      return interaction.reply({ content: `✨ ${target} hat jetzt ein Glow Up bekommen.`, ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Es ist ein Fehler aufgetreten. Prüfe die Bot-Berechtigungen und die Konsole.", ephemeral: true }).catch(() => {});
    }
  }
});

client.on("error", console.error);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { save(); } catch {}
    process.exit(0);
  });
}
process.on("unhandledRejection", console.error);

client.login(TOKEN);
