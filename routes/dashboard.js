const express = require('express');
const router = express.Router();
const { get, all, run } = require('../database');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');
const { SQL_OPEN, SQL_SIGNED } = require('../utils/stages');

router.get('/stats', authMiddleware, (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get start of current week (Sunday) and end of week (Saturday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // Get start of month
    const monthStart = `${today.substring(0, 7)}-01`;

    const totalDeals = get(`SELECT COUNT(*) as count FROM deals WHERE ${SQL_OPEN}`);
    const closedDeals = get(`SELECT COUNT(*) as count, SUM(value) as total_value, SUM(commission_value) as total_commission FROM deals WHERE ${SQL_SIGNED}`);
    const totalContacts = get(`SELECT COUNT(*) as count FROM contacts WHERE contact_category = 'contact'`);
    const totalLeads = get(`SELECT COUNT(*) as count FROM contacts WHERE contact_category = 'lead'`);
    const totalProperties = get(`SELECT COUNT(*) as count FROM properties WHERE status = 'זמין'`);
    const pipelineValue = get(`SELECT SUM(value) as total FROM deals WHERE ${SQL_OPEN}`);
    const overdueTasks = get(`SELECT COUNT(*) as count FROM tasks WHERE due_date < '${today}' AND completed = 0`);
    const dueTodayTasks = get(`SELECT COUNT(*) as count FROM tasks WHERE due_date = '${today}' AND completed = 0`);

    // This week closed deals
    const weekClosedDeals = get(`SELECT COUNT(*) as count, SUM(commission_value) as total_commission FROM deals WHERE ${SQL_SIGNED} AND actual_close_date >= '${weekStartStr}' AND actual_close_date <= '${weekEndStr}'`);

    // This month commission
    const monthCommission = get(`SELECT SUM(commission_value) as total FROM deals WHERE ${SQL_SIGNED} AND actual_close_date >= '${monthStart}'`);

    const dealsByStage = all(`
      SELECT stage, COUNT(*) as count, SUM(value) as total_value
      FROM deals WHERE ${SQL_OPEN}
      GROUP BY stage ORDER BY stage
    `);

    const monthlyRevenue = all(`
      SELECT
        substr(actual_close_date, 1, 7) as month,
        COUNT(*) as deals_count,
        SUM(value) as total_value,
        SUM(commission_value) as total_commission
      FROM deals
      WHERE ${SQL_SIGNED} AND actual_close_date IS NOT NULL AND actual_close_date != ''
      GROUP BY substr(actual_close_date, 1, 7)
      ORDER BY month ASC
    `);

    const agentPerformance = all(`
      SELECT
        assigned_to,
        COUNT(*) as total_deals,
        SUM(CASE WHEN ${SQL_SIGNED} THEN 1 ELSE 0 END) as closed_deals,
        SUM(CASE WHEN ${SQL_SIGNED} THEN commission_value ELSE 0 END) as total_commission,
        SUM(CASE WHEN ${SQL_OPEN} THEN value ELSE 0 END) as pipeline_value
      FROM deals
      GROUP BY assigned_to
      ORDER BY total_commission DESC
    `);

    const sourceBreakdown = all(`
      SELECT source, COUNT(*) as count FROM contacts GROUP BY source ORDER BY count DESC
    `);

    const recentActivity = all(`
      SELECT t.*,
        d.title as deal_title,
        c.first_name || ' ' || c.last_name as contact_name
      FROM timeline t
      LEFT JOIN deals d ON t.deal_id = d.id
      LEFT JOIN contacts c ON t.contact_id = c.id
      ORDER BY t.created_at DESC
      LIMIT 10
    `);

    res.json({
      stats: {
        active_deals: totalDeals?.count || 0,
        closed_deals: closedDeals?.count || 0,
        total_revenue: closedDeals?.total_value || 0,
        total_commission: closedDeals?.total_commission || 0,
        total_contacts: totalContacts?.count || 0,
        total_leads: totalLeads?.count || 0,
        available_properties: totalProperties?.count || 0,
        pipeline_value: pipelineValue?.total || 0,
        overdue_tasks: overdueTasks?.count || 0,
        due_today_tasks: dueTodayTasks?.count || 0,
        week_closed_deals: weekClosedDeals?.count || 0,
        week_commission: weekClosedDeals?.total_commission || 0,
        month_commission: monthCommission?.total || 0,
      },
      deals_by_stage: dealsByStage,
      monthly_revenue: monthlyRevenue,
      agent_performance: agentPerformance,
      source_breakdown: sourceBreakdown,
      recent_activity: recentActivity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/upcoming', authMiddleware, (req, res) => {
  try {
    const tasks = all(`
      SELECT t.*,
        d.title as deal_title,
        c.first_name || ' ' || c.last_name as contact_name
      FROM tasks t
      LEFT JOIN deals d ON t.deal_id = d.id
      LEFT JOIN contacts c ON t.contact_id = c.id
      WHERE t.completed = 0
      ORDER BY t.due_date ASC, t.task_time ASC
      LIMIT 30
    `);
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/week', authMiddleware, (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const tasks = all(`
      SELECT t.*,
        d.title as deal_title,
        c.first_name || ' ' || c.last_name as contact_name
      FROM tasks t
      LEFT JOIN deals d ON t.deal_id = d.id
      LEFT JOIN contacts c ON t.contact_id = c.id
      WHERE t.due_date >= ? AND t.due_date <= ?
      ORDER BY t.due_date ASC, t.task_time ASC
    `, [weekStartStr, weekEndStr]);
    res.json({ tasks, week_start: weekStartStr, week_end: weekEndStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Match notifications — enhanced with contact/property details + status filtering
router.get('/match-notifications', authMiddleware, (req, res) => {
  try {
    const { include_dismissed } = req.query;
    const filter = include_dismissed === 'true' ? '' : "WHERE (mn.status IS NULL OR mn.status != 'dismissed')";
    const notifications = all(`
      SELECT mn.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone,
        c.type as contact_type,
        p.address as property_address,
        p.city as property_city,
        p.price as property_price,
        p.annual_yield as property_yield,
        p.type as property_type,
        p.area as property_area,
        p.rooms as property_rooms,
        p.deal_type as property_deal_type
      FROM match_notifications mn
      LEFT JOIN contacts c ON mn.contact_id = c.id
      LEFT JOIN properties p ON mn.property_id = p.id
      ${filter}
      ORDER BY mn.score DESC, mn.created_at DESC
      LIMIT 50
    `);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/match-notifications/:id/seen', authMiddleware, (req, res) => {
  try {
    run('UPDATE match_notifications SET seen=1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update match notification status
router.patch('/match-notifications/:id/status', authMiddleware, (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new', 'contacted', 'deal_created', 'dismissed'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
    }
    run('UPDATE match_notifications SET status=? WHERE id=?', [status, req.params.id]);
    if (status === 'dismissed') {
      run('UPDATE match_notifications SET seen=1 WHERE id=?', [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a deal from a match notification
router.post('/match-to-deal', authMiddleware, (req, res) => {
  try {
    const { notification_id, contact_id, property_id } = req.body;
    if (!notification_id || !contact_id || !property_id) {
      return res.status(400).json({ error: 'notification_id, contact_id, and property_id are required' });
    }

    // Verify notification exists
    const mn = get('SELECT * FROM match_notifications WHERE id = ?', [notification_id]);
    if (!mn) return res.status(404).json({ error: 'Match notification not found' });

    // Get contact and property details
    const contact = get("SELECT first_name || ' ' || last_name as name FROM contacts WHERE id = ?", [contact_id]);
    const property = get('SELECT address, city, price FROM properties WHERE id = ?', [property_id]);
    if (!contact || !property) {
      return res.status(404).json({ error: 'Contact or property not found' });
    }

    // Create the deal
    const dealId = uuidv4();
    const title = `${contact.name} — ${property.address}`;
    const value = property.price || 0;
    const commRate = 2.0;
    const commValue = Math.round(value * commRate / 100);
    const now = new Date().toISOString();

    run(`INSERT INTO deals (id, title, contact_id, property_id, stage, value, commission_rate, commission_value, source, assigned_to, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'Smart Match', ?, 'בינוני', ?, ?)`,
      [dealId, title, contact_id, property_id, value, commRate, commValue, req.user.name, now, now]);

    // Timeline entry
    const tlId = uuidv4();
    run(`INSERT INTO timeline (id, deal_id, type, title, description, created_by, created_at)
      VALUES (?, ?, 'created', 'עסקה נוצרה', 'נוצרה מהתאמה חכמה — ניקוד ${mn.score}', ?, ?)`,
      [tlId, dealId, req.user.name, now]);

    // Update match notification status
    run("UPDATE match_notifications SET status='deal_created', seen=1 WHERE id=?", [notification_id]);

    const deal = get('SELECT * FROM deals WHERE id = ?', [dealId]);
    res.status(201).json({ deal_id: dealId, deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
