// Net Zero X Venuum Socials — Telegram agent bot (Railway)
// Env: BOT_TOKEN, ANTHROPIC_API_KEY, SETUP_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH,
//      GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (Railway sets RAILWAY_PUBLIC_DOMAIN + PORT)
// Volume mounted at /data

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

const MODEL = 'claude-sonnet-5-5';
const TZ = 'America/Toronto';
const REMINDER_HOUR = 21, WEEKLY_DAY = 'Mon', WEEKLY_HOUR = 9, HISTORY = 30;
const LOCAL_API = 'http://127.0.0.1:8081';
const DATA = '/data/bot';
const PUBLIC_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`;
const ROOT_FOLDER = 'Net Zero X Venuum Content';
const env = process.env;

const TOPICS = {
  logins:  { name: '🔐 Logins',        color: 16478047, pin: '🔐 Post account logins here, any format. One account per message works best. The logger saves each one, flags anything missing, and updates it if you post a new password.' },
  rundown: { name: '📊 Daily Rundown', color: 7322096,  pin: '📊 Post what you did today: what you posted, where, and any numbers. Any format works, and screenshots are fine. Anyone who hasn\'t posted gets a reminder at 9 PM.' },
  tasks:   { name: '📋 Future Tasks',  color: 16766590, pin: '📋 Post upcoming tasks in plain words, like "need the GLC reel edited by Friday – Mike". Say "done with the GLC reel" when it\'s finished. The full list is under /tasks.' },
  content: { name: '🎬 Content',       color: 13338331, pin: '🎬 Upload content here: videos, photos, edits, raw footage. Add a caption if you can (car, brand, raw or edited). Every file is saved to the shared Google Drive and sorted into folders automatically, and you get a link back.' },
  info:    { name: '🗂 Saved Info',    color: 9367192,  pin: '🗂 Drop anything worth keeping here: links, brand guidelines, hashtags, contacts. It all gets saved and the assistant in General can find it later.' },
};

// =================== tiny file-backed store ===================
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
let saveTimer;
const store = {
  get: (k, fb) => (k in db ? structuredClone(db[k]) : fb),
  put: (k, v) => { db[k] = v; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 200); },
};
function flush() { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
process.on('SIGTERM', () => { flush(); process.exit(0); });

// =================== Telegram ===================
async function tg(method, body, base = LOCAL_API) {
  try {
    const r = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) console.log(method, 'failed:', j.description);
    return j;
  } catch (e) { console.log(method, 'error', e.message); return { ok: false, description: e.message }; }
}
function send(chat_id, text, message_thread_id, html = false, reply_to) {
  return tg('sendMessage', {
    chat_id, text, message_thread_id, link_preview_options: { is_disabled: true },
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(reply_to ? { reply_parameters: { message_id: reply_to, allow_sending_without_reply: true } } : {}),
  });
}
const react = (m, emoji) => tg('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji }] });

async function poll() {
  // One-time move from Telegram's cloud API to our local server (needed for 2GB files)
  if (!store.get('loggedOut')) {
    await tg('deleteWebhook', {}, 'https://api.telegram.org');
    const r = await tg('logOut', {}, 'https://api.telegram.org');
    if (r.ok) { store.put('loggedOut', true); flush(); console.log('Logged out of cloud API; waiting for local server'); }
  }
  const me = await tg('getMe', {});
  if (!me.ok) { console.log('local API not ready, retrying'); return setTimeout(poll, 5000); }
  store.put('botinfo', me.result);
  console.log('Running as @' + me.result.username);
  let offset = store.get('offset', 0);
  for (;;) {
    const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message'] });
    if (!r.ok) { await sleep(3000); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1; store.put('offset', offset);
      const m = u.message || u.edited_message;
      if (m) onMessage(m, !!u.edited_message).catch((e) => console.log('handler error', e.stack || e));
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =================== routing ===================
async function onMessage(m, edited) {
  if (!m.from || m.from.is_bot) return;
  const cfg = store.get('config', { chatId: null, topics: {} });
  const text = (m.text || m.caption || '').trim();
  const thread = m.is_topic_message ? m.message_thread_id : undefined;
  const reply = (t, html) => send(m.chat.id, t, thread, html, m.message_id);

  if (m.chat.type === 'private') {
    if (!cfg.chatId || !(await isMember(cfg.chatId, m.from.id))) return send(m.chat.id, 'I only work for members of the Net Zero X Venuum Socials group.');
    if (text.startsWith('/start')) return send(m.chat.id, 'Hey. Ask me anything: logins, tasks, rundowns, content, captions, ideas.');
    return runAssistant(m, `dm:${m.from.id}`, (t) => send(m.chat.id, t));
  }

  rememberMember(m.from);
  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase() : null;
  const args = cmd ? text.split(/\s+/).slice(1).join(' ') : '';

  if (cmd === 'setup' || cmd === 'link') {
    if (!(await isAdmin(m.chat.id, m.from.id))) return reply('Only group admins can do that.');
    cfg.chatId = m.chat.id;
    if (cmd === 'link') {
      const key = args.toLowerCase();
      if (!TOPICS[key] || !thread) return reply(`Use this inside a topic: /link ${Object.keys(TOPICS).join(' | ')}`);
      cfg.topics[key] = thread; store.put('config', cfg);
      await postPinned(m.chat.id, thread, TOPICS[key].pin);
      return reply(`✅ This topic is now ${TOPICS[key].name}`);
    }
    const made = [];
    for (const [key, t] of Object.entries(TOPICS)) {
      if (cfg.topics[key]) continue;
      const r = await tg('createForumTopic', { chat_id: m.chat.id, name: t.name, icon_color: t.color });
      if (!r.ok) return reply(`Couldn't create topics: ${r.description}\nTurn on Topics and make me an admin with "Manage topics" + "Pin messages".`);
      cfg.topics[key] = r.result.message_thread_id;
      await postPinned(m.chat.id, cfg.topics[key], t.pin);
      made.push(t.name);
    }
    store.put('config', cfg);
    return reply(made.length ? `✅ Set up: ${made.join(', ')}\nTag me in General anytime for help.` : '✅ Already set up.');
  }
  if (cmd === 'tasks') return reply(taskList());
  if (cmd === 'rundown') return reply(rundownStatus());
  if (cmd === 'drive') return reply(store.get('google')?.rootLink ? `🎬 Content folder: ${store.get('google').rootLink}` : 'Google Drive isn\'t connected yet.');
  if (cmd === 'help' || cmd === 'start') return reply(
`Hub topics: just post. I log everything and flag anything that's missing or looks wrong.
🎬 Content: upload files and they're saved and sorted in Google Drive.
General: tag me (@${store.get('botinfo')?.username}) or reply to me for anything.
/tasks · /rundown · /drive`);

  const hubKey = Object.keys(cfg.topics).find((k) => cfg.topics[k] === thread);
  if (cfg.chatId === m.chat.id && hubKey === 'content') {
    if (!edited && mediaOf(m)) return saveContent(m, reply);
    if (!edited && text) return runLogger(m, 'info', reply);
    return;
  }
  if (cfg.chatId === m.chat.id && hubKey) {
    if (edited && hubKey !== 'logins') return;
    return runLogger(m, hubKey, reply);
  }

  if (!edited) pushHistory('general', `${name(m.from)}: ${text || '[media]'}`);
  if (!edited && addressedToBot(m)) return runAssistant(m, 'general', (t) => send(m.chat.id, t, thread, false, m.message_id));
}

