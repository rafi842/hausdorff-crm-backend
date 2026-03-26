const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

// GET all meetings (with filters)
router.get('/', authMiddleware, (req, res) => {
  try {
    const { contact_id, deal_id, start, end, status } = req.query;
    let query = `
      SELECT m.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone
      FROM meetings m
      LEFT JOIN contacts c ON m.contact_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (contact_id) { query += ' AND m.contact_id = ?'; params.push(contact_id); }
    if (deal_id) { query += ' AND m.deal_id = ?'; params.push(deal_id); }
    if (start) { query += ' AND m.start_datetime >= ?'; params.push(start); }
    if (end) { query += ' AND m.end_datetime <= ?'; params.push(end); }
    if (status) { query += ' AND m.status = ?'; params.push(status); }
    query += ' ORDER BY m.start_datetime ASC';

    const meetings = all(query, params);

    // Attach attendees to each meeting
    meetings.forEach(m => {
      m.attendees = all('SELECT * FROM meeting_attendees WHERE meeting_id = ?', [m.id]);
    });

    res.json(meetings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single meeting
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const meeting = get(`
      SELECT m.*,
        c.first_name || ' ' || c.last_name as contact_name
      FROM meetings m
      LEFT JOIN contacts c ON m.contact_id = c.id
      WHERE m.id = ?
    `, [req.params.id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    meeting.attendees = all('SELECT * FROM meeting_attendees WHERE meeting_id = ?', [meeting.id]);
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create meeting
router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const {
      title, description, start_datetime, end_datetime,
      location, contact_id, deal_id,
      google_event_id, google_event_link,
      attendees
    } = req.body;

    if (!title || !start_datetime || !end_datetime) {
      return res.status(400).json({ error: 'title, start_datetime, and end_datetime are required' });
    }

    run(`INSERT INTO meetings (id, title, description, start_datetime, end_datetime, location, contact_id, deal_id, google_event_id, google_event_link, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      [id, title, description || '', start_datetime, end_datetime, location || '',
       contact_id || null, deal_id || null,
       google_event_id || '', google_event_link || '',
       req.user.id]);

    // Save attendees
    if (attendees && attendees.length > 0) {
      attendees.forEach(att => {
        const attId = uuidv4();
        run(`INSERT INTO meeting_attendees (id, meeting_id, email, name, type)
          VALUES (?, ?, ?, ?, ?)`,
          [attId, id, att.email, att.name || '', att.type || 'client']);
      });
    }

    const meeting = get('SELECT * FROM meetings WHERE id = ?', [id]);
    meeting.attendees = all('SELECT * FROM meeting_attendees WHERE meeting_id = ?', [id]);
    res.status(201).json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update meeting
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const existing = get('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Meeting not found' });

    const { title, description, start_datetime, end_datetime, location, status } = req.body;
    run(`UPDATE meetings SET title=?, description=?, start_datetime=?, end_datetime=?, location=?, status=? WHERE id=?`,
      [title || existing.title, description !== undefined ? description : existing.description,
       start_datetime || existing.start_datetime, end_datetime || existing.end_datetime,
       location !== undefined ? location : existing.location,
       status || existing.status, req.params.id]);

    const meeting = get('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
    meeting.attendees = all('SELECT * FROM meeting_attendees WHERE meeting_id = ?', [req.params.id]);
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE meeting
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const existing = get('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Meeting not found' });
    run('DELETE FROM meeting_attendees WHERE meeting_id = ?', [req.params.id]);
    run('DELETE FROM meetings WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
