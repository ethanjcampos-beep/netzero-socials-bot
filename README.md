# Net Zero X Venuum Socials bot

A Telegram agent for the team group:
- **Logger agent** in the hub topics (Logins, Daily Rundown, Future Tasks, Saved Info). It saves what people post and flags anything missing or wrong.
- **Content topic**: uploads up to 2GB are saved to Google Drive, sorted into Brand / Car / Type folders.
- **Assistant agent** in General. Tag it or reply to it.

## Setup

### 1. Get the keys
| What | Where |
|---|---|
| `BOT_TOKEN` | from BotFather (@Netzeroautobot) |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | my.telegram.org → log in with your phone → API development tools → create an app (any name) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | step 3 |
| `SETUP_KEY` | make up any long random password |

### 2. Deploy on Railway
1. railway.com → New Project → Deploy from GitHub repo → pick this repo.
2. In the service, open **Variables** and add all the keys above.
3. Open **Settings → Volumes**, add a volume, and set the mount path to `/data`.
4. Open **Settings → Networking → Generate Domain**. Note the URL.

### 3. Connect Google Drive (sign in with ethanjcampos@gmail.com)
1. console.cloud.google.com → create a project called "Net Zero Bot".
2. APIs & Services → Library → enable **Google Drive API**.
3. OAuth consent screen → External. Add yourself as a user. When it's done, click **Publish app**. If you skip this, Google disconnects the bot every 7 days.
4. Credentials → Create OAuth client ID → **Web application**.
   Authorized redirect URI: `https://YOUR-RAILWAY-DOMAIN/oauth/callback`
5. Copy the client ID and secret into the Railway variables.
6. Open `https://YOUR-RAILWAY-DOMAIN/auth?key=YOUR_SETUP_KEY`, then sign in and allow access.
   This creates the **Net Zero X Venuum Content** folder in your Drive.

### 4. Telegram
1. Create the group and turn on Topics.
2. Add @Netzeroautobot as an admin with **Manage topics** and **Pin messages**.
3. Send `/setup` in General.
4. Share the Drive folder: tag the bot and say "share the content folder with name@gmail.com".

Note: the bot moves itself onto its own Telegram server (needed for 2GB files). After the first start, it can't go back to Telegram's standard server for about 10 minutes.
