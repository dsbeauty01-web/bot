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
    const session = await runway.realtimeSessions.create({
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

    const handler = await createRpcHandler({
      apiKey: RUNWAYML_API_SECRET,
      sessionId: session.id,
      tools: {
        ask_sales_assistant: async (args) => {
          try {
            const r = await fetch(N8N_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: String(args.user_message || ''),
                sessionId: String(args.session_id || session.id),
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
      onConnected: () => console.log('rpc connected', session.id),
      onDisconnected: () => handlers.delete(session.id),
      onError: (e) => console.error('rpc err:', e),
    });

    handlers.set(session.id, handler);
    res.json(session);
  } catch (e) {
    console.error('session fail:', e);
    res.status(500).json({ error: e.message });
  }
});

process.on('SIGTERM', async () => {
  for (const h of handlers.values()) { try { await h.close(); } catch {} }
  process.exit(0);
});

app.listen(PORT, () => console.log(`listening :${PORT}`));