// =================== logger agent ===================
const LOGGER_TOOL = {
  name: 'record',
  description: 'Record what this hub message contains. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      logins: { type: 'array', description: 'Account credentials in the message', items: { type: 'object', properties: {
        platform: { type: 'string', description: 'Instagram, TikTok, YouTube, Facebook, X, Snapchat, Gmail, Meta Business, etc.' },
        handle: { type: 'string', description: 'username/handle without @' },
        email: { type: 'string' }, phone: { type: 'string' }, password: { type: 'string' },
        twofa: { type: 'string', description: 'where 2FA codes go / backup codes' },
        brand: { type: 'string', description: 'Net Zero, Venuum, or other' },
        manager: { type: 'string', description: 'who runs the account' }, notes: { type: 'string' },
      }, required: ['platform'] } },
      rundown: { type: 'object', description: 'Daily rundown of work done', properties: {
        posts: { type: 'array', items: { type: 'object', properties: { platform: { type: 'string' }, account: { type: 'string' }, content: { type: 'string' } } } },
        other_work: { type: 'string' }, numbers: { type: 'string' }, issues: { type: 'string' },
      } },
      new_tasks: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, assignee: { type: 'string' }, due: { type: 'string' } }, required: ['text'] } },
      task_updates: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] } }, required: ['id', 'status'] } },
      info: { type: 'object', description: 'General info worth saving (links, guidelines, contacts, hashtags…)', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' } } },
      problems: { type: 'array', items: { type: 'string' }, description: 'Anything missing, inconsistent or likely wrong: missing password/handle, malformed email, handle with spaces, rundown with no posts listed, task with no owner or due date, conflicts with existing records, handle typos vs existing records. Empty if all good.' },
      nothing_to_log: { type: 'boolean', description: 'true if the message is just chat/acknowledgement' },
    },
    required: ['problems'],
  },
};

