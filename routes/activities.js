const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, getDb } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// GET all activities
router.get('/', authMiddleware, (req, res) => {
  try {
    const { entity_type, entity_id, activity_type, search } = req.query;
    let query = `
      SELECT a.*, u.name as created_by_name
      FROM activities a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (entity_type) { query += ` AND a.entity_type = ?`; params.push(entity_type); }
    if (entity_id) { query += ` AND a.entity_id = ?`; params.push(entity_id); }
    if (activity_type) { query += ` AND a.activity_type = ?`; params.push(activity_type); }
    if (search) {
      query += ` AND (a.subject LIKE ? OR a.summary LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s);
    }
    query += ` ORDER BY a.created_at DESC`;

    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single activity
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const activity = get(`
      SELECT a.*, u.name as created_by_name
      FROM activities a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.id = ?
    `, [req.params.id]);
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create activity
router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const {
      entity_type, entity_id, activity_type, subject,
      summary, outcome, next_action, next_action_date, duration_minutes
    } = req.body;

    if (!entity_type || !entity_id || !activity_type || !subject) {
      return res.status(400).json({ error: 'entity_type, entity_id, activity_type, and subject are required' });
    }

    run(`
      INSERT INTO activities (id, entity_type, entity_id, activity_type, subject, summary, outcome, next_action, next_action_date, duration_minutes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, entity_type, entity_id, activity_type, subject,
      summary || '', outcome || '', next_action || '',
      next_action_date || null, duration_minutes || 0,
      req.user.id
    ]);

    // Auto-create task if next_action_date is provided
    if (next_action_date && next_action) {
      const taskId = uuidv4();
      const contactId2 = entity_type === 'contact' ? entity_id : null;
      const dealId2 = entity_type === 'deal' ? entity_id : null;
      run(`
        INSERT INTO tasks (id, title, description, deal_id, contact_id, assigned_to, assigned_to_id, due_date, completed, priority, type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'חשוב (לא דחוף)', 'follow_up', datetime('now'), datetime('now'))
      `, [taskId, next_action, `המשך טיפול מפעילות: ${subject}`, dealId2, contactId2, req.user.name, req.user.id, next_action_date]);
    }

    // Insert into timeline for backwards compatibility
    const contactId = entity_type === 'contact' ? entity_id : null;
    const dealId = entity_type === 'deal' ? entity_id : null;
    const timelineId = uuidv4();
    run(`
      INSERT INTO timeline (id, deal_id, contact_id, type, title, description, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [timelineId, dealId, contactId, activity_type, subject, summary || '', req.user.name]);

    const activity = get('SELECT * FROM activities WHERE id = ?', [id]);
    res.status(201).json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update activity
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const activity = get('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!activity) return res.status(404).json({ error: 'Activity not found' });

    const { activity_type, subject, summary, outcome,
            next_action, next_action_date, duration_minutes } = req.body;

    run(`UPDATE activities SET
      activity_type=?, subject=?, summary=?, outcome=?,
      next_action=?, next_action_date=?, duration_minutes=?
      WHERE id=?`,
      [activity_type || activity.activity_type,
       subject || activity.subject,
       summary !== undefined ? summary : activity.summary,
       outcome !== undefined ? outcome : activity.outcome,
       next_action !== undefined ? next_action : activity.next_action,
       next_action_date !== undefined ? next_action_date : activity.next_action_date,
       duration_minutes !== undefined ? duration_minutes : activity.duration_minutes,
       req.params.id]);

    const updated = get(`
      SELECT a.*, u.name as created_by_name
      FROM activities a LEFT JOIN users u ON a.created_by = u.id
      WHERE a.id = ?
    `, [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE activity
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const activity = get('SELECT * FROM activities WHERE id = ?', [req.params.id]);
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    run('DELETE FROM activities WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
