// ============================================================
//  Bot Server — refael-ai-flow
//  Runs on Render at https://bot-vibk.onrender.com
//
//  Two avatars on one server:
//   - POST /session         -> Mika (sales bot)
//                              tool: save_lead -> n8n lead-email -> Gmail
//   - POST /salon-session   -> Maya (salon receptionist demo)
//                              tool: book_appointment -> n8n salon-bot agent
//
//  FIXES IN THIS VERSION:
//   1. Maya timeoutSeconds 10 -> 8 (Runway API hard max)
//   2. RPC handler created BEFORE returning creds (no race condition)
//   3. Faster polling for session READY (500ms instead of 1500ms)
//   4. /prewarm endpoint for frontend warm-start signal
// ============================================================

import express from 'express';
import cors from 'cors';
import RunwayML from '@runwayml/sdk';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const {
  RUNWAYML_API_SECRET,
  RUNWAY_AVATAR_ID,            // Mika
  SALON_AVATAR_ID,             // Maya (optional, falls back to known id)
  N8N_LEAD_WEBHOOK,
  N8N_WEBHOOK_URL,             // legacy
  N8N_SALON_WEBHOOK,           // optional override
  ALLOWED_ORIGIN,
  PORT = 3000,
} = process.env;

const LEAD_WEBHOOK = N8N_LEAD_WEBHOOK || N8N_WEBHOOK_URL;
const SALON_WEBHOOK =
  N8N_SALON_WEBHOOK ||
  'https://rafa5555.app.n8n.cloud/webhook/salon-bot/v1/chat/completions';
const SALON_AVATAR =
  SALON_AVATAR_ID || '72860735-d02e-49af-9b5d-1020bc956ebc';

for (const [k, v] of Object.entries({ RUNWAYML_API_SECRET, RUNWAY_AVATAR_ID, LEAD_WEBHOOK })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

const runway = new RunwayML({ apiKey: RUNWAYML_API_SECRET });
const handlers = new Map();

// ============================================================
//  RATE LIMITING (daily server-wide kill switch)
//  Set DAILY_SESSION_CAP env var to enable. 0 or unset = unlimited.
// ============================================================
const DAILY_CAP = Number(process.env.DAILY_SESSION_CAP || 0);
let sessionsToday = 0;
let dayKey = new Date().toISOString().slice(0, 10);

function checkAndIncrementDailyCap() {
  if (DAILY_CAP <= 0) return true; // unlimited
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    sessionsToday = 0;
    console.log('[rate-limit] new day, counter reset');
  }
  if (sessionsToday >= DAILY_CAP) {
    return false;
  }
  sessionsToday += 1;
  console.log(`[rate-limit] session ${sessionsToday}/${DAILY_CAP} today`);
  return true;
}

// ============================================================
//  Personalities
// ============================================================
const MIKA_PERSONALITY = `את מיקה, העוזרת של רפאל סילניקובה. רפאל בונה בוטים, אבטרים מדברים ואוטומציות לעסקים קטנים בישראל.

שפה: זיהוי אוטומטי. עברית -> עברית. אנגלית -> אנגלית. לעולם אל תערבבי שפות.

סגנון: 1-3 משפטים קצרים. טון ישראלי ישיר. בלי אימוג'ים. בלי ז'רגון. ענייניית, חברותית, לא דוחפת.

מקור המידע שלך:
- כל פרטי השירותים, המחירים והפיצ'רים נמצאים בבסיס הידע שלך.
- עני תמיד מהידע שלך. אל תמציאי.
- אם שאלה לא מכוסה: "רפאל יענה לך על זה ישירות, אפשר להשאיר פרטים?"

חוק חזק: אין דמי מנוי חודשיים. בכלל. אף פעם. רק הקמה חד פעמית.

תפקיד: אספי שם -> טלפון/אימייל -> סוג עסק. כשיש שלושת הפרטים, קראי ל-save_lead פעם אחת. אחרי שהצליח: "תודה, רפאל יחזור אלייך תוך שעתיים."

חוקים: אל תקראי ל-save_lead פעמיים. אל תבקשי מידע שכבר ניתן. בלי לערבב שפות.`;

const MIKA_START = 'היי, אני מיקה — איזה עסק יש לך?';

const MAYA_PERSONALITY = `את מאיה, מזכירה דיגיטלית במספרה "Glow Studio" בתל אביב. דמו חי.

המטרה היחידה שלך: לאסוף 4 פרטים ולקרוא לטול book_appointment.

הפרטים הנדרשים:
1. שם
2. אימייל (חייב להכיל @)
3. סוג שירות (תספורת, מניקור, צבע, וכו')
4. תאריך + שעה

כללי עבודה:
- ענייני בעברית קצרה, 1-2 משפטים בלבד.
- בכל תשובה: אם חסר פרט - בקשי אותו. אם יש 4 פרטים - קראי לטול מיד.
- אסור לבקש מידע שכבר ניתן.
- אסור לערבב שפות.
- אסור להמציא מחירים או שירותים.
- אסור לחזור על הברכה.

איך לקרוא לטול:
ברגע שיש שם + אימייל + שירות + תאריך, קראי ל-book_appointment עם הפרמטרים. אל תשאלי "האם לקבוע?". אל תגידי "אני מקבעת". פשוט קראי לטול ואז דווחי על התוצאה.

תוצאות הטול:
- booked: "שלחתי לך אישור במייל. נתראה ב-[date_time]!"
- invalid_email: "האימייל לא תקין, אפשר לחזור עליו?"
- error: "סליחה, נסי שוב או צרי קשר בטלפון 03-555-1234."

חוק קריטי: אסור לומר שיש שגיאה אם לא קראת לטול. אם לא הייתה קריאה לטול - אין מה לדווח עליו.

תמיד הניחי שהשעה פנויה. זה דמו, לא יומן אמיתי.`;