async function runLogger(m, hubKey, reply) {
  const today = torontoNow().date;
  const logins = store.get('logins', {});
  const tasks = store.get('tasks', { nextId: 1, items: [] });
  const context = [
    `Topic: ${TOPICS[hubKey].name}. Sender: ${name(m.from)}. Today (Toronto): ${today}.`,
    `Known accounts: ${Object.values(logins).map((l) => `${l.platform} @${l.handle}${l.email ? ` (${l.email})` : ''}`).join('; ') || 'none yet'}`,
    `Open tasks: ${tasks.items.filter((t) => t.status === 'todo' || t.status === 'doing').map((t) => `#${t.id} ${t.text}${t.assignee ? ` [${t.assignee}]` : ''}`).join('; ') || 'none'}`,
  ].join('\n');
  const res = await claude({
    system: `You are the logging agent for "Net Zero X Venuum Socials", the social media team for Net Zero Auto and Venuum USA (luxury car body kits). You read messages posted in the team's hub topics and extract structured records exactly as written. Never invent or "fix" values such as passwords or handles; copy them character for character. Put anything doubtful in problems. The topic hints at what to expect, but log whatever the message actually contains.\n\n${context}`,
    messages: [{ role: 'user', content: await messageContent(m) }],
    tools: [LOGGER_TOOL], tool_choice: { type: 'tool', name: 'record' }, max_tokens: 2000,
  });
  const rec = res.content?.find((b) => b.type === 'tool_use')?.input;
  if (!rec) return reply(`⚠️ I couldn't read that one${res.error ? ` (${res.error.message})` : ''}. Try again?`);
  if (rec.nothing_to_log && !rec.problems?.length) return;

  const done = [], problems = [...(rec.problems || [])];
  for (const l of rec.logins || []) {
    l.handle = (l.handle || '').replace(/^@/, '').trim();
    if (!l.handle && !l.email) { problems.push(`${l.platform} login has no username or email`); continue; }
    if (!l.password) problems.push(`${l.platform} ${l.handle ? '@' + l.handle : l.email}: no password`);
    if (l.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email)) problems.push(`email "${l.email}" looks wrong`);
    const key = `${l.platform}:${l.handle || l.email}`.toLowerCase();
    const prev = logins[key];
    const changed = prev ? Object.keys(l).filter((k) => l[k] && l[k] !== prev[k]) : [];
    logins[key] = { ...(prev || {}), ...Object.fromEntries(Object.entries(l).filter(([, v]) => v)), by: name(m.from), updated: today };
    done.push(prev ? (changed.length ? `updated ${l.platform} @${l.handle} (${changed.join(', ')} changed)` : `${l.platform} @${l.handle} already saved`) : `saved ${l.platform} ${l.handle ? '@' + l.handle : l.email}`);
  }
  if (rec.logins?.length) store.put('logins', logins);

  if (rec.rundown && (rec.rundown.posts?.length || rec.rundown.other_work)) {
    const day = store.get(`rundown:${today}`, {});
    day[m.from.id] = { name: name(m.from), ...rec.rundown, at: Date.now() };
    store.put(`rundown:${today}`, day);
    done.push(`rundown for ${today}`);
  }
  for (const t of rec.new_tasks || []) {
    const task = { id: tasks.nextId++, text: t.text, assignee: t.assignee || '', due: t.due || '', status: 'todo', by: name(m.from), created: Date.now() };
    tasks.items.push(task);
    done.push(`task #${task.id}: ${task.text}${task.assignee ? ` → ${task.assignee}` : ''}${task.due ? `, due ${task.due}` : ''}`);
  }
  for (const u of rec.task_updates || []) {
    const t = tasks.items.find((x) => x.id === u.id);
    if (!t) continue;
    t.status = u.status; if (u.status === 'done') t.doneAt = Date.now();
    done.push(`task #${t.id} → ${u.status}`);
  }
  if (rec.new_tasks?.length || rec.task_updates?.length) store.put('tasks', tasks);
  if (rec.info?.content) {
    const info = store.get('info', []);
    info.push({ ...rec.info, by: name(m.from), date: today });
    store.put('info', info);
    done.push(`saved info: ${rec.info.title || rec.info.content.slice(0, 40)}`);
  }

  await react(m, problems.length ? '🤔' : '👍');
  if (problems.length) await reply(`${done.length ? '✅ Logged: ' + done.join(' · ') + '\n' : ''}⚠️ Check: ${problems.join(' · ')}`);
  else if (done.some((d) => d.startsWith('task') || d.startsWith('updated'))) await reply('✅ ' + done.join(' · '));
}

