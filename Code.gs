const REGISTRY_PROP = 'WORKBENCH_ACCOUNTS_SHEET_ID';
const SESSION_TTL_SECONDS = 21600;
const PASSWORD_HASH_ROUNDS = 60000;
const USER_HEADERS = ['Email', 'Password Salt', 'Password Hash', 'Spreadsheet ID', 'Created At', 'Verified At', 'Auth Version'];

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'privacy') return HtmlService.createHtmlOutputFromFile('Privacy').setTitle('Workbench privacy');
  return HtmlService.createTemplateFromFile('Index').evaluate().setTitle('Workbench');
}
function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

function apiRequest(path, method, payload) {
  payload = payload || {};
  method = String(method || 'GET').toUpperCase();
  if (path === '/auth/register' && method === 'POST') return register_(payload);
  if (path === '/auth/verify' && method === 'POST') return verifyRegistration_(payload);
  if (path === '/auth/login' && method === 'POST') return login_(payload);
  if (path === '/auth/request-reset' && method === 'POST') return requestPasswordReset_(payload);
  if (path === '/auth/reset' && method === 'POST') return resetPassword_(payload);
  if (path === '/auth/me' && method === 'GET') {
    const ctx = session_(payload.token);
    return { authenticated: true, email: ctx.user.email };
  }
  if (path === '/auth/logout' && method === 'POST') {
    if (payload.token) CacheService.getScriptCache().remove('session:' + payload.token);
    return { ok: true };
  }

  const ctx = session_(payload.token);
  const ss = SpreadsheetApp.openById(ctx.user.spreadsheetId);
  if (path === '/api/status' && method === 'GET') {
    installReminderTrigger_();
    return { backend: true, configured: true, connected: true, email: ctx.user.email };
  }
  if (path === '/api/tasks' && method === 'GET') return read_(ss, 'Tasks');
  if (path === '/api/tasks' && method === 'PUT') return { ok: true, count: saveTasks_(ss, payload.tasks || []) };
  if (path === '/api/projects' && method === 'GET') return read_(ss, 'Projects').map(x => x.name || x);
  if (path === '/api/projects' && method === 'PUT') return { ok: true, count: write_(ss, 'Projects', (payload.projects || []).map(name => ({ name: String(name).slice(0, 100) }))) };
  if (path === '/api/meetings' && method === 'GET') return read_(ss, 'Meetings');
  if (path === '/api/meetings' && method === 'PUT') return { ok: true, count: saveMeetings_(ss, payload.meetings || []) };
  throw new Error('Unsupported Workbench request.');
}

function register_(payload) {
  const email = normalizeEmail_(payload.email), password = String(payload.password || '');
  validateEmail_(email); validatePassword_(password);
  enforceRateLimit_('register:' + hashText_(email), 3, 3600);
  enforceRateLimit_('email:global', 70, 86400);
  const cache = CacheService.getScriptCache(), key = 'verify:' + hashText_(email);
  const existing = findUser_(email);
  if (existing) return { ok: true, verificationRequired: true, message: 'If this address can be registered, a verification code has been sent.' };
  const code = randomCode_(), salt = randomToken_();
  const state = { email, salt, passwordHash: passwordHash_(password, salt), codeHash: hashText_(salt + ':' + code), attempts: 0 };
  cache.put(key, JSON.stringify(state), 900);
  MailApp.sendEmail({ to: email, subject: 'Verify your Workbench account', body: 'Your Workbench verification code is ' + code + '. It expires in 15 minutes. If you did not request this, you can ignore this email.' });
  return { ok: true, verificationRequired: true, message: 'Enter the verification code we emailed to you.' };
}

