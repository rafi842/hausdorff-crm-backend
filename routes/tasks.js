const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { assigned_to, completed, priority, deal_id, contact_id, overdue, due_today, week_start, week_end } = req.query;
    let query = `
      SELECT t.*,
        d.title as deal_title,
        c.first_name || ' ' || c.last_name as contact_name
      FROM tasks t
      LEFT JOIN deals d ON t.deal_id = d.id
      LEFT JOIN contacts c ON t.contact_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (assigned_to) { query += ' AND t.assigned_to = ?'; params.push(assigned_to); }
    if (completed !== undefined) { query += ' AND t.completed = ?'; params.push(parseInt(completed)); }
    if (priority) { query += ' AND t.priority = ?'; params.push(priority); }
    if (deal_id) { query += ' AND t.deal_id = ?'; params.push(deal_id); }
    if (contact_id) { query += ' AND t.contact_id = ?'; params.push(contact_id); }
    if (overdue === 'true') {
      const today = new Date().toISOString().split('T')[0];
      query += ` AND t.due_date < '${today}' AND t.completed = 0`;
    }
    if (due_today === 'true') {
      const today = new Date().toISOString().split('T')[0];
      query += ` AND t.due_date = '${today}' AND t.completed = 0`;
    }
    if (week_start && week_end) {
      query += ` AND t.due_date >= ? AND t.due_date <= ?`;
      params.push(week_start, week_end);
    }
    query += ' ORDER BY t.due_date ASC, t.task_time ASC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const task = get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { title, description, deal_id, contact_id, assigned_to, due_date, task_time, priority, type, completion_notes } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO tasks (id,title,description,deal_id,contact_id,assigned_to,due_date,task_time,priority,type,completion_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, title, description||'', deal_id||null, contact_id||null, assigned_to||'מנהל',
       due_date||null, task_time||'', priority||'בינוני', type||'משימה', completion_notes||'', now, now]);
    const task = get(`SELECT t.*, d.title as deal_title, c.first_name || ' ' || c.last_name as contact_name FROM tasks t LEFT JOIN deals d ON t.deal_id = d.id LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.id = ?`, [id]);
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { title, description, deal_id, contact_id, assigned_to, due_date, task_time, completed, priority, type, postponed_reason, completion_notes, postpone_count } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE tasks SET title=?,description=?,deal_id=?,contact_id=?,assigned_to=?,due_date=?,task_time=?,completed=?,priority=?,type=?,postponed_reason=?,completion_notes=?,postpone_count=?,updated_at=? WHERE id=?`,
      [title, description||'', deal_id||null, contact_id||null, assigned_to||'מנהל',
       due_date||null, task_time||'', completed?1:0, priority||'בינוני', type||'משימה',
       postponed_reason||'', completion_notes||'', postpone_count||0, now, req.params.id]);
    const task = get(`SELECT t.*, d.title as deal_title, c.first_name || ' ' || c.last_name as contact_name FROM tasks t LEFT JOIN deals d ON t.deal_id = d.id LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.id = ?`, [req.params.id]);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/complete', authMiddleware, (req, res) => {
  try {
    const task = get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const newCompleted = task.completed ? 0 : 1;
    const now = new Date().toISOString();
    run(`UPDATE tasks SET completed=?,updated_at=? WHERE id=?`, [newCompleted, now, req.params.id]);
    res.json(get('SELECT * FROM tasks WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM tasks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