// =================== content → Google Drive ===================
function mediaOf(m) {
  if (m.video) return { file: m.video, kind: 'video', ext: (m.video.mime_type || 'video/mp4').split('/')[1], mime: m.video.mime_type || 'video/mp4', thumb: m.video.thumbnail };
  if (m.photo) { const p = m.photo[m.photo.length - 1]; return { file: p, kind: 'photo', ext: 'jpg', mime: 'image/jpeg', thumb: m.photo.find((x) => x.width >= 320) || p }; }
  if (m.document) return { file: m.document, kind: 'file', name: m.document.file_name, mime: m.document.mime_type || 'application/octet-stream', ext: (m.document.file_name || '').split('.').pop(), thumb: m.document.thumbnail };
  if (m.animation) return { file: m.animation, kind: 'video', ext: 'mp4', mime: 'video/mp4', thumb: m.animation.thumbnail };
  return null;
}

const CONTENT_TOOL = {
  name: 'categorize', description: 'Categorize this content file for the shared Drive. Call once.',
  input_schema: { type: 'object', properties: {
    brand: { type: 'string', description: 'Venuum, Net Zero, or Other' },
    category: { type: 'string', description: 'Main subject folder, usually the car (e.g. "Mercedes GLC", "Audi RS6", "Lamborghini Urus") or an event/shoot. Reuse an existing category name exactly if it fits.' },
    content_type: { type: 'string', enum: ['Raw Footage', 'Edited Reels', 'Photos', 'Graphics', 'Other'] },
    title: { type: 'string', description: 'Short descriptive file title, 3-8 words, no date' },
    description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
  }, required: ['brand', 'category', 'content_type', 'title'] },
};

