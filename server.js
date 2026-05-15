// ============================================================
//  Mika Bot Server — refael-ai-flow
//  Runs on Render at https://bot-vibk.onrender.com
//
//  One brain (Mika via Runway), one tool (save_lead -> dumb n8n webhook -> Gmail).
//  No more AI agent in n8n. No more Pinecone in the live path.
// ============================================================

import express from 'express';
import cors from 'cors';
import RunwayML from '@runwayml/sdk';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const {
  RUNWAYML_API_SECRET,
  RUNWAY_AVATAR_ID,
  N8N_LEAD_WEBHOOK,     // NEW: dumb webhook -> Gmail. e.g. https://rafa5555.app.n8n.cloud/webhook/lead-email
  N8N_WEBHOOK_URL,      // OLD: still read for backward-compat (used as fallback only)
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
//  Mika personality — single source of truth.
//  Sent on every session create, overrides the portal default.
// ============================================================
const MIKA_PERSONALITY = `את מיקה, העוזרת של רפאל סילניקובה — בונה בוטים ואבטרים מדברים לעסקים קטנים בישראל.

שפה: זיהוי אוטומטי. עברית מקבל עברית. אנגלית מקבל אנגלית. לעולם לא לערבב באותה תשובה.

סגנון: 1 עד 3 משפטים קצרים. טון ישראלי ישיר. בלי אימוג'ים. בלי ז'רגון טכני. ענייניית, חברותית, לא דוחפת.

מה רפאל עושה:
- בוטי הזמנת תורים
- בוטי מכירה (קטלוג, המלצות, FAQ)
- אבטרים מדברים (כמוני)
- אוטומציות מותאמות, אינטגרציות וואטסאפ/CRM/אימייל

תמחור — חשוב:
- הקמה: מ-600 שקלים, חד פעמי בלבד.
- אין דמי מנוי חודשיים. בכלל. אף פעם.
- אספקה: 3 עד 7 ימים.
- ייעוץ ראשוני 15 דקות חינם.
- בוט פשוט: 600 ש"ח. בוט חנות עם וואטסאפ: 1500-2500. אבטר כמוני: 2500-4000. הכל גמיש לפי scope.

תפקיד שלך:
1. ברכי, שאלי איזה עסק יש למשתמש.
2. עני על שאלות מהידע שלך.
3. כשהמשתמש מתעניין, אספי: שם → טלפון או אימייל → סוג עסק.
4. ברגע שיש לך שלושת הפרטים, קראי לטול save_lead פעם אחת.
5. אחרי שהטול הצליח: "תודה, רפאל יחזור אלייך תוך שעתיים."

חוקים:
- אל תמציאי מחירים או פיצ'רים.
- אל תזכירי מנוי חודשי — אין כזה.
- אל תקראי לטול save_lead יותר מפעם אחת באותה שיחה.
- אל תבקשי מידע שהמשתמש כבר נתן.
- אם שאלה טכנית עמוקה שאת לא בטוחה — "רפאל יענה לך על זה ישירות, אפשר להשאיר פרטים?"`;

const MIKA_START_SCRIPT = 'היי, אני מיקה — איזה עסק יש לך?';

// ============================================================
//  Routes
// ============================================================
app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/session', async (req, res) => {
  try {
    const clientSessionId = req.body?.sessionId || null;

    // 1. Create session with the save_lead tool + Mika personality override
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

    // 2. Poll until READY
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

    // 3. Consume to get LiveKit credentials
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

    // 4. Start RPC handler — forwards save_lead -> dumb n8n webhook -> Gmail
    const leadFired = new Set(); // dedupe within this session
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

          // Dedupe: if Mika tries to fire it twice in one session, no-op the second.
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
            leadFired.delete(key); // allow retry
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

    // 5. Return credentials to browser
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
