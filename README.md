# WhatsApp Automation Bot — Setup & Usage Guide

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- A WhatsApp account on a phone (for QR scan)

---

## Quick Start

```bash
# 1. Install dependencies (already done if npm install was run)
npm install

# 2. (Optional) Copy and edit environment config
copy .env.example .env

# 3. Start the server
npm start

# 4. Open the HUD dashboard
# → http://localhost:5151
```

The server runs two decoupled endpoints on dedicated non-default ports:
- **Web HUD Control Panel**: `http://localhost:5151`
- **Backend API & WebSockets**: `http://localhost:5150`

The server will:
1. Print the WhatsApp QR code in the terminal
2. Display it live in the browser HUD
3. After scanning, persist the session in `.wwebjs_auth/` — no rescan on restart

---

## Environment Variables (`.env`)

| Variable              | Default  | Description                                        |
|-----------------------|----------|----------------------------------------------------|
| `FRONTEND_PORT`       | `5151`   | HTTP port for the Web HUD dashboard                |
| `API_PORT`            | `5150`   | HTTP & Socket.IO port for backend API & automation |
| `PUBLIC_API_URL`      | *(auto)* | Public URL of the API server (if behind proxy)     |
| `WORKER_INTERVAL_MS`  | `5000`   | Background task poll interval (milliseconds)       |

---

## Project Structure

```
WhatsappCountdownBot/
├── server.js              ← Entry point: Express + Socket.IO + WA client
├── package.json
├── .env.example
│
├── core/
│   ├── logger.js          ← Structured timestamped logger
│   ├── db.js              ← lowdb JSON persistence (data/config.json)
│   ├── whatsappClient.js  ← WA client singleton, QR, auth events
│   ├── taskWorker.js      ← Background interval worker loop
│   ├── countdown.js       ← Countdown broadcast module
│   ├── scheduledPosts.js  ← One-time scheduled posts engine
│   └── dailyAlarms.js     ← Daily repeating alarm engine
│
├── routes/
│   └── api.js             ← REST API consumed by the HUD
│
├── plugins/
│   ├── index.js           ← Plugin loader & registry
│   ├── autoReply.js       ← Auto-reply keyword plugin
│   └── welcomeMessage.js  ← New-member welcome message plugin
│
├── public/                ← HUD frontend (static files)
│   ├── index.html
│   ├── style.css
│   └── app.js
│
└── data/
    └── config.json        ← Auto-created on first boot (all settings)
```

---

## HUD Features

The Relay dashboard includes an overview with a live event countdown, WhatsApp
connection status, and totals for target groups, pending posts, and enabled alarms.
Use the sidebar to jump into an automation, or open a group's workspace. Countdown
settings include a live poster and caption preview alongside the form on desktop.
On mobile, navigation scrolls horizontally and the editor stacks vertically.
Automation settings are shared across target groups; direct messages use the
recipient selected in the message form.

### 1. WhatsApp Connection
- QR code appears in both terminal and browser HUD on first boot
- Session persists in `.wwebjs_auth/` — no rescan needed on restart
- **Log Out** button revokes the session and triggers a fresh QR scan

### 2. Target Group Selector
- Enter the exact WhatsApp group name (case-insensitive match)
- All modules (countdown, posts, alarms) send to this group

### 3. Countdown Bot
- Set a target date/time
- Set the event title; previews and messages show the title and time remaining
- Attach a poster to include it in the preview and the same message as the countdown caption
- **Broadcast Countdown Now** uses the current form, including a newly selected poster
- Customize the message template with tokens:
  - `{days}` `{hours}` `{minutes}` `{seconds}`
- Choose a daily publish time in Sri Lanka time. Saving or enabling after today's time schedules the first broadcast for the next eligible day.
- After saving the start and target dates, optionally save a different title, message, or poster for any date in the range. Blank fields use the main countdown content.
- Existing countdowns must be saved with a daily publish time before automatic broadcasting resumes.
- Preview the resolved message before saving
- Auto-disables when the target date is reached

### Optional approval for changes

Run `node scripts/setup-approval.cjs` in a local interactive terminal to set an approval password and pair a free authenticator app. Once configured, changes and immediate sends through the API require the password and a fresh six-digit code; scheduled deliveries proceed automatically. A code can be used once per server run. Keep `data/approval-auth.json` private and back it up securely. If it is lost, local administrator access is needed to set up approval again. Use the dashboard locally or over HTTPS: passwords and codes must not be sent over an untrusted plain HTTP connection. Approval does not secure read-only dashboard data or WhatsApp bot commands.