async function saveContent(m, reply) {
  const g = store.get('google');
  if (!g?.refresh) return reply(`⚠️ Google Drive isn't connected yet. An admin needs to open:\n${PUBLIC_URL}/auth?key=YOUR_SETUP_KEY`);
  const media = mediaOf(m);
  await react(m, '👀');

  // Albums: only the first item has the caption, so share it across the group
  let caption = m.caption || '';
  if (m.media_group_id) {
    const groups = store.get('albums', {});
    if (caption) groups[m.media_group_id] = caption; else caption = groups[m.media_group_id] || '';
    store.put('albums', groups);
  }

  try {
    const f = await tg('getFile', { file_id: media.file.file_id });
    if (!f.ok) throw new Error(f.description);
    const localPath = f.result.file_path;

    const content = [];
    if (media.thumb) {
      const t = await tg('getFile', { file_id: media.thumb.file_id });
      if (t.ok && fs.statSync(t.result.file_path).size < 4.5e6) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(t.result.file_path).toString('base64') } });
    }
    const existing = [...new Set(store.get('content', []).map((c) => `${c.brand} / ${c.category}`))];
    content.push({ type: 'text', text: `Uploaded by ${name(m.from)}. Kind: ${media.kind}${media.name ? `, filename "${media.name}"` : ''}${media.file.duration ? `, ${media.file.duration}s` : ''}.\nCaption: ${caption || '(none)'}\nExisting folders: ${existing.join('; ') || 'none yet'}` });
    const res = await claude({
      system: 'You sort content for the Net Zero Auto / Venuum USA social media team (luxury cars, body kits, wraps). Look at the thumbnail and caption, identify the car and type of content, and categorize it. Prefer existing folder names.',
      messages: [{ role: 'user', content }], tools: [CONTENT_TOOL], tool_choice: { type: 'tool', name: 'categorize' }, max_tokens: 800,
    });
    const c = res.content?.find((b) => b.type === 'tool_use')?.input || { brand: 'Other', category: 'Unsorted', content_type: 'Other', title: media.name || 'Upload' };

    const date = torontoNow().date;
    const fileName = `${date} ${clean(c.title)}.${media.ext || 'bin'}`;
    const folderId = await ensureFolders([clean(c.brand), clean(c.category), c.content_type]);
    const up = await driveUpload(localPath, fileName, media.mime, folderId, `${c.description || ''}\nUploaded by ${name(m.from)}. ${caption}`.trim());
    fs.rmSync(localPath, { force: true });

    const list = store.get('content', []);
    list.push({ ...c, file: fileName, link: up.webViewLink, id: up.id, by: name(m.from), date, caption, kind: media.kind });
    store.put('content', list);
    await react(m, '👍');
    await reply(`✅ Saved → ${c.brand} / ${c.category} / ${c.content_type}\n${fileName}\n${up.webViewLink}`);
  } catch (e) {
    console.log('content error', e.stack || e);
    await react(m, '😢');
    await reply(`⚠️ Couldn't save this one: ${e.message}`);
  }
}
const clean = (s) => String(s || 'Unsorted').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);

// --- Google Drive (OAuth, drive.file scope: the bot only sees files it created) ---
async function googleToken() {
  const g = store.get('google');
  if (g.access && g.exp > Date.now() + 60e3) return g.access;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: g.refresh, grant_type: 'refresh_token' }) }).then((x) => x.json());
  if (!r.access_token) throw new Error('Google sign-in expired. Reconnect at /auth');
  store.put('google', { ...g, access: r.access_token, exp: Date.now() + r.expires_in * 1000 });
  return r.access_token;
}
async function gapi(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { authorization: `Bearer ${await googleToken()}`, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Drive: ${j.error?.message || r.status}`);
  return j;
}
async function createFolder(nameF, parent) {
  return gapi('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: nameF, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) });
}
async function ensureFolders(parts) {
  const g = store.get('google');
  const folders = store.get('folders', {});
  let parent = g.rootId, key = '';
  for (const p of parts) {
    key += '/' + p.toLowerCase();
    if (!folders[key]) { folders[key] = (await createFolder(p, parent)).id; store.put('folders', folders); }
    parent = folders[key];
  }
  return parent;
}
async function driveUpload(localPath, fileName, mime, parent, description) {
  const size = fs.statSync(localPath).size;
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
    method: 'POST',
    headers: { authorization: `Bearer ${await googleToken()}`, 'content-type': 'application/json', 'x-upload-content-type': mime, 'x-upload-content-length': String(size) },
    body: JSON.stringify({ name: fileName, parents: [parent], description }),
  });
  if (!init.ok) throw new Error(`Drive upload start failed (${init.status})`);
  const r = await fetch(init.headers.get('location'), {
    method: 'PUT', headers: { 'content-type': mime, 'content-length': String(size) },
    body: Readable.toWeb(fs.createReadStream(localPath)), duplex: 'half',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Drive upload failed: ${j.error?.message || r.status}`);
  return j;
}

