const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const sequelize = require('./sequelize');
const he = require('he');
const TurndownService = require('turndown');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

let dataLock = false;
let syncInterval = null;
const INTERVAL_MINUTES = 2;

// CTF Configuration
let ctfConfig = null;
let isCtfActive = false;

class CTFConfig {
    constructor(baseUrl, username, password) {
        this.baseUrl = baseUrl;
        this.username = username;
        this.password = password;
    }
}

async function assertDatabaseConnectionOk() {
	console.log(`Checking database connection...`);
	try {
		await sequelize.authenticate();
	} catch (error) {
		console.log('Unable to connect to the database:', error.message);
		process.exit(1);
	}
}

const client = new Client({
     intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,  
    ],
 });

console.log("Booting...");

client.once('ready', async () => {
    await assertDatabaseConnectionOk();
    console.log("Ready!");    
});

client.on("messageCreate", async (message) => {
    if(message.author.bot) return;

    if(message.content.startsWith("^ctf_start")) {
        const args = message.content.split(" ");
        if(args.length < 4) {
            await message.reply("Usage: `^ctf_start <base_url> <username> <password>` (run inside the Discord forum channel)");
            return;
        }

        // Check if channel is a forum
        if(message.channel.type !== ChannelType.GuildForum) {
            await message.reply("ERROR: This command must be used in a Discord forum!");
            return;
        }

        const baseUrl = args[1];
        const username = args[2];
        const password = args[3];

        ctfConfig = new CTFConfig(baseUrl, username, password);
        isCtfActive = true;
        dataLock = false;

        await message.reply(`CTF started! URL: ${baseUrl}`);
        
        // Start sync interval
        if(syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(async () => {
            await listenForNewPosts();
        }, INTERVAL_MINUTES * 60 * 1000);

        // Fetch and post initial topics (import all recent topics)
        try {
            const resp = await axios.get(`${ctfConfig.baseUrl}/latest.json`, { timeout: 10000 });
            const topics = resp.data && resp.data.topic_list && resp.data.topic_list.topics ? resp.data.topic_list.topics : [];
            const threadModel = sequelize.models.thread;

            if(!topics.length) {
                await message.reply("WARNING: No topics found to import.");
            }

            dataLock = true;
            for(const topic of topics) {
                const topicId = topic.id;
                // Skip if already in DB
                const [dbThread, created] = await threadModel.findOrCreate({
                    where: { id: topicId },
                    defaults: { discord_channel: message.channel.id.replace(/<#(\\d+)>/, '$1'), discord_thread_id: null }
                });

                if(!created) {
                    console.log(`Topic ${topicId} already imported, skipping.`);
                    continue;
                }

                // Fetch all posts for this topic
                const posts = await fetchAllPosts(topicId);
                if(!posts || posts.length === 0) {
                    console.log(`No posts for topic ${topicId}, skipping creation.`);
                    continue;
                }

                // Create a Discord thread inside the forum channel
                const forumThread = await message.channel.threads.create({
                    name: posts[0].title.substring(0, 100),
                    autoArchiveDuration: 60
                });

                console.log(`Created forum thread: ${forumThread.name} (${forumThread.id}) for topic ${topicId}`);

                // Save the mapping
                try {
                    await dbThread.update({ discord_thread_id: `${forumThread.id}`, discord_channel: message.channel.id.replace(/<#(\\d+)>/, '$1') });
                } catch(e) { console.log('Error updating DB thread mapping', e.message); }

                // Post each message in the created thread
                for(const post of posts) {
                    const msg = await sendDiscordMessage(forumThread, post, dbThread);
                    if(msg) {
                        try {
                            await dbThread.createPost({
                                id: post.id,
                                post_number: post.post_number,
                                reply_to: post.reply_to,
                                discord_id: `${msg.id}`,
                                createdAt: new Date(post.created_at),
                                editedAt: new Date(post.updated_at)
                            });
                        }
                        catch(e) { console.log('Error saving post to DB', e.message); }
                    }
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            dataLock = false;
            await message.reply(`Initial import completed.`);
        }
        catch(err) {
            console.error('Error importing topics:', err.message);
            await message.reply('ERROR: Failed to import topics.');
            dataLock = false;
        }
    }

    if(message.content.startsWith("^ctf_stop")) {
        if(!isCtfActive) {
            await message.reply("CTF is not active.");
            return;
        }

        isCtfActive = false;
        if(syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
        ctfConfig = null;

        await message.reply("CTF stopped. Bot shutting down...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        process.exit(0);
    }
});

function convertHtmlToMarkdown(htmlContent) {
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-'
    });
    
    // Preserve links properly
    turndownService.addRule('link', {
        filter: 'a',
        replacement: function(content, node) {
            const href = node.getAttribute('href');
            const title = node.getAttribute('title');
            if (!href) return content;
            // Format: [text](url "title")
            return title ? `[${content}](${href} "${title}")` : `[${content}](${href})`;
        }
    });
  
    turndownService.addRule('heading', {
        filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        replacement: function(content, node, options) {
            const hLevel = Number(node.nodeName.charAt(1));
            const hash = '#'.repeat(hLevel);
            return `\n${hash} ${content}\n`;
        }
    });
  
    turndownService.addRule('bold', {
        filter: ['strong', 'b'],
        replacement: function(content) {
            return `**${content}**`;
        }
    });
    
    turndownService.addRule('italic', {
        filter: ['em', 'i'],
        replacement: function(content) {
            return `*${content}*`;
        }
    });
    
    turndownService.addRule('inlineCode', {
        filter: function(node) {
        return (
            node.nodeName === 'CODE' &&
            node.parentNode.nodeName !== 'PRE'
        );
        },
        replacement: function(content) {
            return `\`${content}\``;
        }
    });
    
    turndownService.addRule('codeBlock', {
        filter: 'pre',
        replacement: function(content) {
            return `\`\`\`\n${content}\n\`\`\`\n`;
        }
    });
    
    turndownService.addRule('listItem', {
        filter: 'li',
        replacement: function(content, node, options) {
            content = content.replace(/^\s+/, '').replace(/\n/gm, '\n  ');
            let prefix = '- ';
            const parent = node.parentNode;
            if (parent.nodeName === 'OL') {
                const start = parent.getAttribute('start');
                const index = Array.prototype.indexOf.call(parent.children, node);
                prefix = (start ? Number(start) + index : index + 1) + '. ';
            }
            return prefix + content;
        }
    });

    // Keep images as markdown links
    turndownService.addRule('image', {
        filter: 'img',
        replacement: (content, node) => {
            const src = node.getAttribute('src');
            const alt = node.getAttribute('alt') || 'image';
            return src ? `![${alt}](${src})` : '';
        }
    });

    return turndownService.turndown(htmlContent).trim();
}

async function sendDiscordMessage(threadChannel, post, thread) {
    const username = post.username;
    let content = convertHtmlToMarkdown(post.content);
    if(!content || content == '') content = "(empty message or error)";

    // Format: Author | timestamp | link to original
    const header = `**${username}** • ${new Date(post.created_at).toLocaleString('en-US')} • [Original post](${ctfConfig.baseUrl}/t/${thread.id}/${post.post_number})`;
    const fullContent = `${header}\n\n${content}`;

    // Max Discord message length is 2000
    let messageToSend = fullContent;
    if(fullContent.length > 2000) {
        messageToSend = `${fullContent.substring(0, 1900)}\n\n[...read more](${ctfConfig.baseUrl}/t/${thread.id}/${post.post_number})`;
    }

    try {
        if(post.reply_to) {
            // This is a reply - try to find the original post to reply to
            const threadPosts = await thread.getPosts({where: {post_number: post.reply_to}});            
            if(threadPosts.length > 0) {
                try {
                    const msg_id = `${threadPosts[0].discord_id}`;
                    const msg_ref = await threadChannel.messages.fetch(`${msg_id}`);            
                    return await msg_ref.reply(messageToSend);
                }
                catch(e) {
                    console.log("Cannot reply to message, posting normally instead");
                }
            }
        }
        return await threadChannel.send(messageToSend);
    }
    catch(e) {
        console.log("Error sending message:", e.message);
        return null;
    }
}

async function listenForNewPosts() {
    if(!isCtfActive || !ctfConfig) {
        console.log("CTF not active, skipping listen");
        return;
    }

    if(dataLock) {
        console.log("Waiting for posts to sync ...");
        return;
    }

    const threadModel = sequelize.models.thread;
    const allThreads = await threadModel.findAll();
    if(allThreads.length == 0) {
        console.log("No threads found in database.");
        return;
    }

    dataLock = true;
    for(thread of allThreads) {
        const allPosts = await fetchAllPosts(thread.id);
        const latestPost = await thread.getPosts({
            order: [['post_number', 'DESC']],
            limit: 1
        });

        console.log(`Checking new posts for thread ${thread.id}`);

        // Prefer stored discord thread id (channel for posts), fallback to forum channel
        const threadChannelId = thread.discord_thread_id || thread.discord_channel;
        if(!threadChannelId) {
            console.log(`No discord mapping for topic ${thread.id}, skipping.`);
            continue;
        }

        try {
            const channel = await client.channels.fetch(`${threadChannelId}`);
            let forumThread = null;

            // If the stored id points to a Thread channel, use it directly
            if(channel.type === ChannelType.GuildPublicThread || channel.type === ChannelType.GuildPrivateThread) {
                forumThread = channel;
            }
            else if(channel.type === ChannelType.GuildForum) {
                // fallback: try to find thread by title in active threads
                const activeThreads = await channel.threads.fetchActive();
                const title = allPosts && allPosts[0] ? allPosts[0].title : null;
                if(title) {
                    forumThread = activeThreads.threads.find(t => t.name === title) || activeThreads.threads.first();
                } else {
                    forumThread = activeThreads.threads.first();
                }
            }

            if(!forumThread) {
                console.log(`No forum thread available for topic ${thread.id}`);
                continue;
            }

            const newPosts = allPosts.filter((post) => {
                if(!latestPost[0]) return true;
                return post.post_number > latestPost[0].post_number;
            });

            if (newPosts.length > 0) {
                for(post of newPosts) {
                    const msg = await sendDiscordMessage(forumThread, post, thread);
                    if(msg) {
                        try {
                            await thread.createPost({
                                id: post.id,
                                post_number: post.post_number,
                                reply_to: post.reply_to,
                                discord_id: `${msg.id}`,
                                createdAt: new Date(post.created_at),
                                editedAt: new Date(post.updated_at)
                            });
                        }
                        catch(e) {
                            console.log(e);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
            else {
                console.log(`No new posts on thread ${thread.id}`);
            }

            // Check for edited posts
            console.log(`Checking for edited messages on thread ${thread.id}`);
            for (post of allPosts) {
                const db_post = await thread.getPosts({ where: { post_number: post.post_number } });
                if(db_post[0]) {
                    let db_edited = new Date();
                    try { db_edited = new Date(db_post[0].editedAt); } catch { console.log("Error getting db editedAt"); }
                    const post_updated = new Date(post.updated_at);

                    if(post_updated > db_edited) {
                        console.log(`post number ${post.post_number} of thread ${thread.id} was edited.`);

                        let new_content = convertHtmlToMarkdown(post.content);
                        if (!new_content || new_content == '') new_content = "(empty message or error)";
                        const msg_id = `${db_post[0].discord_id}`;

                        try {
                            const header = `**${post.username}** • ${new Date(post.created_at).toLocaleString('en-US')} • [Original post](${ctfConfig.baseUrl}/t/${thread.id}/${post.post_number})`;
                            let fullContent = `${header}\n\n${new_content}`;
                            if(fullContent.length > 2000) {
                                fullContent = `${fullContent.substring(0, 1900)}\n\n[...read more](${ctfConfig.baseUrl}/t/${thread.id}/${post.post_number})`;
                            }

                            const msg_ref = await forumThread.messages.fetch(`${msg_id}`);
                            await msg_ref.edit(fullContent);
                            await db_post[0].update({ editedAt: post_updated });
                        }
                        catch(e) { console.log("Error editing message.", e); }
                    }
                }
            }
        }
        catch(err) {
            console.error(`Error processing thread ${thread.id}:`, err.message);
        }
    }
    dataLock = false;
    console.log(`Done, will listen again in ${INTERVAL_MINUTES} minutes`);
}

async function fetchThreadPage(topicId, page) {
    if(!ctfConfig) return null;
    
    try {
      const response = await axios.get(`${ctfConfig.baseUrl}/t/${topicId}.json?page=${page}`, {timeout: 10 * 1000});
      return response.data;
    } catch (error) {
      console.error(`Error fetching the thread page ${page}`);
      return null;
    }
}

async function fetchAllPosts(threadId) {
    let page = 1;
    let allPosts = [];
    let threadData;
    let retryCount = 0;
    do {
        threadData = await fetchThreadPage(threadId, page);
        if(threadData && !threadData.error) {            
            const posts = threadData.post_stream.posts.map((post) => ({
                id: post.id,
                topic_slug: post.topic_slug,
                post_number: post.post_number,
                reply_to: post.reply_to_post_number,
                title: threadData.title,
                content: he.decode(post.cooked),
                username: post.username,
                created_at: post.created_at,
                updated_at: post.updated_at,
                avatar_url: post.avatar_template.includes('v4') ? `${post.avatar_template.replace('{size}', '45')}`: `${ctfConfig.baseUrl}${post.avatar_template.replace('{size}', '45')}`
            }));
            allPosts = allPosts.concat(posts);
            page ++;
        }
        else {
            console.log("Error trying to fetch posts, breaking loop");
            break;
        }
    } while((threadData && threadData.post_stream.posts.length > 0) || retryCount > 30);
    return allPosts;
}

client.login(process.env.DISCORD_TOKEN);