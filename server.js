const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 7860;
const FRIENDS_STORAGE = 'friends.json';
const DM_STORAGE = 'dms_v2.json';

// friendsData: { "userId": { status: "accepted"|"pending_outgoing"|"pending_incoming", since: timestamp } }
let friendsData = {};
try {
    if (fs.existsSync(FRIENDS_STORAGE)) {
        const raw = JSON.parse(fs.readFileSync(FRIENDS_STORAGE));
        if (Array.isArray(raw)) {
            raw.forEach(id => { friendsData[id] = { status: 'accepted', since: Date.now() }; });
        } else {
            friendsData = raw;
        }
    }
} catch (e) {}

let dmMetadata = {};
try { if (fs.existsSync(DM_STORAGE)) dmMetadata = JSON.parse(fs.readFileSync(DM_STORAGE)); } catch (e) {}

function saveFriends() { try { fs.writeFileSync(FRIENDS_STORAGE, JSON.stringify(friendsData)); } catch(e){} }
function saveDMs() { try { fs.writeFileSync(DM_STORAGE, JSON.stringify(dmMetadata)); } catch(e){} }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User, Partials.GuildMember],
});

let isReady = false;
app.use(express.static(__dirname));

function getAvatar(user) {
    return user?.displayAvatarURL({ size: 128 }) || 'https://cdn.discordapp.com/embed/avatars/0.png';
}

async function formatMessage(m) {
    try {
        const isDM = m.channel.type === 1;
        const isMentioned = m.mentions.has(client.user) || (m.reference && m.mentions?.repliedUser?.id === client.user.id);
        
        let refMsg = null;
        if (m.reference && m.reference.messageId) {
            try {
                const fetchedRef = await m.channel.messages.fetch(m.reference.messageId);
                refMsg = {
                    author: fetchedRef.author.username,
                    authorAvatar: getAvatar(fetchedRef.author),
                    content: fetchedRef.cleanContent?.substring(0, 50) || '...'
                };
            } catch (e) {
                refMsg = {
                    author: m.mentions?.repliedUser?.username || 'User',
                    authorAvatar: getAvatar(m.mentions?.repliedUser),
                    content: 'Original message unavailable'
                };
            }
        }

        return {
            channelId: m.channel.id,
            isDM,
            recipientId: isDM ? (m.author.bot ? m.channel.recipientId : m.author.id) : null,
            author: m.author.username,
            authorId: m.author.id,
            content: m.cleanContent || '',
            avatar: getAvatar(m.author),
            timestamp: m.createdAt.toLocaleTimeString(),
            id: m.id,
            isMentioned,
            referencedMessage: refMsg,
        };
    } catch (e) { return null; }
}

client.on('ready', () => {
    isReady = true;
    console.log(`🚀 Ready: ${client.user.tag}`);
    const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png' }));
    io.emit('initData', { guilds });
});

client.on('messageCreate', async m => {
    try {
        if (m.channel.type === 1) {
            const id = m.author.bot ? m.channel.recipientId : m.author.id;
            if (id) {
                if (!dmMetadata[id]) dmMetadata[id] = { lastInteraction: 0, unreadCount: 0 };
                dmMetadata[id].lastInteraction = Date.now();
                if (!m.author.bot) {
                    dmMetadata[id].unreadCount = (dmMetadata[id].unreadCount || 0) + 1;
                }
                saveDMs();
                io.emit('refreshSidebar');
            }
        }
        const msg = await formatMessage(m);
        if (msg) io.emit('discordMessage', msg);
    } catch(e) {}
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isButton()) return;
        const cid = interaction.customId;
        
        if (cid.startsWith('friend_accept_')) {
            const botId = cid.replace('friend_accept_', '');
            if (botId !== client.user.id) return;
            const userId = interaction.user.id;
            if (!friendsData[userId]) friendsData[userId] = { status: 'accepted', since: Date.now() };
            else friendsData[userId].status = 'accepted';
            saveFriends();
            if (!dmMetadata[userId]) { dmMetadata[userId] = { lastInteraction: Date.now(), unreadCount: 0 }; saveDMs(); }
            await interaction.update({ content: `✅ You are now friends with **${client.user.username}**!`, components: [] });
            io.emit('refreshSidebar');
        }
        
        if (cid.startsWith('friend_decline_')) {
            const botId = cid.replace('friend_decline_', '');
            if (botId !== client.user.id) return;
            const userId = interaction.user.id;
            if (friendsData[userId]) { delete friendsData[userId]; saveFriends(); }
            await interaction.update({ content: `❌ Friend request from **${client.user.username}** declined.`, components: [] });
        }
    } catch(e) {}
});

