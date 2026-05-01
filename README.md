# Discourse to Discord Forum Bridge

A Discord bot that imports forum threads from Discourse directly into a Discord forum (with replies as discussion threads).

## Features

- Imports each Discourse thread as a Discord forum discussion thread
- Preserves replies and threading
- Handles post edits automatically
- Converts HTML to Markdown while preserving links and images
- Full CLI command support for start/stop

## Quick Start

```bash
npm install
node index.js
```

Discord commands:
- `^ctf_start <base_url> <username> <password>` (run inside a Discord forum channel) - Start importing
- `^ctf_stop` - Stop the bot

**See [USAGE.md](./USAGE.md) for full guide**

## Configuration

Create a `.env` file:
```
DISCORD_TOKEN=your_discord_bot_token
```

## Architecture

- **sequelize/** - Database models (threads, posts)
- **index.js** - Main Discord bot
- **package.json** - Dependencies

## Main Dependencies

- `discord.js` - Discord API
- `axios` - HTTP requests to Discourse
- `turndown` - HTML to Markdown conversion
- `sequelize` - ORM for SQLite
- `he` - HTML entity decoding

## Behavior

1. **Start**: Initiates sync and creates a thread in the forum
2. **Sync Loop**: Every 2 minutes, checks for new posts
3. **Edits**: Detects and updates modified messages
4. **Stop**: `^ctf_stop` gracefully shuts down the bot

## Notes

- Images are converted to Markdown links initially
- Markdown formatting (bold, italic, code, lists) is preserved
- Links are always preserved
- Each message includes author, timestamp, and link to original post