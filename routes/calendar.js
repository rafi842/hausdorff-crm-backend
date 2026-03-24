const express = require('express');
const router = express.Router();
const { run, get, all, getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

// POST /auth - Generate OAuth2 URL
router.post('/auth', authMiddleware, (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId) {
      return res.json({ error: 'Google Calendar not configured' });
    }

    const { google } = require('googleapis');
    const redirectUri = `${process.env.BASE_URL || 'http://localhost:3001'}/api/calendar/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      state: req.user.id
    });

    res.json({ authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /callback - OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code, state: userId } = req.query;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !code) {
      return res.status(400).send('Missing configuration or code');
    }

    const { google } = require('googleapis');
    const redirectUri = `${process.env.BASE_URL || 'http://localhost:3001'}/api/calendar/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const { tokens } = await oauth2Client.getToken(code);

    run(`
      UPDATE users SET
        google_refresh_token = ?,
        google_access_token = ?,
        google_token_expiry = ?,
        calendar_sync_enabled = 1
      WHERE id = ?
    `, [
      tokens.refresh_token || '',
      tokens.access_token || '',
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
      userId
    ]);

    // Redirect to frontend settings page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
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

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId) {
      return res.status(400).json({ error: 'Google Calendar not configured' });
    }

    const { google } = require('googleapis');
    const redirectUri = `${process.env.BASE_URL || 'http://localhost:3001'}/api/calendar/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    oauth2Client.setCredentials({
      refresh_token: user.google_refresh_token
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { summary, description, start, end } = req.body;

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: start },
        end: { dateTime: end }
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
    const user = get('SELECT google_refresh_token, calendar_sync_enabled FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      connected: !!(user.google_refresh_token && user.google_refresh_token !== ''),
      calendar_sync_enabled: !!(user.calendar_sync_enabled)
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

module.exports = router;
