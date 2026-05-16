// ============================================================
//  Bot Server — refael-ai-flow
//  Runs on Render at https://bot-vibk.onrender.com
//
//  Two avatars on one server:
//   - POST /session         -> Mika (sales bot)
//                              tool: save_lead -> n8n lead-email -> Gmail
//   - POST /salon-session   -> Maya (salon receptionist demo)
//                              tool: book_appointment -> n8n salon-bot agent
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

const MAYA_PERSONALITY = `את מאיה, מזכירה דיגיטלית של מספרת/קליניקת ציפורניים "Glow Studio" בתל אביב.

שפה: זיהוי אוטומטי. עברית -> עברית. אנגלית -> אנגלית. לעולם אל תערבבי שפות.

סגנון: 1-3 משפטים קצרים. חמה, מקצועית, יעילה. בלי אימוג'ים. בלי ז'רגון.

מקור המידע שלך: בסיס הידע שלך מכיל מחירים, שירותים, שעות פתיחה, מדיניות. עני תמיד משם. אל תמציאי.

תפקיד שלך - לקבוע תור:
1. ברכי, שאלי איך אפשר לעזור.
2. עני על שאלות שירותים/מחירים/שעות מבסיס הידע.
3. לקביעת תור, אספי בסדר הזה:
   - שם הלקוח/ה
   - מספר טלפון
   - סוג שירות (מתוך הרשימה בידע)
   - תאריך ושעה מועדפים
4. ברגע שיש ארבעת הפרטים, קראי ל-book_appointment פעם אחת.
5. אחרי שהצליח: "התור שלך נקבע ל-[תאריך] בשעה [שעה]. נתראה!"

חוקים נוקשים:
- אל תקבעי תור בלי ארבעת הפרטים.
- אל תקראי ל-book_appointment יותר מפעם אחת.
- אם הטול מחזיר slot_taken: התנצלי, הציעי 2 אפשרויות סמוכות.
- אם הטול מחזיר error: התנצלי, בקשי שיתקשרו 03-555-1234.
- אל תבקשי מידע שכבר ניתן.
- בלי לערבב שפות.
- אל תמציאי שעות פנויות בלי לבדוק.`;

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

  let sessionKey;
  for (let i = 0; i < 60; i++) {
    const s = await runway.realtimeSessions.retrieve(sessionId);
    if (s.status === 'READY') { sessionKey = s.sessionKey; break; }
    if (s.status === 'FAILED' || s.status === 'CANCELLED') {
      throw new Error(s.failure || 'session failed');
    }
    await new Promise(r => setTimeout(r, 1500));
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

// ----- MIKA: /session -----
app.post('/session', async (req, res) => {
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

    returnCreds(res, sessionId, credentials);
  } catch (e) {
    console.error('[mika session] fail:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ----- MAYA (SALON): /salon-session -----
app.post('/salon-session', async (req, res) => {
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
          'Book a salon appointment. Call ONCE per appointment, only after collecting name, phone, service_type, and date_time. Returns booked / slot_taken / error.',
        timeoutSeconds: 10,
        parameters: [
          { type: 'string', name: 'name',         description: 'Client name' },
          { type: 'string', name: 'phone',        description: 'Phone number' },
          { type: 'string', name: 'service_type', description: 'Service requested (use exact name from knowledge)' },
          { type: 'string', name: 'date_time',    description: 'Preferred date and time in natural language' },
        ],
      },
    });
    console.log('[maya] session', sessionId, 'client:', clientSessionId);

    const booked = new Set();
    const handler = await createRpcHandler({
      apiKey: RUNWAYML_API_SECRET,
      sessionId,
      tools: {
        book_appointment: async (args) => {
          const name = String(args?.name || '').trim();
          const phone = String(args?.phone || '').trim();
          const service = String(args?.service_type || '').trim();
          const when = String(args?.date_time || '').trim();

          if (!name || !phone || !service || !when) {
            return { result: 'missing_required_fields', message: 'Need name, phone, service, and date/time.' };
          }
          const key = `${name}|${phone}|${when}`.toLowerCase();
          if (booked.has(key)) {
            return { result: 'already_booked', message: 'Already booked. Tell user it is confirmed.' };
          }
          booked.add(key);

          try {
            const r = await fetch(SALON_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{
                  role: 'user',
                  content:
                    `BOOKING_REQUEST: name="${name}", phone="${phone}", service="${service}", date_time="${when}". ` +
                    `Check calendar availability, create event if free, append to sheet, then reply with only one of these tokens: ` +
                    `BOOKED:<confirmed_iso_datetime> | SLOT_TAKEN | ERROR.`,
                }],
                session_id: sessionId,
                source: 'runway-maya',
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (!r.ok) throw new Error(`n8n ${r.status}`);
            const data = await r.json();
            const replyText =
              data?.choices?.[0]?.message?.content ||
              data?.reply || data?.output || data?.answer || '';
            const reply = String(replyText).toUpperCase();

            if (reply.includes('BOOKED')) {
              console.log('[book_appointment] ok', name, when);
              return {
                result: 'booked',
                message: `Booked. Tell user: "התור שלך נקבע ל-${when}. נתראה!"`,
              };
            }
            if (reply.includes('SLOT_TAKEN')) {
              booked.delete(key);
              return {
                result: 'slot_taken',
                message: 'Slot taken. Apologize, suggest 2 alternatives (30min before/after, or next day same time).',
              };
            }
            booked.delete(key);
            return { result: 'error', message: 'Booking error. Apologize, ask user to call 03-555-1234.' };
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
