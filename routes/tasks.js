const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

// Helper: enrich tasks with participants
function attachParticipants(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map(t => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const participants = all(
    `SELECT tp.task_id, tp.user_id, tp.role, u.name as user_name
     FROM task_participants tp
     JOIN users u ON tp.user_id = u.id
     WHERE tp.task_id IN (${placeholders})`,
    ids
  );
  const map = {};
  for (const p of participants) {
    if (!map[p.task_id]) map[p.task_id] = [];
    map[p.task_id].push({ user_id: p.user_id, user_name: p.user_name, role: p.role });
  }
  return tasks.map(t => ({ ...t, participants: map[t.id] || [] }));
}

// Helper: sync participants for a task
function syncParticipants(taskId, ownerId, participantIds) {
  // Remove existing participants (not owner)
  run(`DELETE FROM task_participants WHERE task_id = ? AND role = 'participant'`, [taskId]);
  // Ensure owner row exists
  const existingOwner = get(`SELECT id FROM task_participants WHERE task_id = ? AND role = 'owner'`, [taskId]);
  if (!existingOwner && ownerId) {
    run(`INSERT OR IGNORE INTO task_participants (id, task_id, user_id, role) VALUES (?, ?, ?, 'owner')`,
      [uuidv4(), taskId, ownerId]);
  } else if (existingOwner && ownerId) {
    run(`UPDATE task_participants SET user_id = ? WHERE task_id = ? AND role = 'owner'`, [ownerId, taskId]);
  }
  // Insert new participants
  if (participantIds && participantIds.length) {
    for (const uid of participantIds) {
      if (uid !== ownerId) {
        run(`INSERT OR IGNORE INTO task_participants (id, task_id, user_id, role) VALUES (?, ?, ?, 'participant')`,
          [uuidv4(), taskId, uid]);
      }
    }
  }
}

const ENRICHED_SELECT = `
  SELECT t.*,
    d.title as deal_title,
    c.first_name || ' ' || c.last_name as contact_name,
    p.address || ', ' || p.city as property_name,
    comp.name as company_name,
    u_owner.name as owner_name
  FROM tasks t
  LEFT JOIN deals d ON t.deal_id = d.id
  LEFT JOIN contacts c ON t.contact_id = c.id
  LEFT JOIN properties p ON t.property_id = p.id
  LEFT JOIN companies comp ON t.company_id = comp.id
  LEFT JOIN users u_owner ON t.assigned_to_id = u_owner.id
`;

router.get('/', authMiddleware, (req, res) => {
  try {
    const { assigned_to, completed, priority, deal_id, contact_id, property_id, company_id,
            overdue, due_today, week_start, week_end, user_id, show_all } = req.query;
    let query = ENRICHED_SELECT + ' WHERE 1=1';
    const params = [];

    // User-scoped filtering: show only user's own + shared tasks
    if (user_id && show_all !== 'true') {
      query += ` AND (t.assigned_to_id = ? OR t.id IN (
        SELECT tp.task_id FROM task_participants tp WHERE tp.user_id = ?
      ))`;
      params.push(user_id, user_id);
    }

    // Legacy name-based filter (backward compat)
    if (assigned_to) { query += ' AND t.assigned_to = ?'; params.push(assigned_to); }
    if (completed !== undefined) { query += ' AND t.completed = ?'; params.push(parseInt(completed)); }
    if (priority) { query += ' AND t.priority = ?'; params.push(priority); }
    if (deal_id) { query += ' AND t.deal_id = ?'; params.push(deal_id); }
    if (contact_id) { query += ' AND t.contact_id = ?'; params.push(contact_id); }
    if (property_id) { query += ' AND t.property_id = ?'; params.push(property_id); }
    if (company_id) { query += ' AND t.company_id = ?'; params.push(company_id); }
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
    const tasks = all(query, params);
    res.json(attachParticipants(tasks));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const task = get(ENRICHED_SELECT + ' WHERE t.id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const enriched = attachParticipants([task]);
    res.json(enriched[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { title, description, deal_id, contact_id, property_id, company_id,
            assigned_to, assigned_to_id, due_date, task_time, priority, type,
            completion_notes, participants } = req.body;
    const now = new Date().toISOString();
    const ownerId = assigned_to_id || req.user.id;

    // Resolve owner name
    let ownerName = assigned_to || 'מנהל';
    if (assigned_to_id) {
      const ownerUser = get('SELECT name FROM users WHERE id = ?', [assigned_to_id]);
      if (ownerUser) ownerName = ownerUser.name;
    }

    run(`INSERT INTO tasks (id,title,description,deal_id,contact_id,property_id,company_id,assigned_to,assigned_to_id,due_date,task_time,priority,type,completion_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, title, description||'', deal_id||null, contact_id||null, property_id||null, company_id||null,
       ownerName, ownerId, due_date||null, task_time||'', priority||'בינוני', type||'משימה',
       completion_notes||'', now, now]);

    // Create participant records
    syncParticipants(id, ownerId, participants || []);

    const task = get(ENRICHED_SELECT + ' WHERE t.id = ?', [id]);
    const enriched = attachParticipants([task]);
    res.status(201).json(enriched[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { title, description, deal_id, contact_id, property_id, company_id,
            assigned_to, assigned_to_id, due_date, task_time, completed, priority, type,
            postponed_reason, completion_notes, postpone_count, participants } = req.body;
    const now = new Date().toISOString();
    const ownerId = assigned_to_id || null;

    // Resolve owner name
    let ownerName = assigned_to || 'מנהל';
    if (assigned_to_id) {
      const ownerUser = get('SELECT name FROM users WHERE id = ?', [assigned_to_id]);
      if (ownerUser) ownerName = ownerUser.name;
    }

    run(`UPDATE tasks SET title=?,description=?,deal_id=?,contact_id=?,property_id=?,company_id=?,assigned_to=?,assigned_to_id=?,due_date=?,task_time=?,completed=?,priority=?,type=?,postponed_reason=?,completion_notes=?,postpone_count=?,updated_at=? WHERE id=?`,
      [title, description||'', deal_id||null, contact_id||null, property_id||null, company_id||null,
       ownerName, ownerId, due_date||null, task_time||'', completed?1:0, priority||'בינוני', type||'משימה',
       postponed_reason||'', completion_notes||'', postpone_count||0, now, req.params.id]);

    // Update participants if provided
    if (participants !== undefined) {
      syncParticipants(req.params.id, ownerId, participants);
    }

    const task = get(ENRICHED_SELECT + ' WHERE t.id = ?', [req.params.id]);
    const enriched = attachParticipants([task]);
    res.json(enriched[0]);
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
    const updated = get(ENRICHED_SELECT + ' WHERE t.id = ?', [req.params.id]);
    const enriched = attachParticipants([updated]);
    res.json(enriched[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM task_participants WHERE task_id = ?', [req.params.id]);
    run('DELETE FROM tasks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
