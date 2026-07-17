const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { run, get, all, getDb } = require('../database');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

// The redirect URI must byte-match the one registered in the Google Cloud
// console. GOOGLE_REDIRECT_URI wins so the registered value can be pinned
// without depending on how BASE_URL happens to be spelled (trailing slash,
// http vs https, custom domain vs *.railway.app).
function getRedirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${base}/api/calendar/callback`;
}

function getOAuthClient() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

// POST /auth - Generate OAuth2 URL
router.post('/auth', authMiddleware, (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.json({ error: 'Google Calendar not configured' });
    }

    const oauth2Client = getOAuthClient();

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      // gmail.send lets the CRM email proposals as the signed-in agent. It is a
      // "restricted" scope, but this OAuth app is Internal to the Workspace org,
      // so it needs no Google verification. Anyone already connected before this
      // scope existed must reconnect once to grant it — /status reports that.
      // gmail.settings.basic is read-only here: it fetches the agent's real Gmail
      // signature so sent proposals look identical to mail they send by hand.
      // Gmail only appends signatures in its own UI, never to API-sent messages.
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.settings.basic'
      ],
      // Signed, short-lived state binds the callback to this user and prevents
      // an attacker from linking their Google account to someone else's record.
      state: jwt.sign({ uid: req.user.id, p: 'gcal' }, JWT_SECRET, { expiresIn: '10m' })
    });

    res.json({ authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /callback - OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!process.env.GOOGLE_CLIENT_ID || !code) {
      return res.status(400).send('Missing configuration or code');
    }

    // Validate the signed state and recover the user id from it (never trust a
    // raw user id in the callback query).
    let userId;
    try {
      const decoded = jwt.verify(state, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded.p !== 'gcal') throw new Error('unexpected state purpose');
      userId = decoded.uid;
    } catch (e) {
      return res.status(400).send('Invalid or expired OAuth state');
    }

    const oauth2Client = getOAuthClient();

    const { tokens } = await oauth2Client.getToken(code);

    // If Google sent a refresh_token, use it. Otherwise keep existing one.
    if (tokens.refresh_token) {
      run(`UPDATE users SET google_refresh_token=?, google_access_token=?, google_token_expiry=?, google_scopes=?, calendar_sync_enabled=1 WHERE id=?`,
        [tokens.refresh_token, tokens.access_token || '', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '', tokens.scope || '', userId]);
    } else {
      run(`UPDATE users SET google_access_token=?, google_token_expiry=?, google_scopes=?, calendar_sync_enabled=1 WHERE id=?`,
        [tokens.access_token || '', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '', tokens.scope || '', userId]);
    }

    // Redirect to frontend settings page. 5173 is the Vite dev server — the
    // frontend is never served from 3000.
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
    res.redirect(`${frontendUrl}/settings`);
  } catch (err) {
    res.status(500).send('OAuth callback error: ' + err.message);
  }
});

// POST /create-event - Create Google Calendar event
router.post('/create-event', authMiddleware, async (req, res) => {
  try {
    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || !user.google_refresh_token) {
      return res.status(400).json({ error: 'Google Calendar not connected' });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Google Calendar not configured' });
    }

    const { google } = require('googleapis');
    const oauth2Client = getOAuthClient();

    oauth2Client.setCredentials({
      refresh_token: user.google_refresh_token
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { summary, description, start, end, location, attendees } = req.body;

    const event = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody: {
        summary,
        description,
        location: location || '',
        start: { dateTime: start, timeZone: 'Asia/Jerusalem' },
        end: { dateTime: end, timeZone: 'Asia/Jerusalem' },
        attendees: (attendees || []).map(email => ({ email })),
      }
    });

    res.json({
      eventId: event.data.id,
      htmlLink: event.data.htmlLink
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /status - Calendar connection status
router.get('/status', authMiddleware, (req, res) => {
  try {
    const user = get('SELECT google_refresh_token, google_scopes, calendar_sync_enabled FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const connected = !!(user.google_refresh_token && user.google_refresh_token !== '');
    const scopes = user.google_scopes || '';
    res.json({
      connected,
      calendar_sync_enabled: !!(user.calendar_sync_enabled),
      // Reported separately because they fail differently: without gmail.send there
      // is no send at all, while without settings.basic the mail goes out fine and
      // merely loses its signature. Collapsing them would either block sends that
      // work or hide a silent degradation.
      gmail_enabled: connected && scopes.includes('gmail.send'),
      signature_enabled: connected && scopes.includes('gmail.settings.basic')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /disconnect - Disconnect Google Calendar
router.post('/disconnect', authMiddleware, (req, res) => {
  try {
    run(`
      UPDATE users SET
        google_refresh_token = '',
        google_access_token = '',
        google_token_expiry = '',
        calendar_sync_enabled = 0
      WHERE id = ?
    `, [req.user.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /generate-ics - Generate ICS file (fallback without Google)
router.post('/generate-ics', authMiddleware, (req, res) => {
  try {
    const { summary, description, start, end, location, attendees } = req.body;
    if (!summary || !start || !end) {
      return res.status(400).json({ error: 'summary, start, and end are required' });
    }

    const fmtDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@hausdorff-crm`;

    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Hausdorff CRM//Meeting//HE',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART:${fmtDate(start)}`,
      `DTEND:${fmtDate(end)}`,
      `SUMMARY:${(summary || '').replace(/\n/g, '\\n')}`,
      `DESCRIPTION:${(description || '').replace(/\n/g, '\\n')}`,
    ];

    if (location) ics.push(`LOCATION:${location.replace(/\n/g, '\\n')}`);
    if (attendees && attendees.length > 0) {
      attendees.forEach(email => {
        ics.push(`ATTENDEE;RSVP=TRUE:mailto:${email}`);
      });
    }
    ics.push(`ORGANIZER:mailto:${req.user.email || 'noreply@hausdorff.co.il'}`);
    ics.push('STATUS:CONFIRMED');
    ics.push('END:VEVENT');
    ics.push('END:VCALENDAR');

    const content = ics.join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${Date.now()}.ics"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
