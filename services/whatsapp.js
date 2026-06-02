// WhatsApp Cloud API helpers — outbound messaging, media download, logging
// Mirrors the env-var + logging pattern from routes/leads.js (Facebook webhook).
//
// All outbound goes through sendWhatsAppMessage() which logs to whatsapp_logs
// so that we have a complete audit trail of every message in and out.

const { v4: uuidv4 } = require('uuid');
const { run, get } = require('../database');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getConfig() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set');
  }
  return { phoneNumberId, accessToken };
}

// Normalize phone for WhatsApp: must be E.164 without leading '+', e.g. "972501234567"
function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d]/g, '');
}

/**
 * Send a free-form text message via WhatsApp Cloud API.
 * Only valid inside an active 24h conversation window (i.e. after the user
 * sent us something). For proactive outbound, use sendWhatsAppTemplate.
 *
 * @param {string} to            recipient phone (any format; will be normalized)
 * @param {string} text          message body (Hebrew OK, up to 4096 chars)
 * @param {object} [opts]
 * @param {string} [opts.userId] user_id to attach to the log row
 * @returns {Promise<{wa_message_id: string, log_id: string}>}
 */
async function sendWhatsAppMessage(to, text, opts = {}) {
  const { phoneNumberId, accessToken } = getConfig();
  const phone = normalizePhone(to);
  const logId = uuidv4();

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: false, body: String(text || '').slice(0, 4096) },
  };

  let waMessageId = '';
  let status = 'sent';
  let errorMessage = '';

  try {
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = 'failed';
      errorMessage = `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`;
    } else {
      waMessageId = body?.messages?.[0]?.id || '';
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err.message || String(err);
  }

  run(`INSERT INTO whatsapp_logs (id, direction, user_id, wa_phone, wa_message_id,
       message_type, text_content, status, error_message, raw_payload, created_at)
       VALUES (?, 'outbound', ?, ?, ?, 'text', ?, ?, ?, ?, datetime('now'))`,
    [logId, opts.userId || null, phone, waMessageId, text, status, errorMessage,
     JSON.stringify(payload)]);

  return { wa_message_id: waMessageId, log_id: logId, status };
}

/**
 * Download a media file (voice memo, image, document) referenced in an
 * inbound WhatsApp message. Two-step process: resolve URL, then GET bytes.
 *
 * @param {string} mediaId  the `id` field from msg.audio / msg.image / etc.
 * @returns {Promise<{buffer: Buffer, mime_type: string}>}
 */
async function downloadWhatsAppMedia(mediaId) {
  const { accessToken } = getConfig();

  // Step 1: get a short-lived signed URL for this media
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Failed to resolve media ${mediaId}: HTTP ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error(`Media ${mediaId} has no url in response`);

  // Step 2: download the bytes (still requires bearer token)
  const binRes = await fetch(meta.url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!binRes.ok) {
    throw new Error(`Failed to download media ${mediaId}: HTTP ${binRes.status}`);
  }
  const arrayBuffer = await binRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mime_type: meta.mime_type || binRes.headers.get('content-type') || 'application/octet-stream',
  };
}

/**
 * Send an approved Message Template (used for proactive outbound outside the
 * 24h window — e.g. daily briefing, task reminders).
 *
 * Template must be approved in Meta Business Manager beforehand.
 *
 * @param {string} to                  recipient phone
 * @param {string} templateName        e.g. 'daily_briefing_v1'
 * @param {string} languageCode        e.g. 'he' or 'en'
 * @param {Array<string>} [bodyParams] positional substitutions for {{1}}, {{2}}, ...
 * @param {object} [opts]
 * @param {string} [opts.userId]
 */
async function sendWhatsAppTemplate(to, templateName, languageCode, bodyParams = [], opts = {}) {
  const { phoneNumberId, accessToken } = getConfig();
  const phone = normalizePhone(to);
  const logId = uuidv4();

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0 && {
        components: [{
          type: 'body',
          parameters: bodyParams.map(p => ({ type: 'text', text: String(p) })),
        }],
      }),
    },
  };

  let waMessageId = '';
  let status = 'sent';
  let errorMessage = '';

  try {
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = 'failed';
      errorMessage = `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`;
    } else {
      waMessageId = body?.messages?.[0]?.id || '';
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err.message || String(err);
  }

  run(`INSERT INTO whatsapp_logs (id, direction, user_id, wa_phone, wa_message_id,
       message_type, text_content, status, error_message, raw_payload, created_at)
       VALUES (?, 'outbound', ?, ?, ?, 'template', ?, ?, ?, ?, datetime('now'))`,
    [logId, opts.userId || null, phone, waMessageId,
     `[template:${templateName}] ${bodyParams.join(' | ')}`, status, errorMessage,
     JSON.stringify(payload)]);

  return { wa_message_id: waMessageId, log_id: logId, status };
}

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  downloadWhatsAppMedia,
  normalizePhone,
};