// =================== assistant agent ===================
const ASSISTANT_TOOLS = [
  { name: 'search_logins', description: 'Find saved account logins (full details incl. password). Query by platform, handle, brand or email; empty query lists all.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'save_login', description: 'Save or update an account login.', input_schema: LOGGER_TOOL.input_schema.properties.logins.items },
  { name: 'list_tasks', description: 'List tasks.', input_schema: { type: 'object', properties: { include_done: { type: 'boolean' } } } },
  { name: 'add_task', description: 'Add a task.', input_schema: LOGGER_TOOL.input_schema.properties.new_tasks.items },
  { name: 'update_task', description: 'Change a task status.', input_schema: LOGGER_TOOL.input_schema.properties.task_updates.items },
  { name: 'get_rundowns', description: 'Daily rundowns for the last N days (default 7), optionally for one person.', input_schema: { type: 'object', properties: { days: { type: 'integer' }, person: { type: 'string' } } } },
  { name: 'search_content', description: 'Search uploaded content in the shared Drive (by car, brand, type, uploader, words). Returns Drive links. Empty query = latest 20.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'content_folder', description: 'Get the shared Google Drive content folder link.', input_schema: { type: 'object', properties: {} } },
  { name: 'share_content_folder', description: 'Give someone access to the shared content folder by Google email.', input_schema: { type: 'object', properties: { email: { type: 'string' }, role: { type: 'string', enum: ['reader', 'writer'] } }, required: ['email'] } },
  { name: 'search_info', description: 'Search saved info (links, guidelines, contacts, hashtags). Empty query = latest.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'save_info', description: 'Save a piece of info for the team.', input_schema: LOGGER_TOOL.input_schema.properties.info },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
];
const match = (items, q, n = 50) => {
  const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace('@', ''));
  const scored = items.map((i) => [i, words.filter((w) => JSON.stringify(i).toLowerCase().includes(w)).length]);
  return words.length ? scored.filter(([, s]) => s).sort((a, b) => b[1] - a[1]).map(([i]) => i).slice(0, n) : items.slice(-n);
};

async function runTool(nameT, input, who) {
  const today = torontoNow().date;
  switch (nameT) {
    case 'search_logins': { const r = match(Object.values(store.get('logins', {})), input.query); return r.length ? r : 'No matching logins saved.'; }
    case 'save_login': {
      const logins = store.get('logins', {}); input.handle = (input.handle || '').replace(/^@/, '');
      const key = `${input.platform}:${input.handle || input.email}`.toLowerCase();
      logins[key] = { ...(logins[key] || {}), ...input, by: who, updated: today }; store.put('logins', logins); return 'saved';
    }
    case 'list_tasks': return store.get('tasks', { items: [] }).items.filter((x) => input.include_done || x.status === 'todo' || x.status === 'doing');
    case 'add_task': {
      const t = store.get('tasks', { nextId: 1, items: [] });
      const task = { id: t.nextId++, text: input.text, assignee: input.assignee || '', due: input.due || '', status: 'todo', by: who, created: Date.now() };
      t.items.push(task); store.put('tasks', t); return task;
    }
    case 'update_task': {
      const t = store.get('tasks', { nextId: 1, items: [] }); const x = t.items.find((i) => i.id === input.id);
      if (!x) return 'No such task';
      x.status = input.status; if (input.status === 'done') x.doneAt = Date.now(); store.put('tasks', t); return x;
    }
    case 'get_rundowns': {
      const out = {};
      for (let i = 0; i < Math.min(input.days || 7, 60); i++) {
        const d = torontoNow(Date.now() - i * 864e5).date;
        const entries = Object.values(store.get(`rundown:${d}`, {})).filter((r) => !input.person || r.name.toLowerCase().includes(input.person.toLowerCase()));
        if (entries.length) out[d] = entries;
      }
      return Object.keys(out).length ? out : 'No rundowns in that range.';
    }
    case 'search_content': { const r = match(store.get('content', []), input.query, 20); return r.length ? r : 'No matching content.'; }
    case 'content_folder': return store.get('google')?.rootLink || 'Google Drive not connected yet.';
    case 'share_content_folder': {
      const g = store.get('google'); if (!g?.rootId) return 'Google Drive not connected yet.';
      await gapi(`https://www.googleapis.com/drive/v3/files/${g.rootId}/permissions?sendNotificationEmail=true`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: input.role || 'writer', emailAddress: input.email }) });
      return `Shared with ${input.email}`;
    }
    case 'search_info': { const r = match(store.get('info', []), input.query, 15); return r.length ? r : 'Nothing saved matches.'; }
    case 'save_info': { const info = store.get('info', []); info.push({ ...input, by: who, date: today }); store.put('info', info); return 'saved'; }
  }
  return 'unknown tool';
}

