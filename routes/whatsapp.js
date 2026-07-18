// WhatsApp Cloud API webhook + admin endpoints
//
// Stage 1: webhook verification + inbound message handling + echo reply
// Stage 2 (later): voice → Whisper → Claude → structured actions
// Stage 3 (later): outgoing notifications via node-cron + Message Templates
//
// PUBLIC routes (no authMiddleware):
//   GET  /api/whatsapp/webhook  — Meta verification challenge
//   POST /api/whatsapp/webhook  — inbound messages from Meta
//
// PROTECTED routes (require JWT):
//   GET  /api/whatsapp/logs     — recent in/out log entries for debug

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { safeError } = require('../utils/errors');
const { sendWhatsAppMessage } = require('../services/whatsapp');

// ── GET /api/whatsapp/webhook  ─────────────────────────────────────────────
// Meta hits this once when you save the webhook URL in the dashboard, to
// confirm we control the endpoint. Reply with the supplied `hub.challenge`.
router.get('/webhook', (req, res) => {
  try {
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'crm-wa-token';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[WhatsApp] Webhook verified successfully');
      return res.status(200).send(challenge);
    }
    console.warn('[WhatsApp] Webhook verification failed (token mismatch)');
    return res.status(403).json({ error: 'Verification failed' });
  } catch (err) {
    console.error('[WhatsApp] Verify error:', err.message);
    return res.status(500).json({ error: safeError(err) });
  }
});

// ── POST /api/whatsapp/webhook  ────────────────────────────────────────────
// Inbound messages. Meta retries aggressively if we don't ack within ~5s, so
// we send 200 immediately and process asynchronously.
router.post('/webhook', (req, res) => {
  // ACK first, process after
  res.status(200).send('OK');

  // Fire-and-forget — errors are logged but never propagate
  setImmediate(() => processInbound(req.body).catch(err => {
    console.error('[WhatsApp] processInbound error:', err);
  }));
});

// ── Inbound processing  ────────────────────────────────────────────────────
async function processInbound(body) {
  // Meta payload shape:
  // { object: "whatsapp_business_account",
  //   entry: [ { id, changes: [ { field, value: {
  //     messaging_product, metadata, contacts, messages, statuses
  //   } } ] } ] }
  const change = body?.entry?.[0]?.changes?.[0]?.value;
  if (!change) return;

  // Delivery/read receipts — log but don't process as messages
  if (change.statuses && change.statuses.length > 0) {
    return; // future: update outbound log row's status from 'sent' → 'delivered'/'read'
  }

  const msg = change.messages?.[0];
  if (!msg) return;

  const wa_phone = msg.from;
  const wa_message_id = msg.id;
  const message_type = msg.type;

  // Dedup: Meta may retry the same delivery
  const existing = get(`SELECT id FROM whatsapp_logs WHERE wa_message_id = ?`,
    [wa_message_id]);
  if (existing) {
    console.log('[WhatsApp] Dedup hit for message', wa_message_id);
    return;
  }

  // Resolve which CRM user owns this conversation.
  // Stage 1: hardcoded to RAFI_USER_ID (single-user MVP).
  // Stage 2: look up users.whatsapp_phone for multi-user.
  let user_id = process.env.RAFI_USER_ID || null;
  if (!user_id) {
    // Fallback: try to match by users.whatsapp_phone
    const u = get(`SELECT id FROM users WHERE whatsapp_phone = ? AND whatsapp_enabled = 1
                   LIMIT 1`, [wa_phone]);
    if (u) user_id = u.id;
  }

  // Extract text/media content
  let text_content = '';
  let media_url = '';
  if (message_type === 'text') {
    text_content = msg.text?.body || '';
  } else if (message_type === 'audio') {
    text_content = '[voice memo — transcription pending]';
    media_url = msg.audio?.id || ''; // store media_id; downloaded later in stage 2
  } else if (message_type === 'image') {
    text_content = msg.image?.caption || '[image]';
    media_url = msg.image?.id || '';
  } else if (message_type === 'document') {
    text_content = msg.document?.filename || '[document]';
    media_url = msg.document?.id || '';
  } else {
    text_content = `[${message_type}]`;
  }

  // Log inbound
  const logId = uuidv4();
  run(`INSERT INTO whatsapp_logs (id, direction, user_id, wa_phone, wa_message_id,
       message_type, text_content, media_url, status, raw_payload, created_at)
       VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, 'received', ?, datetime('now'))`,
    [logId, user_id, wa_phone, wa_message_id, message_type, text_content,
     media_url, JSON.stringify(body)]);

  console.log(`[WhatsApp] Inbound ${message_type} from ${wa_phone}: ${text_content.slice(0, 80)}`);

  // Stage 1 behavior: echo back so we can verify the round-trip works.
  // Stage 2 will replace this with LLM-driven action extraction.
  const reply = buildEchoReply(message_type, text_content);
  try {
    await sendWhatsAppMessage(wa_phone, reply, { userId: user_id });
    // Mark inbound as processed
    run(`UPDATE whatsapp_logs SET status = 'processed' WHERE id = ?`, [logId]);
  } catch (err) {
    console.error('[WhatsApp] Echo send failed:', err.message);
    run(`UPDATE whatsapp_logs SET status = 'failed', error_message = ? WHERE id = ?`,
      [err.message, logId]);
  }
}

function buildEchoReply(message_type, text_content) {
  if (message_type === 'text') {
    return `✅ קיבלתי: "${text_content}"\n\n(שלב 1 — echo. בשלב 2 הבוט יבין הודעות קוליות ויעדכן את ה-CRM אוטומטית.)`;
  }
  if (message_type === 'audio') {
    return `🎤 קיבלתי הודעה קולית.\n\n(שלב 1 — הקובץ נשמר. בשלב 2 הוא יתומלל ל-Whisper ויעובד אוטומטית.)`;
  }
  return `📥 קיבלתי הודעה מסוג ${message_type}. בשלב 1 רק טקסט ואודיו נתמכים.`;
}

// ── GET /api/whatsapp/logs  ────────────────────────────────────────────────
// Debug endpoint: last 50 messages in/out. Useful for verifying setup.
router.get('/logs', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = all(
      `SELECT id, direction, user_id, wa_phone, wa_message_id, message_type,
              text_content, status, error_message, created_at
       FROM whatsapp_logs
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
