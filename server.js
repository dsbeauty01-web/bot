import express from 'express';
import cors from 'cors';
import RunwayML from '@runwayml/sdk';
import { createRpcHandler } from '@runwayml/avatars-node-rpc';

const {
  RUNWAYML_API_SECRET,
  RUNWAY_AVATAR_ID,
  N8N_WEBHOOK_URL,
  ALLOWED_ORIGIN,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ RUNWAYML_API_SECRET, RUNWAY_AVATAR_ID, N8N_WEBHOOK_URL })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN || '*' }));

const runway = new RunwayML({ apiKey: RUNWAYML_API_SECRET });
const handlers = new Map();

app.get('/', (_req, res) => res.send('ok'));

app.post('/session', async (_req, res) => {
  try {
    // 1. Create session with tool declared
    const { id: sessionId } = await runway.realtimeSessions.create({
      model: 'gwm1_avatars',
      avatar: { type: 'custom', avatarId: RUNWAY_AVATAR_ID },
      tools: [{
        type: 'backend_rpc',
        name: 'ask_sales_assistant',
        description: 'Use for any question about prices, services, availability, scheduling, or when the user gives their name and phone to leave a lead. Pass the user message verbatim in Hebrew.',
        timeoutSeconds: 8,
        parameters: [
          { type: 'string', name: 'user_message', description: 'User message verbatim.' },
          { type: 'string', name: 'session_id', description: 'Conversation id for memory.' },
        ],
      }],
    });
    console.log('created session', sessionId);

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

    // 4. Start RPC handler (forwards tool calls to n8n)
    const handler = await createRpcHandler({
      apiKey: RUNWAYML_API_SECRET,
      sessionId,
      tools: {
        ask_sales_assistant: async (args) => {
          try {
            const r = await fetch(N8N_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: String(args.user_message || ''),
                sessionId: String(args.session_id || sessionId),
                source: 'runway-avatar',
              }),
              signal: AbortSignal.timeout(7500),
            });
            if (!r.ok) throw new Error(`n8n ${r.status}`);
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('json')) {
              const d = await r.json();
              return { answer: d.reply || d.output || d.text || d.message || JSON.stringify(d) };
            }
            return { answer: await r.text() };
          } catch (e) {
            console.error('n8n fail:', e.message);
            return { answer: 'מצטערת, יש קושי טכני רגעי. תוכל להשאיר שם וטלפון ונחזור אליך.' };
          }
        },
      },
      onConnected: () => console.log('rpc connected', sessionId),
      onDisconnected: () => handlers.delete(sessionId),
      onError: (e) => console.error('rpc err:', e),
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
    console.error('session fail:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

process.on('SIGTERM', async () => {
  for (const h of handlers.values()) { try { await h.close(); } catch {} }
  process.exit(0);
});

app.listen(PORT, () => console.log(`sales bot listening :${PORT}`));