function verifyRegistration_(payload) {
  const email = normalizeEmail_(payload.email), code = String(payload.code || '').trim();
  validateEmail_(email);
  const cache = CacheService.getScriptCache(), key = 'verify:' + hashText_(email), raw = cache.get(key);
  if (!raw) throw new Error('That code expired. Request a new one and try again.');
  const state = JSON.parse(raw); state.attempts = Number(state.attempts || 0) + 1;
  if (state.attempts > 5) { cache.remove(key); throw new Error('Too many attempts. Request a new verification code.'); }
  cache.put(key, JSON.stringify(state), 900);
  if (!constantTimeEqual_(state.codeHash, hashText_(state.salt + ':' + code))) throw new Error('The verification code is incorrect.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if (findUser_(email)) { cache.remove(key); throw new Error('An account already exists for this email. Please sign in.'); }
    const ss = createUserSpreadsheet_(email);
    const registry = registrySheet_();
    registry.appendRow([email, state.salt, state.passwordHash, ss.getId(), new Date(), new Date(), 1]);
  } finally { lock.releaseLock(); }
  cache.remove(key);
  installReminderTrigger_();
  return createSession_(email);
}

function login_(payload) {
  const email = normalizeEmail_(payload.email), password = String(payload.password || '');
  validateEmail_(email);
  enforceRateLimit_('login:global', 500, 3600);
  enforceRateLimit_('login:' + hashText_(email), 8, 900);
  const user = findUser_(email);
  const calculated = user ? passwordHash_(password, user.salt) : passwordHash_(password || 'invalid-password', randomToken_());
  if (!user || !constantTimeEqual_(calculated, user.passwordHash)) throw new Error('Email or password is incorrect.');
  CacheService.getScriptCache().remove('limit:login:' + hashText_(email));
  return createSession_(email);
}

function requestPasswordReset_(payload) {
  const email = normalizeEmail_(payload.email); validateEmail_(email);
  enforceRateLimit_('reset:' + hashText_(email), 3, 3600);
  enforceRateLimit_('email:global', 70, 86400);
  const user = findUser_(email);
  if (user) {
    const code = randomCode_(), salt = randomToken_();
    CacheService.getScriptCache().put('reset:' + hashText_(email), JSON.stringify({ codeHash: hashText_(salt + ':' + code), salt, attempts: 0 }), 900);
    MailApp.sendEmail({ to: email, subject: 'Reset your Workbench password', body: 'Your Workbench password reset code is ' + code + '. It expires in 15 minutes. If you did not request this, you can ignore this email.' });
  }
  return { ok: true, message: 'If an account exists for that address, a reset code has been sent.' };
}

function resetPassword_(payload) {
  const email = normalizeEmail_(payload.email), code = String(payload.code || '').trim(), password = String(payload.password || '');
  validateEmail_(email); validatePassword_(password);
  const cache = CacheService.getScriptCache(), key = 'reset:' + hashText_(email), raw = cache.get(key);
  if (!raw) throw new Error('That code expired. Request a new one and try again.');
  const state = JSON.parse(raw); state.attempts = Number(state.attempts || 0) + 1;
  if (state.attempts > 5) { cache.remove(key); throw new Error('Too many attempts. Request a new reset code.'); }
  cache.put(key, JSON.stringify(state), 900);
  if (!constantTimeEqual_(state.codeHash, hashText_(state.salt + ':' + code))) throw new Error('The reset code is incorrect.');
  const user = findUser_(email); if (!user) { cache.remove(key); throw new Error('The account could not be found.'); }
  const newSalt = randomToken_();
  registrySheet_().getRange(user.row, 2, 1, 2).setValues([[newSalt, passwordHash_(password, newSalt)]]);
  registrySheet_().getRange(user.row, 7).setValue((user.authVersion || 1) + 1);
  cache.remove(key);
  return createSession_(email);
}

function createSession_(email) {
  const token = randomToken_() + randomToken_();
  const user = findUser_(email);
  if (!user) throw new Error('The account could not be found. Please sign in again.');
  CacheService.getScriptCache().put('session:' + token, JSON.stringify({ email, authVersion: user.authVersion }), SESSION_TTL_SECONDS);
  return { ok: true, authenticated: true, token, email };
}
function session_(token) {
  token = String(token || '');
  if (!/^[a-f0-9-]{60,80}$/i.test(token)) throw new Error('Please sign in to continue.');
  const session = CacheService.getScriptCache().get('session:' + token);
  if (!session) throw new Error('Your session expired. Please sign in again.');
  const state = JSON.parse(session), user = findUser_(state.email);
  if (!user || !user.spreadsheetId || user.authVersion !== state.authVersion) throw new Error('Your session has expired. Please sign in again.');
  return { user };
}

function registrySheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(REGISTRY_PROP), ss;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { props.deleteProperty(REGISTRY_PROP); } }
  if (!ss) {
    ss = SpreadsheetApp.create('Workbench — Account Registry');
    const sheet = ss.getSheets()[0]; sheet.setName('Users'); sheet.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
    props.setProperty(REGISTRY_PROP, ss.getId());
  }
  let sheet = ss.getSheetByName('Users');
  if (!sheet) { sheet = ss.insertSheet('Users'); sheet.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]); }
  return sheet;
}
function findUser_(email) {
  const sheet = registrySheet_(), last = sheet.getLastRow();
  if (last < 2) return null;
  const values = sheet.getRange(2, 1, last - 1, USER_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) if (String(values[i][0]).toLowerCase() === email) return { row: i + 2, email: String(values[i][0]), salt: String(values[i][1]), passwordHash: String(values[i][2]), spreadsheetId: String(values[i][3]), authVersion: Number(values[i][6]) || 1 };
  return null;
}
function createUserSpreadsheet_(email) {
  const ss = SpreadsheetApp.create('Workbench — ' + email);
  ['Tasks', 'Projects', 'Meetings'].forEach(name => { const sh = ss.getSheetByName(name) || ss.insertSheet(name); sh.appendRow(['ID', 'Record JSON']); });
  const first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  return ss;
}

function passwordHash_(password, saltBase64) {
  const key = Utilities.newBlob(String(password)).getBytes(), salt = Utilities.base64Decode(saltBase64);
  let u = Utilities.computeHmacSha256Signature(salt.concat([0, 0, 0, 1]), key), result = u.slice();
  for (let i = 1; i < PASSWORD_HASH_ROUNDS; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < result.length; j++) result[j] = result[j] ^ u[j];
  }
  return Utilities.base64Encode(result);
}
function randomToken_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function randomCode_() { return String(parseInt(randomToken_().slice(0, 8), 16) % 100000000).padStart(8, '0'); }
function hashText_(value) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value))); }
function constantTimeEqual_(a, b) { a = String(a || ''); b = String(b || ''); let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
function normalizeEmail_(email) { return String(email || '').trim().toLowerCase(); }
function validateEmail_(email) { if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.'); }
function validatePassword_(password) { if (password.length < 12 || password.length > 256) throw new Error('Use a password with at least 12 characters.'); }
function enforceRateLimit_(name, max, seconds) {
  const cache = CacheService.getScriptCache(), key = 'limit:' + name, count = Number(cache.get(key) || 0);
  if (count >= max) throw new Error('Too many attempts. Please wait a while and try again.');
  cache.put(key, String(count + 1), seconds);
}

function ensureSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 2).setValues([['ID', 'Record JSON']]);
  return sheet;
}
function read_(ss, name) {
  const sheet = ensureSheet_(ss, name);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues().map(row => { try { return JSON.parse(row[0]); } catch (e) { return null; } }).filter(Boolean);
}
function write_(ss, name, records) {
  const sheet = ensureSheet_(ss, name), rows = records.map(record => [String(record.id || record.name || Utilities.getUuid()), JSON.stringify(record)]);
  const last = sheet.getLastRow(); if (last > 1) sheet.getRange(2, 1, last - 1, 2).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  return rows.length;
}
function saveTasks_(ss, tasks) {
  const old = read_(ss, 'Tasks'), oldById = Object.fromEntries(old.map(t => [String(t.id), t]));
  const records = tasks.slice(0, 3000).map(t => {
    const previous = oldById[String(t.id)], reminderAt = validDate_(t.reminderAt);
    return { ...t, id: String(t.id || Utilities.getUuid()).slice(0, 100), name: String(t.name || '').slice(0, 200), project: String(t.project || '').slice(0, 100), effort: ['none', 'low', 'medium', 'high'].includes(t.effort) ? t.effort : 'medium', time: Math.max(1, Math.min(10080, Number(t.time) || 30)), due: String(t.due || '').slice(0, 30), reminderAt, reminderSentAt: previous && previous.reminderAt === reminderAt ? (previous.reminderSentAt || '') : '', alignment: Array.isArray(t.alignment) ? t.alignment.filter(x => ['love', 'strength', 'need', 'value'].includes(x)).slice(0, 4) : [], done: Boolean(t.done), created: Number(t.created) || Date.now() };
  });
  return write_(ss, 'Tasks', records);
}
function saveMeetings_(ss, meetings) {
  const records = meetings.slice(0, 1000).map(m => ({ ...m, id: String(m.id || Utilities.getUuid()).slice(0, 100), title: String(m.title || '').slice(0, 160), startsAt: validDate_(m.startsAt), duration: Math.max(1, Math.min(1440, Number(m.duration) || 60)), location: String(m.location || '').slice(0, 400), reminderMinutes: Math.max(0, Math.min(40320, Number(m.reminderMinutes) || 0)) }));
  const old = read_(ss, 'Meetings'), oldById = Object.fromEntries(old.map(m => [String(m.id), m]));
  records.forEach(m => { const previous = oldById[String(m.id)]; m.reminderSentAt = previous && previous.reminderAt === m.reminderAt ? (previous.reminderSentAt || '') : ''; });
  return write_(ss, 'Meetings', records);
}
function validDate_(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toISOString(); }

function installReminderTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'sendDueTaskReminders')) ScriptApp.newTrigger('sendDueTaskReminders').timeBased().everyMinutes(5).create();
}
function sendDueTaskReminders() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return;
  try {
    const sheet = registrySheet_(), last = sheet.getLastRow(); if (last < 2) return;
    const users = sheet.getRange(2, 1, last - 1, USER_HEADERS.length).getValues(), now = Date.now();
    users.forEach(row => {
      const email = String(row[0] || ''), spreadsheetId = String(row[3] || ''); if (!email || !spreadsheetId) return;
      const ss = SpreadsheetApp.openById(spreadsheetId), tasks = read_(ss, 'Tasks'), meetings = read_(ss, 'Meetings'); let taskChanged = false, meetingChanged = false;
      tasks.forEach(task => {
        if (!task.done && task.reminderAt && !task.reminderSentAt && new Date(task.reminderAt).getTime() <= now) {
          MailApp.sendEmail({ to: email, subject: 'Workbench task reminder: ' + String(task.name || 'Task').slice(0, 120), body: 'This is your scheduled task reminder.\n\n' + task.name + (task.project ? '\nProject: ' + task.project : '') + (task.due ? '\nDue date: ' + task.due : '') + '\n\nOpen Workbench to update the task.' });
          task.reminderSentAt = new Date().toISOString(); taskChanged = true;
        }
      });
      meetings.forEach(meeting => {
        if (meeting.reminderAt && !meeting.reminderSentAt && new Date(meeting.reminderAt).getTime() <= now && new Date(meeting.startsAt).getTime() > now) {
          MailApp.sendEmail({ to: email, subject: 'Workbench meeting reminder: ' + String(meeting.title || 'Meeting').slice(0, 120), body: 'Your meeting is coming up.\n\n' + meeting.title + '\n' + new Date(meeting.startsAt).toLocaleString() + (meeting.location ? '\n' + meeting.location : '') });
          meeting.reminderSentAt = new Date().toISOString(); meetingChanged = true;
        }
      });
      if (taskChanged) write_(ss, 'Tasks', tasks);
      if (meetingChanged) write_(ss, 'Meetings', meetings);
    });
  } finally { lock.releaseLock(); }
}