### 4. Scheduled Posts
- Create one-time posts with a specific date/time
- Posts are marked `sent: true` after delivery — **never duplicated**
- Failed groups are retried automatically, while successful group deliveries are remembered
- Scheduled post times use Sri Lanka time (Asia/Colombo); attachment-only posts are supported
- Manage (view / delete) all posts from the HUD

### 5. Daily Alarms
- Configure recurring messages at a fixed `HH:MM` time
- Each alarm fires once per calendar day (tracked by `lastFiredDate`)
- Enable/disable individual alarms from the HUD

### 6. Interactive In-Group Bot Commands & Strict Moderation
- Responds automatically to commands posted directly inside group chats
- Default commands:
  - `!countdown`: Shows real-time remaining days, hours, minutes, and seconds until the target date
  - `!time`: Displays the current server date and time
  - `!help`: Dynamically lists all enabled bot commands and descriptions
- Add custom commands via HUD (e.g., `!rules`, `!links`) with token support (`{name}`, `{group}`, `{date}`, `{time}`)
- Customizable command prefix (e.g. `!`, `/`, `#`) and anti-spam cooldown protection
- Option to restrict command execution strictly to configured Target Groups
- **Strict Command Mode (Auto-Delete Non-Commands)**:
  - Enforces a command-only group environment where regular chatter is wiped
  - Non-command messages sent by members are revoked for everyone; deletion failures appear in the logs
  - Optional exemption for Group Admins so official announcements are preserved
  - Configurable transient warning notices with auto-deletion to keep the chat clean
  - Requires promoting the bot's account to **Group Admin**

---

## Plugin System

Add new features by creating a file in `/plugins/`:

```js
// plugins/myPlugin.js
'use strict';

module.exports = {
  name: 'myPlugin',

  // 'worker'  — called on every background task tick
  // 'message' — called for every incoming WhatsApp message
  type: 'worker',

  async run(context) {
    // context is undefined for 'worker' plugins
    // context = { message, client } for 'message' plugins
  },
};
```

Then register it in `plugins/index.js`:

```js
const PLUGIN_FILES = [
  'autoReply.js',
  'welcomeMessage.js',
  'myPlugin.js',   // ← add here
];
```

### Bundled Plugins

| Plugin            | Type      | Description                                      |
|-------------------|-----------|--------------------------------------------------|
| `autoReply.js`    | `message` | Reply to messages containing configured keywords |
| `welcomeMessage.js` | `message` | Welcome new group members with a custom message |
| `botCommands.js`  | `message` | Interactive group commands (`!countdown`, `!time`, `!help`, custom commands) |

Configure them via `data/config.json` under the `plugins` key:

```json
{
  "plugins": {
    "autoReply": {
      "enabled": true,
      "rules": [
        { "keyword": "hello", "reply": "Hello. How can we assist you?", "caseSensitive": false }
      ]
    },
    "welcomeMessage": {
      "enabled": true,
      "template": "Welcome to the group, {name}."
    }
  }
}
```

---

## REST API Reference

| Method   | Endpoint                     | Description                                         |
|----------|------------------------------|-----------------------------------------------------|
| `GET`    | `/api/state`                 | Full current configuration                          |
| `GET`    | `/api/status`                | WhatsApp connection status                          |
| `GET`    | `/api/groups`                | Detected active WhatsApp groups                     |
| `GET`    | `/api/groups/target`         | Configured target groups array                      |
| `POST`   | `/api/groups/target`         | Add a target group `{ name }`                       |
| `DELETE` | `/api/groups/target`         | Remove a target group `{ name }`                    |
| `POST`   | `/api/send-test`             | Instant test message dispatch to group(s)           |
| `POST`   | `/api/countdown`             | Update countdown config                             |
| `POST`   | `/api/countdown/broadcast`   | Force immediate countdown broadcast to all targets  |
| `POST`   | `/api/posts`                 | Add scheduled post                                  |
| `DELETE` | `/api/posts/:id`             | Delete a scheduled post                             |
| `POST`   | `/api/alarms`                | Add daily alarm                                     |
| `PATCH`  | `/api/alarms/:id`            | Toggle/update an alarm                              |
| `DELETE` | `/api/alarms/:id`            | Delete a daily alarm                                |
| `POST`   | `/api/logout`                | Revoke WhatsApp session and purge cache             |
| `POST`   | `/api/worker/tick`           | Manually trigger one worker tick                    |

---

## Development

```bash
# Hot-reload during development
npm run dev
```

Requires `nodemon` (installed as a dev dependency).

---

## Notes

- All configuration is stored in `data/config.json` — edit it directly if needed
- The task worker reads config dynamically — **no restart required** after HUD changes
- Session files are in `.wwebjs_auth/` — delete this folder to force a new QR scan