async function runAssistant(m, historyKey, say) {
  tg('sendChatAction', { chat_id: m.chat.id, action: 'typing', message_thread_id: m.is_topic_message ? m.message_thread_id : undefined });
  const now = torontoNow();
  const system = `You are the team assistant in "Net Zero X Venuum Socials", the Telegram group for the social media team of Net Zero Auto and Venuum USA (@venuumusa, luxury car body kits). You help with anything the team needs: finding account logins, managing tasks, summarizing daily rundowns, finding uploaded content in the shared Google Drive, writing captions, hooks, hashtags and scripts, planning content, and answering questions. Use your tools for team data and never guess logins or links. Reply in plain text (no markdown symbols) and keep it short and direct, like a sharp teammate in a group chat. When you change something, say what you changed.
Now: ${now.weekday} ${now.date}, ${now.hour}:00 Toronto time. You're talking to ${name(m.from)}.
Recent chat:\n${store.get(`hist:${historyKey}`, []).join('\n') || '(none)'}`;
  const messages = [{ role: 'user', content: await messageContent(m) }];
  let answer = '';
  for (let i = 0; i < 8; i++) {
    const res = await claude({ system, messages, tools: ASSISTANT_TOOLS, max_tokens: 2000 });
    if (res.error) { answer = `⚠️ AI error: ${res.error.message}`; break; }
    messages.push({ role: 'assistant', content: res.content });
    answer = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || answer;
    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason !== 'tool_use') break;
    const results = [];
    for (const b of res.content.filter((c) => c.type === 'tool_use')) {
      const out = await runTool(b.name, b.input, name(m.from)).catch((e) => `error: ${e.message}`);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  answer = answer || 'Done.';
  pushHistory(historyKey, `Assistant: ${answer.slice(0, 500)}`);
  for (let i = 0; i < answer.length; i += 4000) await say(answer.slice(i, i + 4000));
}

function addressedToBot(m) {
  const me = store.get('botinfo', {});
  if (m.reply_to_message?.from?.id === me.id) return true;
  return (m.text || m.caption || '').toLowerCase().includes('@' + (me.username || '_').toLowerCase());
}

async function messageContent(m) {
  const parts = [];
  if (m.photo) {
    const p = [...m.photo].reverse().find((x) => (x.file_size || 0) < 4.5e6) || m.photo[0];
    const f = await tg('getFile', { file_id: p.file_id });
    if (f.ok) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f.result.file_path).toString('base64') } });
  }
  let text = m.text || m.caption || '';
  if (m.reply_to_message?.text) text = `(replying to: "${m.reply_to_message.text.slice(0, 300)}")\n${text}`;
  parts.push({ type: 'text', text: text || '(image only)' });
  return parts;
}

async function claude(body) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    return await r.json();
  } catch (e) { return { error: { message: e.message } }; }
}

// =================== scheduled ===================
setInterval(async () => {
  const cfg = store.get('config', {});
  if (!cfg.chatId) return;
  const now = torontoNow();
  if (now.hour === REMINDER_HOUR && cfg.topics.rundown && once(`remind:${now.date}`)) {
    const members = store.get('members', {}), day = store.get(`rundown:${now.date}`, {});
    const missing = Object.entries(members).filter(([id]) => !day[id]);
    await send(cfg.chatId, missing.length
      ? `⏰ Rundown time. Still waiting on: ${missing.map(([id, u]) => `<a href="tg://user?id=${id}">${esc(u.name)}</a>`).join(', ')}\nDrop what you did today 👇`
      : '✅ Everyone has posted a rundown today. Nice work.', cfg.topics.rundown, true);
  }
  if (now.weekday === WEEKLY_DAY && now.hour === WEEKLY_HOUR && cfg.topics.tasks && once(`weekly:${now.date}`)) {
    await send(cfg.chatId, '🗓 Weekly task check-in\n\n' + taskList(), cfg.topics.tasks);
  }
}, 60e3);
function once(key) { const s = store.get('sent', {}); if (s[key]) return false; s[key] = 1; store.put('sent', s); return true; }

