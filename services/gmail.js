// Reading a contact's correspondence to file it on their card.
//
// The fiddly part is turning a Gmail message into a flat row: headers live in a
// list, the plaintext body is base64url-encoded somewhere in a nested part tree,
// and direction depends on whether the agent is the sender. parseMessage is kept
// pure and side-effect-free so it can be tested without touching Gmail.

const { google } = require('googleapis');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ||
      `${(process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '')}/api/calendar/callback`
  );
}

function gmailClient(refreshToken) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function header(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Pull just the address out of a "Name <addr@x>" header value.
function bareAddress(value) {
  const m = String(value || '').match(/<([^>]+)>/);
  return (m ? m[1] : value || '').trim().toLowerCase();
}

function decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Walk the MIME tree for the first text/plain part; fall back to stripping tags
// off text/html if that's all there is.
function extractPlainBody(payload) {
  if (!payload) return '';
  const visit = (part, preferHtml) => {
    if (!part) return '';
    const mt = part.mimeType || '';
    if (mt === 'text/plain' && part.body && part.body.data) return decodeB64Url(part.body.data);
    if (preferHtml && mt === 'text/html' && part.body && part.body.data) {
      return decodeB64Url(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    for (const sub of part.parts || []) {
      const found = visit(sub, preferHtml);
      if (found) return found;
    }
    return '';
  };
  return visit(payload, false) || visit(payload, true) || '';
}

// gmailMessage: the object returned by users.messages.get(format:'full').
// userEmail: the signed-in agent's own address, to decide direction.
function parseMessage(gmailMessage, userEmail) {
  const headers = gmailMessage.payload ? gmailMessage.payload.headers : [];
  const from = header(headers, 'From');
  const to = header(headers, 'To');
  const fromAddr = bareAddress(from);
  const sentAt = gmailMessage.internalDate
    ? new Date(Number(gmailMessage.internalDate)).toISOString()
    : '';
  return {
    gmail_id: gmailMessage.id,
    thread_id: gmailMessage.threadId || '',
    direction: fromAddr === String(userEmail || '').toLowerCase() ? 'out' : 'in',
    from_addr: fromAddr,
    to_addr: bareAddress(to),
    subject: header(headers, 'Subject'),
    snippet: gmailMessage.snippet || '',
    body_text: extractPlainBody(gmailMessage.payload),
    sent_at: sentAt,
  };
}

// Fetch and parse all correspondence with `contactEmail`. Caps at `max` newest
// so a long-standing address can't pull an unbounded slice of the mailbox in one
// sync — the log surfaces when the cap is hit.
async function fetchCorrespondence({ refreshToken, contactEmail, userEmail, max = 50 }) {
  const gmail = gmailClient(refreshToken);
  const q = `from:${contactEmail} OR to:${contactEmail}`;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: max });
  const ids = (list.data.messages || []).map(m => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    out.push(parseMessage(msg.data, userEmail));
  }
  return { messages: out, capped: !!list.data.nextPageToken };
}

module.exports = { parseMessage, extractPlainBody, bareAddress, fetchCorrespondence };
