const express = require('express');
const router = express.Router();
const { get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

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

    const totalDeals = get(`SELECT COUNT(*) as count FROM deals WHERE stage NOT IN (8, 9)`);
    const closedDeals = get(`SELECT COUNT(*) as count, SUM(value) as total_value, SUM(commission_value) as total_commission FROM deals WHERE stage = 8`);
    const totalContacts = get(`SELECT COUNT(*) as count FROM contacts WHERE contact_category = 'contact'`);
    const totalLeads = get(`SELECT COUNT(*) as count FROM contacts WHERE contact_category = 'lead'`);
    const totalProperties = get(`SELECT COUNT(*) as count FROM properties WHERE status = 'זמין'`);
    const pipelineValue = get(`SELECT SUM(value) as total FROM deals WHERE stage NOT IN (8, 9)`);
    const overdueTasks = get(`SELECT COUNT(*) as count FROM tasks WHERE due_date < '${today}' AND completed = 0`);
    const dueTodayTasks = get(`SELECT COUNT(*) as count FROM tasks WHERE due_date = '${today}' AND completed = 0`);

    // This week closed deals
    const weekClosedDeals = get(`SELECT COUNT(*) as count, SUM(commission_value) as total_commission FROM deals WHERE stage = 8 AND actual_close_date >= '${weekStartStr}' AND actual_close_date <= '${weekEndStr}'`);

    // This month commission
    const monthCommission = get(`SELECT SUM(commission_value) as total FROM deals WHERE stage = 8 AND actual_close_date >= '${monthStart}'`);

    const dealsByStage = all(`
      SELECT stage, COUNT(*) as count, SUM(value) as total_value
      FROM deals WHERE stage NOT IN (8, 9)
      GROUP BY stage ORDER BY stage
    `);

    const monthlyRevenue = all(`
      SELECT
        substr(actual_close_date, 1, 7) as month,
        COUNT(*) as deals_count,
        SUM(value) as total_value,
        SUM(commission_value) as total_commission
      FROM deals
      WHERE stage = 8 AND actual_close_date IS NOT NULL AND actual_close_date != ''
      GROUP BY substr(actual_close_date, 1, 7)
      ORDER BY month ASC
    `);

    const agentPerformance = all(`
      SELECT
        assigned_to,
        COUNT(*) as total_deals,
        SUM(CASE WHEN stage = 8 THEN 1 ELSE 0 END) as closed_deals,
        SUM(CASE WHEN stage = 8 THEN commission_value ELSE 0 END) as total_commission,
        SUM(CASE WHEN stage NOT IN (8,9) THEN value ELSE 0 END) as pipeline_value
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

// Match notifications
router.get('/match-notifications', authMiddleware, (req, res) => {
  try {
    const notifications = all(`
      SELECT mn.*,
        c.first_name || ' ' || c.last_name as contact_name,
        c.phone as contact_phone,
        p.address as property_address,
        p.city as property_city,
        p.price as property_price,
        p.annual_yield as property_yield
      FROM match_notifications mn
      LEFT JOIN contacts c ON mn.contact_id = c.id
      LEFT JOIN properties p ON mn.property_id = p.id
      WHERE mn.seen = 0
      ORDER BY mn.created_at DESC
      LIMIT 20
    `);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/match-notifications/:id/seen', authMiddleware, (req, res) => {
  try {
    const { run } = require('../database');
    run('UPDATE match_notifications SET seen=1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
