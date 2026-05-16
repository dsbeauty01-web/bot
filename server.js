// ============================================================
//  Mika Bot Server — refael-ai-flow
//  Runs on Render at https://bot-vibk.onrender.com
//
//  Mika answers from her Runway Knowledge Base (uploaded in the portal).
//  Lead capture goes through save_lead -> n8n -> Gmail.
// ============================================================

import express from 'express';
import cors from 'cors';
import RunwayML from '@runwayml/sdk';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const {
  RUNWAYML_API_SECRET,
  RUNWAY_AVATAR_ID,
  N8N_LEAD_WEBHOOK,
  N8N_WEBHOOK_URL,
  ALLOWED_ORIGIN,
  PORT = 3000,
} = process.env;

const LEAD_WEBHOOK = N8N_LEAD_WEBHOOK || N8N_WEBHOOK_URL;

for (const [k, v] of Object.entries({ RUNWAYML_API_SECRET, RUNWAY_AVATAR_ID, LEAD_WEBHOOK })) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

const runway = new RunwayML({ apiKey: RUNWAYML_API_SECRET });
const handlers = new Map();

// ============================================================
//  Mika personality.
//  PRICING + FEATURES come from the Runway Knowledge Base, NOT this prompt.
//  Only the lead-capture flow + "no monthly fees" rule live here.
// ============================================================
const MIKA_PERSONALITY = `את מיקה, העוזרת של רפאל סילניקובה. רפאל בונה בוטים, אבטרים מדברים ואוטומציות לעסקים קטנים בישראל.

שפה:
- זיהוי אוטומטי. עברית -> עברית. אנגלית -> אנגלית.
- לעולם אל תערבבי שפות באותה תשובה.

סגנון:
- 1 עד 3 משפטים קצרים. טון ישראלי ישיר. בלי אימוג'ים. בלי ז'רגון.
- ענייניית וחברותית. לא דוחפת.

מקור המידע שלך:
- כל פרטי השירותים, המחירים, ההיקפים והאינטגרציות נמצאים בבסיס הידע שלך.
- עני תמיד מהידע שלך. אל תמציאי מחירים, תאריכים או פיצ'רים.
- אם שאלה לא מכוסה בידע - אמרי: "רפאל יענה לך על זה ישירות, אפשר להשאיר פרטים?"

חוק חזק על מחירים:
- אין דמי מנוי חודשיים. בכלל. אף פעם. רק הקמה חד פעמית.
- אם המשתמש שואל על "מנוי" או "תשלום חודשי", הסבירי שאין כזה.

תפקיד שלך - לאסוף ליד:
1. ברכי, שאלי איזה עסק יש למשתמש.
2. עני על שאלות מבסיס הידע שלך.
3. כשהמשתמש מתעניין, אספי בסדר הזה: שם -> טלפון או אימייל -> סוג עסק.
4. ברגע שיש לך את שלושת הפרטים, קראי לטול save_lead פעם אחת בלבד.
5. אחרי שהטול הצליח, אמרי: "תודה, רפאל יחזור אלייך תוך שעתיים."

חוקים נוקשים:
- אל תקראי ל-save_lead יותר מפעם אחת באותה שיחה.
- אל תבקשי מידע שהמשתמש כבר נתן.
- אל תמציאי. רק מהידע + מחוק "אין מנוי חודשי".
- בלי לערבב שפות.`;

const MIKA_START_SCRIPT = 'היי, אני מיקה — איזה עסק יש לך?';

// ============================================================
//  Routes
// ============================================================
app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/session', async (req, res) => {
  try {
    const clientSessionId = req.body?.sessionId || null;

    const { id: sessionId } = await runway.realtimeSessions.create({
      model: 'gwm1_avatars',
      avatar: { type: 'custom', avatarId: RUNWAY_AVATAR_ID },
      personality: MIKA_PERSONALITY,
      startScript: MIKA_START_SCRIPT,
      tools: [{
        type: 'backend_rpc',
        name: 'save_lead',
        description:
          'Save a qualified lead. Call ONCE per conversation, only after collecting name, contact (phone or email), and business type. Returns confirmation. Do not call twice.',
        timeoutSeconds: 5,
        parameters: [
          { type: 'string', name: 'name',     description: 'Lead name' },
          { type: 'string', name: 'contact',  description: 'Phone number or email' },
          { type: 'string', name: 'business', description: 'What kind of business the lead has' },
        ],
      }],
    });
    console.log('[session] created', sessionId, 'client:', clientSessionId);

    let sessionKey;
    for (let i = 0; i < 60; i++) {
      const s = await runway.realtimeSessions.retrieve(sessionId);
      if (s.status === 'READY') { sessionKey = s.sessionKey; break; }
      if (s.status === 'FAILED' || s.status === 'CANCELLED') {
        return res.status(500).json({ error: s.failure || 'session failed' });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!sessionKey) return res.status(504).json({ error: 'session timed out' });

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
    if (!consumeRes.ok) {
      return res.status(500).json({ error: `consume failed: ${await consumeRes.text()}` });
    }
    const credentials = await consumeRes.json();

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
            console.log('[save_lead] duplicate suppressed', key);
            return {
              result: 'already_saved',
              message: 'Already saved. Tell user "כבר שמרתי את הפרטים, רפאל יחזור אלייך."',
            };
          }
          leadFired.add(key);

          try {
            const r = await fetch(LEAD_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                contact,
                business: business || 'לא צוין',
                sessionId,
                clientSessionId,
                source: 'runway-avatar',
                submittedAt: new Date().toISOString(),
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) throw new Error(`n8n ${r.status}`);
            console.log('[save_lead] ok', name, contact);
            return {
              result: 'saved',
              message:
                'Lead saved. Tell user: "תודה, רפאל יחזור אלייך תוך שעתיים." Do not call this tool again.',
            };
          } catch (e) {
            console.error('[save_lead] fail:', e.message);
            leadFired.delete(key);
            return {
              result: 'error',
              message:
                'Could not save right now. Apologize briefly and ask user to send WhatsApp to Rafael.',
            };
          }
        },
      },
      onConnected: () => console.log('[rpc] connected', sessionId),
      onDisconnected: () => { handlers.delete(sessionId); console.log('[rpc] disconnected', sessionId); },
      onError: (e) => console.error('[rpc] err:', e),
    });
    handlers.set(sessionId, handler);

    res.json({
      sessionId,
      serverUrl: credentials.serverUrl || credentials.url || credentials.wsUrl,
      token: credentials.token || credentials.accessToken || credentials.participantToken,
      roomName: credentials.roomName,
    });
  } catch (e) {
    console.error('[session] fail:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

process.on('SIGTERM', async () => {
  for (const h of handlers.values()) { try { await h.close(); } catch {} }
  process.exit(0);
});

app.listen(PORT, () => console.log(`mika bot server listening :${PORT}`));
