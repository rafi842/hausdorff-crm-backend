const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, getDb } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

// GET goal progress for a user
router.get('/progress', authMiddleware, (req, res) => {
  try {
    const { user_id, year, month } = req.query;
    const targetUserId = user_id || req.user.id;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || (new Date().getMonth() + 1);

    const goal = get(`
      SELECT * FROM agent_goals
      WHERE user_id = ? AND year = ? AND month = ?
    `, [targetUserId, targetYear, targetMonth]);

    // Date range for the month
    const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const endMonth = targetMonth === 12 ? 1 : targetMonth + 1;
    const endYear = targetMonth === 12 ? targetYear + 1 : targetYear;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    // Actual commission: SUM deals.commission_value WHERE stage >= 7 in period
    const commRow = get(`
      SELECT COALESCE(SUM(commission_value), 0) as total
      FROM deals WHERE stage >= 7
      AND actual_close_date >= ? AND actual_close_date < ?
    `, [startDate, endDate]);

    // Actual calls: COUNT activities WHERE activity_type='call' in period
    const callsRow = get(`
      SELECT COUNT(*) as total
      FROM activities WHERE activity_type = 'call'
      AND created_by = ?
      AND created_at >= ? AND created_at < ?
    `, [targetUserId, startDate, endDate]);

    // Actual proposals: COUNT proposals in period
    const proposalsRow = get(`
      SELECT COUNT(*) as total
      FROM proposals
      WHERE created_by = ?
      AND created_at >= ? AND created_at < ?
    `, [targetUserId, startDate, endDate]);

    // Actual deals: COUNT deals WHERE stage >= 7 in period
    const dealsRow = get(`
      SELECT COUNT(*) as total
      FROM deals WHERE stage >= 7
      AND actual_close_date >= ? AND actual_close_date < ?
    `, [startDate, endDate]);

    res.json({
      goal: goal || null,
      actuals: {
        actual_commission: commRow ? commRow.total : 0,
        actual_calls: callsRow ? callsRow.total : 0,
        actual_proposals: proposalsRow ? proposalsRow.total : 0,
        actual_deals: dealsRow ? dealsRow.total : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET leaderboard
router.get('/leaderboard', authMiddleware, (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || (new Date().getMonth() + 1);

    const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const endMonth = targetMonth === 12 ? 1 : targetMonth + 1;
    const endYear = targetMonth === 12 ? targetYear + 1 : targetYear;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const agents = all(`SELECT id, name, email, role FROM users WHERE role = 'agent'`);

    const leaderboard = agents.map(agent => {
      const goal = get(`
        SELECT * FROM agent_goals
        WHERE user_id = ? AND year = ? AND month = ?
      `, [agent.id, targetYear, targetMonth]);

      const commRow = get(`
        SELECT COALESCE(SUM(commission_value), 0) as total
        FROM deals WHERE stage >= 7
        AND actual_close_date >= ? AND actual_close_date < ?
      `, [startDate, endDate]);

      const callsRow = get(`
        SELECT COUNT(*) as total
        FROM activities WHERE activity_type = 'call'
        AND created_by = ?
        AND created_at >= ? AND created_at < ?
      `, [agent.id, startDate, endDate]);

      const proposalsRow = get(`
        SELECT COUNT(*) as total
        FROM proposals
        WHERE created_by = ?
        AND created_at >= ? AND created_at < ?
      `, [agent.id, startDate, endDate]);

      const dealsRow = get(`
        SELECT COUNT(*) as total
        FROM deals WHERE stage >= 7
        AND actual_close_date >= ? AND actual_close_date < ?
      `, [startDate, endDate]);

      const commissionTarget = goal ? goal.commission_target : 0;
      const actualCommission = commRow ? commRow.total : 0;
      const commissionPct = commissionTarget > 0 ? Math.round((actualCommission / commissionTarget) * 100) : 0;

      return {
        user_id: agent.id,
        name: agent.name,
        email: agent.email,
        commission_target: commissionTarget,
        actual_commission: actualCommission,
        commission_pct: commissionPct,
        calls_target: goal ? goal.calls_target : 0,
        actual_calls: callsRow ? callsRow.total : 0,
        proposals_target: goal ? goal.proposals_target : 0,
        actual_proposals: proposalsRow ? proposalsRow.total : 0,
        deals_target: goal ? goal.deals_target : 0,
        actual_deals: dealsRow ? dealsRow.total : 0
      };
    });

    // Sort by commission percentage descending
    leaderboard.sort((a, b) => b.commission_pct - a.commission_pct);

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET all goals
router.get('/', authMiddleware, (req, res) => {
  try {
    const { user_id, year, month, period_type } = req.query;
    let query = `SELECT g.*, u.name as user_name FROM agent_goals g LEFT JOIN users u ON g.user_id = u.id WHERE 1=1`;
    const params = [];

    if (user_id) { query += ` AND g.user_id = ?`; params.push(user_id); }
    if (year) { query += ` AND g.year = ?`; params.push(parseInt(year)); }
    if (month) { query += ` AND g.month = ?`; params.push(parseInt(month)); }
    if (period_type) { query += ` AND g.period_type = ?`; params.push(period_type); }

    query += ` ORDER BY g.year DESC, g.month DESC`;
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST create/upsert goal (admin only)
router.post('/', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { user_id, period_type, year, month, commission_target, calls_target, proposals_target, deals_target } = req.body;
    if (!user_id || !year) {
      return res.status(400).json({ error: 'user_id and year are required' });
    }

    // Check if goal already exists for this user/period
    const existing = get(`
      SELECT id FROM agent_goals WHERE user_id = ? AND year = ? AND month = ?
    `, [user_id, year, month || null]);

    if (existing) {
      // Upsert - update existing
      run(`
        UPDATE agent_goals SET
          period_type = ?, commission_target = ?, calls_target = ?,
          proposals_target = ?, deals_target = ?
        WHERE id = ?
      `, [
        period_type || 'monthly',
        commission_target || 0, calls_target || 0,
        proposals_target || 0, deals_target || 0,
        existing.id
      ]);
      const goal = get('SELECT * FROM agent_goals WHERE id = ?', [existing.id]);
      return res.json(goal);
    }

    const id = uuidv4();
    run(`
      INSERT INTO agent_goals (id, user_id, period_type, year, month, commission_target, calls_target, proposals_target, deals_target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, user_id, period_type || 'monthly', year, month || null,
      commission_target || 0, calls_target || 0,
      proposals_target || 0, deals_target || 0
    ]);

    const goal = get('SELECT * FROM agent_goals WHERE id = ?', [id]);
    res.status(201).json(goal);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET single goal by id
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const goal = get('SELECT g.*, u.name as user_name FROM agent_goals g LEFT JOIN users u ON g.user_id = u.id WHERE g.id = ?', [req.params.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PUT update goal (admin only)
router.put('/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const existing = get('SELECT * FROM agent_goals WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Goal not found' });

    const { user_id, period_type, year, month, commission_target, calls_target, proposals_target, deals_target } = req.body;

    run(`
      UPDATE agent_goals SET
        user_id = ?, period_type = ?, year = ?, month = ?,
        commission_target = ?, calls_target = ?,
        proposals_target = ?, deals_target = ?
      WHERE id = ?
    `, [
      user_id || existing.user_id,
      period_type || existing.period_type,
      year || existing.year,
      month !== undefined ? month : existing.month,
      commission_target !== undefined ? commission_target : existing.commission_target,
      calls_target !== undefined ? calls_target : existing.calls_target,
      proposals_target !== undefined ? proposals_target : existing.proposals_target,
      deals_target !== undefined ? deals_target : existing.deals_target,
      req.params.id
    ]);

    const goal = get('SELECT * FROM agent_goals WHERE id = ?', [req.params.id]);
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE goal (admin only)
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const goal = get('SELECT * FROM agent_goals WHERE id = ?', [req.params.id]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    run('DELETE FROM agent_goals WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