// =================== helpers ===================
function taskList() {
  const items = store.get('tasks', { items: [] }).items;
  const open = items.filter((t) => t.status === 'todo' || t.status === 'doing');
  const done = items.filter((t) => t.status === 'done' && t.doneAt > Date.now() - 7 * 864e5);
  if (!open.length && !done.length) return 'No tasks yet. Post one in 📋 Future Tasks.';
  const f = (t) => `${t.status === 'doing' ? '🟨' : t.status === 'done' ? '✅' : '⬜'} #${t.id} ${t.text}${t.assignee ? ` → ${t.assignee}` : ''}${t.due ? ` (due ${t.due})` : ''}`;
  return (open.length ? `Open (${open.length})\n${open.map(f).join('\n')}` : 'No open tasks 🎉') + (done.length ? `\n\nDone this week\n${done.map(f).join('\n')}` : '');
}
function rundownStatus() {
  const { date } = torontoNow(); const members = store.get('members', {}), day = store.get(`rundown:${date}`, {});
  return `Rundowns for ${date}\n` + (Object.entries(members).map(([id, u]) => `${day[id] ? '✅' : '⬜'} ${u.name}`).join('\n') || 'Nobody tracked yet.');
}
async function postPinned(chatId, thread, text) {
  const r = await send(chatId, text, thread);
  if (r.ok) await tg('pinChatMessage', { chat_id: chatId, message_id: r.result.message_id, disable_notification: true });
}
async function isAdmin(chat_id, user_id) { const r = await tg('getChatMember', { chat_id, user_id }); return r.ok && ['creator', 'administrator'].includes(r.result.status); }
async function isMember(chat_id, user_id) { const r = await tg('getChatMember', { chat_id, user_id }); return r.ok && ['creator', 'administrator', 'member', 'restricted'].includes(r.result.status); }
function rememberMember(u) { const ms = store.get('members', {}); if (ms[u.id]?.name !== name(u)) { ms[u.id] = { name: name(u), username: u.username || '' }; store.put('members', ms); } }
function pushHistory(key, line) { const h = store.get(`hist:${key}`, []); h.push(line.slice(0, 600)); store.put(`hist:${key}`, h.slice(-HISTORY)); }
function torontoNow(ts = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const name = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'someone';

// =================== web: health + Google connect ===================
http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const redirect = `${PUBLIC_URL}/oauth/callback`;
  try {
    if (url.pathname === '/auth') {
      if (url.searchParams.get('key') !== env.SETUP_KEY) { res.writeHead(403); return res.end('bad key'); }
      const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/drive.file', state: env.SETUP_KEY });
      res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}` }); return res.end();
    }
    if (url.pathname === '/oauth/callback') {
      if (url.searchParams.get('state') !== env.SETUP_KEY) { res.writeHead(403); return res.end('bad state'); }
      const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) }).then((x) => x.json());
      if (!t.refresh_token) throw new Error(JSON.stringify(t));
      const prev = store.get('google', {});
      store.put('google', { ...prev, refresh: t.refresh_token, access: t.access_token, exp: Date.now() + t.expires_in * 1000 });
      if (!prev.rootId) {
        const root = await createFolder(ROOT_FOLDER);
        store.put('google', { ...store.get('google'), rootId: root.id, rootLink: root.webViewLink });
      }
      flush();
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<h2>✅ Google Drive connected</h2><p>Content will save to <a href="${store.get('google').rootLink}">${ROOT_FOLDER}</a>. Share that folder with your team, or ask the bot to share it.</p>`);
    }
    res.writeHead(200); res.end('Net Zero X Venuum Socials bot is running.');
  } catch (e) { res.writeHead(500); res.end('Error: ' + e.message); }
}).listen(env.PORT || 3000);

poll();