const MAYA_START = 'היי, אני מאיה! איך אפשר לעזור היום?';

// ============================================================
//  Helpers
// ============================================================
async function createSessionWithTool({ avatarId, personality, startScript, tool }) {
  const { id: sessionId } = await runway.realtimeSessions.create({
    model: 'gwm1_avatars',
    avatar: { type: 'custom', avatarId },
    personality,
    startScript,
    tools: [tool],
  });

  // Faster polling: 500ms (was 1500ms). Cuts session-ready wait by ~3x.
  let sessionKey;
  for (let i = 0; i < 180; i++) {
    const s = await runway.realtimeSessions.retrieve(sessionId);
    if (s.status === 'READY') { sessionKey = s.sessionKey; break; }
    if (s.status === 'FAILED' || s.status === 'CANCELLED') {
      throw new Error(s.failure || 'session failed');
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!sessionKey) throw new Error('session timed out');

  const consumeRes = await fetch(
    `https://api.dev.runwayml.com/v1/realtime_sessions/${sessionId}/consume`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionKey}`,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json',
      },
    }
  );
  if (!consumeRes.ok) throw new Error(`consume failed: ${await consumeRes.text()}`);
  const credentials = await consumeRes.json();

  return { sessionId, credentials };
}

function returnCreds(res, sessionId, credentials) {
  res.json({
    sessionId,
    serverUrl: credentials.serverUrl || credentials.url || credentials.wsUrl,
    token: credentials.token || credentials.accessToken || credentials.participantToken,
    roomName: credentials.roomName,
  });
}

// ============================================================
//  Routes
// ============================================================
app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Prewarm signal — does nothing, but the request itself wakes the Render dyno
app.get('/prewarm', (_req, res) => res.json({ warm: true, ts: Date.now() }));

// ----- MIKA: /session -----
app.post('/session', async (req, res) => {
  if (!checkAndIncrementDailyCap()) {
    console.warn('[mika] daily cap reached');
    return res.status(429).json({ error: 'daily_cap', message: 'Daily session limit reached. Try again tomorrow.' });
  }
  try {
    const clientSessionId = req.body?.sessionId || null;

    const { sessionId, credentials } = await createSessionWithTool({
      avatarId: RUNWAY_AVATAR_ID,
      personality: MIKA_PERSONALITY,
      startScript: MIKA_START,
      tool: {
        type: 'backend_rpc',
        name: 'save_lead',
        description:
          'Save a qualified lead. Call ONCE per conversation, only after collecting name, contact (phone or email), and business type. Do not call twice.',
        timeoutSeconds: 5,
        parameters: [
          { type: 'string', name: 'name',     description: 'Lead name' },
          { type: 'string', name: 'contact',  description: 'Phone number or email' },
          { type: 'string', name: 'business', description: 'Business type' },
        ],
      },
    });
    console.log('[mika] session', sessionId, 'client:', clientSessionId);

    const leadFired = new Set();

    // CREATE RPC HANDLER BEFORE returning creds (fixes race condition).
    // Previously: returnCreds() ran first, client connected WebRTC, but server
    // RPC wasn't bound yet -> "disconnected" log + dropped session.
    const handler = await createRpcHandler({
      apiKey: RUNWAYML_API_SECRET,
      sessionId,
      tools: {
        save_lead: async (args) => {
          const name = String(args?.name || '').trim();
          const contact = String(args?.contact || '').trim();
          const business = String(args?.business || '').trim();
          if (!name || !contact) {
            return { result: 'missing_required_fields', message: 'Need name and contact.' };
          }
          const key = `${name}|${contact}`.toLowerCase();
          if (leadFired.has(key)) {
            return { result: 'already_saved', message: 'Already saved. Tell user "כבר שמרתי את הפרטים."' };
          }
          leadFired.add(key);
          try {
            const r = await fetch(LEAD_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name, contact, business: business || 'לא צוין',
                sessionId, clientSessionId,
                source: 'runway-mika',
                submittedAt: new Date().toISOString(),
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) throw new Error(`n8n ${r.status}`);
            console.log('[save_lead] ok', name);
            return { result: 'saved', message: 'Lead saved. Tell user "תודה, רפאל יחזור אלייך תוך שעתיים."' };
          } catch (e) {
            console.error('[save_lead] fail:', e.message);
            leadFired.delete(key);
            return { result: 'error', message: 'Could not save. Ask user to WhatsApp Rafael.' };
          }
        },
      },
      onConnected: () => console.log('[mika rpc] connected', sessionId),
      onDisconnected: () => { handlers.delete(sessionId); console.log('[mika rpc] disconnected', sessionId); },
      onError: (e) => console.error('[mika rpc] err:', e),
    });
    handlers.set(sessionId, handler);

    // Now safe to return creds — RPC handler is bound and ready
    returnCreds(res, sessionId, credentials);
  } catch (e) {
    console.error('[mika session] fail:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----- MAYA (SALON): /salon-session -----
app.post('/salon-session', async (req, res) => {
  if (!checkAndIncrementDailyCap()) {
    console.warn('[maya] daily cap reached');
    return res.status(429).json({ error: 'daily_cap', message: 'Daily session limit reached. Try again tomorrow.' });
  }
  try {
    const clientSessionId = req.body?.sessionId || null;

    const { sessionId, credentials } = await createSessionWithTool({
      avatarId: SALON_AVATAR,
      personality: MAYA_PERSONALITY,
      startScript: MAYA_START,
      tool: {
        type: 'backend_rpc',
        name: 'book_appointment',
        description:
          'Book a salon appointment and send confirmation email. Call ONCE per appointment, only after collecting name, email, service_type, and date_time. Returns booked / error.',
        // FIX: Runway API hard max is 8 seconds. Was 10 -> caused every Maya
        // session to fail with "tools[0].timeoutSeconds: Too big (max 8)".
        timeoutSeconds: 8,
        parameters: [
          { type: 'string', name: 'name',         description: 'Client full name' },
          { type: 'string', name: 'email',        description: 'Client email address (must contain @)' },
          { type: 'string', name: 'service_type', description: 'Service requested (use exact name from knowledge base)' },
          { type: 'string', name: 'date_time',    description: 'Preferred date and time in natural language (e.g. "tomorrow at 3pm" or "מחר ב-15:00")' },
        ],
      },
    });
    console.log('[maya] session', sessionId, 'client:', clientSessionId);

    const booked = new Set();

    // Same fix as Mika: bind RPC handler BEFORE returning creds
    const handler = await createRpcHandler({
      apiKey: RUNWAYML_API_SECRET,
      sessionId,
      tools: {
        book_appointment: async (args) => {
          const name = String(args?.name || '').trim();
          const email = String(args?.email || '').trim();
          const service = String(args?.service_type || '').trim();
          const when = String(args?.date_time || '').trim();

          if (!name || !email || !service || !when) {
            return { result: 'missing_required_fields', message: 'Need name, email, service, and date/time.' };
          }
          if (!email.includes('@')) {
            return { result: 'invalid_email', message: 'Email format is invalid. Ask user for a valid email.' };
          }
          const key = `${name}|${email}|${when}`.toLowerCase();
          if (booked.has(key)) {
            return { result: 'already_booked', message: 'Already booked. Tell user it is confirmed.' };
          }
          booked.add(key);

          try {
            // Send a clean JSON-like message that n8n agent can parse and pass to Gmail tool
            const r = await fetch(SALON_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{
                  role: 'user',
                  content:
                    `BOOKING_REQUEST: name="${name}", email="${email}", service="${service}", date_time="${when}". ` +
                    `Send confirmation email via gmail tool. Reply with only "BOOKED" if email sent successfully, or "ERROR" if not.`,
                }],
                session_id: sessionId,
                source: 'runway-maya',
                booking: { name, email, service, date_time: when },
              }),
              signal: AbortSignal.timeout(7000),
            });
            if (!r.ok) throw new Error(`n8n ${r.status}`);
            const data = await r.json();
            const replyText =
              data?.choices?.[0]?.message?.content ||
              data?.reply || data?.output || data?.answer || '';
            const reply = String(replyText).toUpperCase();

            if (reply.includes('BOOKED')) {
              console.log('[book_appointment] ok', name, email, when);
              return {
                result: 'booked',
                message: `Booked and email sent. Tell user: "שלחתי לך אישור במייל ל-${email}. נתראה ב-${when}!"`,
              };
            }
            booked.delete(key);
            return { result: 'error', message: 'Email send failed. Apologize, ask user to call 03-555-1234.' };
          } catch (e) {
            console.error('[book_appointment] fail:', e.message);
            booked.delete(key);
            return { result: 'error', message: 'Booking system error. Ask user to call 03-555-1234.' };
          }
        },
      },
      onConnected: () => console.log('[maya rpc] connected', sessionId),
      onDisconnected: () => { handlers.delete(sessionId); console.log('[maya rpc] disconnected', sessionId); },
      onError: (e) => console.error('[maya rpc] err:', e),
    });
    handlers.set(sessionId, handler);

    returnCreds(res, sessionId, credentials);
  } catch (e) {
    console.error('[maya session] fail:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

process.on('SIGTERM', async () => {
  for (const h of handlers.values()) { try { await h.close(); } catch {} }
  process.exit(0);
});

app.listen(PORT, () => console.log(`bot server listening :${PORT} (mika + maya)`));
