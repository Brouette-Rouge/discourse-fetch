# Usage Guide - Discourse to Discord Forum Bridge

## Installation

```bash
npm install
```

## Configuration

1. Create a `.env` file:
```
DISCORD_TOKEN=your_discord_bot_token
```

2. Create a **Discord Forum** in your server (Discord → Create Channel → Forum)

3. Invite the bot to your server

## Usage

### Start Import

1. Open the Discord forum channel (e.g., #nsec-2026)
2. Type the command (run inside the Discord forum channel):
```
^ctf_start <base_url> <username> <password>
```

**Example with NSEC 2026:**
```
^ctf_start https://example.nsec admin password123
```

This will:
- Fetch recent topics from the Discourse site
- Create a Discord discussion thread for each Discourse topic
- Post each topic's messages into the created Discord thread
- Auto-sync every 2 minutes

### Stop Import

```
^ctf_stop
```

Stops the sync and gracefully shuts down the bot.

## Features

| Feature | Status |
|---|---|
| Initial post import | Supported |
| New post sync | Supported |
| Edit detection | Supported |
| Link preservation | Supported |
| Images as Markdown links | Supported |
| Message threading | Supported |
| Simple markdown format | Supported |

## Message Format

Each Discord message will have this format:

```
**Author** • 05/01/2026 14:30 • [Original post](https://example.nsec/t/42/5)

Message content with *italic*, **bold**, `code`, etc.
![Images as markdown](https://cdn.example.com/image.jpg)
[Preserved links](https://example.com)
```

## Notes

- Images from Discourse become Markdown links
- Timestamps are displayed in US English format
- Messages over 2000 characters are truncated with "read more" link
- Message replies preserve threading structure