io.on('connection', (socket) => {
    if (isReady) {
        const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png' }));
        socket.emit('initData', { guilds });
    }

    socket.on('requestSidebar', async (id) => {
        try {
            if (!id) {
                const sorted = Object.keys(dmMetadata).sort((a,b)=>(dmMetadata[b].lastInteraction||0)-(dmMetadata[a].lastInteraction||0));
                const dms = [];
                for (const dmId of sorted) {
                    try {
                        const u = await client.users.fetch(dmId);
                        dms.push({ id: u.id, name: u.username, avatar: getAvatar(u), unreadCount: dmMetadata[dmId].unreadCount || 0 });
                    } catch(e){}
                }
                socket.emit('sidebarUpdate', { type: 'dm', dms, items: [{id:'friends', name:'Friends', icon:'👤'}] });
            } else {
                const guild = await client.guilds.fetch(id);
                const channels = await guild.channels.fetch();
                const categories = channels.filter(c => c.type === 4).sort((a,b)=>a.position-b.position).map(cat => ({
                    name: cat.name,
                    channels: channels.filter(c => c.parentId === cat.id && [0,5].includes(c.type)).sort((a,b)=>a.position-b.position).map(c => ({ id: c.id, name: c.name }))
                }));
                socket.emit('sidebarUpdate', { type: 'server', categories });
            }
        } catch(e){}
    });

    socket.on('requestFriends', async () => {
        try {
            const accepted = [], pending = [];
            for (const [id, data] of Object.entries(friendsData)) {
                try {
                    const user = await client.users.fetch(id);
                    let presence = 'offline', activity = null;
                    client.guilds.cache.forEach(g => {
                        const m = g.members.cache.get(id);
                        if (m?.presence) { presence = m.presence.status; activity = m.presence.activities[0]?.name || null; }
                    });
                    const entry = { id: user.id, name: user.username, avatar: getAvatar(user), status: presence, activity, friendStatus: data.status };
                    if (data.status === 'accepted') accepted.push(entry);
                    else pending.push(entry);
                } catch(e){}
            }
            socket.emit('friendsData', { accepted, pending });
        } catch(e){}
    });

    socket.on('addFriend', async (id) => {
        try {
            if (!id) return;
            if (friendsData[id]) return;
            friendsData[id] = { status: 'pending_outgoing', since: Date.now() };
            saveFriends();
            const user = await client.users.fetch(id);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`friend_accept_${client.user.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`friend_decline_${client.user.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)
            );
            const dm = await user.createDM();
            await dm.send({ content: `👋 **${client.user.username}** wants to add you as a friend!`, components: [row] });
            io.emit('refreshSidebar');
        } catch(e) {}
    });

    socket.on('acceptFriend', (id) => {
        if (friendsData[id] && friendsData[id].status === 'pending_incoming') {
            friendsData[id].status = 'accepted';
            saveFriends();
            if (!dmMetadata[id]) { dmMetadata[id] = { lastInteraction: Date.now(), unreadCount: 0 }; saveDMs(); }
            io.emit('refreshSidebar');
        }
    });

    socket.on('declineFriend', (id) => {
        if (friendsData[id]) { delete friendsData[id]; saveFriends(); }
    });

    socket.on('removeDM', (id) => {
        if (dmMetadata[id]) { delete dmMetadata[id]; saveDMs(); socket.emit('refreshSidebar'); }
    });

    socket.on('getUserProfile', async (id) => {
        try {
            const user = await client.users.fetch(id);
            const mutual = client.guilds.cache.filter(g => g.members.cache.has(id)).size;
            socket.emit('userProfileData', { id: user.id, username: user.username, displayName: user.globalName || user.username, avatar: getAvatar(user), bannerColor: user.accentColor || '#5865f2', mutualServers: mutual });
        } catch (e) {}
    });

    socket.on('getHistory', async (id) => {
        try {
            let channel;
            try { channel = await client.channels.fetch(id); } catch {
                const user = await client.users.fetch(id);
                channel = await user.createDM();
                if (!dmMetadata[id]) { dmMetadata[id] = { lastInteraction: Date.now(), unreadCount: 0 }; saveDMs(); }
            }
            const messages = await channel.messages.fetch({ limit: 50 });
            const history = [];
            for (const m of messages.values()) {
                const f = await formatMessage(m);
                if (f) history.push(f);
            }
            socket.emit('history', { id, history: history.reverse() });
        } catch (e) {}
    });

    socket.on('getChannelMembers', async (data) => {
        try {
            const { channelId, isDM, query } = data;
            let members = [];
            if (isDM) {
                try {
                    const user = await client.users.fetch(channelId);
                    members.push({ id: user.id, username: user.username, avatar: getAvatar(user) });
                } catch(e) {}
            } else {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (channel?.guild) {
                        const guildMembers = await channel.guild.members.fetch({ limit: 50 });
                        guildMembers.forEach(m => {
                            members.push({ id: m.id, username: m.user.username, displayName: m.displayName, avatar: getAvatar(m.user) });
                        });
                    }
                } catch(e) {}
            }
            if (query) {
                const q = query.toLowerCase();
                members = members.filter(m => m.username.toLowerCase().includes(q) || (m.displayName && m.displayName.toLowerCase().includes(q)));
            }
            socket.emit('channelMembers', members.slice(0, 20));
        } catch(e) {}
    });

    socket.on('webMessage', async (data) => {
        try {
            let channel;
            if (data.isDM) {
                const user = await client.users.fetch(data.channelId);
                channel = await user.createDM();
                if (!dmMetadata[data.channelId]) dmMetadata[data.channelId] = { lastInteraction: Date.now(), unreadCount: 0 };
                dmMetadata[data.channelId].lastInteraction = Date.now();
                saveDMs();
            } else { channel = await client.channels.fetch(data.channelId); }
            if (channel) await channel.send({ content: data.content, reply: data.replyTo ? { messageReference: data.replyTo, failIfNotExists: false } : undefined });
        } catch (e) {}
    });
});

process.on('unhandledRejection', error => console.error(error));
server.listen(PORT, () => console.log(`🚀 Port: ${PORT}`));
client.login(DISCORD_TOKEN);
