const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');

// GET /webhook - Facebook webhook verification (PUBLIC)
router.get('/webhook', (req, res) => {
  try {
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'crm-webhook-token';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook - Receive lead from Facebook/Google Ads (PUBLIC - NO AUTH)
router.post('/webhook', (req, res) => {
  try {
    const {
      name, phone, email, source,
      campaign_name, form_name, ad_id,
      utm_source, utm_medium, utm_campaign
    } = req.body;

    const contactId = uuidv4();

    // Parse name into first/last
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Find assignment rule for this source
    let assignedAgent = '';
    const sourceStr = source || utm_source || '';
    if (sourceStr) {
      const rule = get('SELECT * FROM lead_assignment_rules WHERE source = ?', [sourceStr]);
      if (rule) {
        if (rule.use_round_robin) {
          // Round-robin: find agent with fewest recent leads
          const agents = all(`SELECT id, name FROM users WHERE role = 'agent'`);
          if (agents.length > 0) {
            let minCount = Infinity;
            let selectedAgent = agents[0];
            agents.forEach(agent => {
              const countRow = get(`
                SELECT COUNT(*) as c FROM contacts
                WHERE created_at >= datetime('now', '-30 days')
                AND notes LIKE ?
              `, [`%assigned:${agent.id}%`]);
              const count = countRow ? countRow.c : 0;
              if (count < minCount) {
                minCount = count;
                selectedAgent = agent;
              }
            });
            assignedAgent = selectedAgent.name;
          }
        } else if (rule.assigned_agent) {
          // Direct assignment
          const agent = get('SELECT name FROM users WHERE id = ?', [rule.assigned_agent]);
          assignedAgent = agent ? agent.name : rule.assigned_agent;
        }
      }
    }

    // Create contact
    run(`
      INSERT INTO contacts (
        id, first_name, last_name, email, phone, type, contact_category, lead_status,
        source, status, utm_source, utm_medium, utm_campaign, lead_source_detail, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId, firstName, lastName,
      email || '', phone || '',
      'קונה', 'lead', 'חדש',
      sourceStr || 'webhook', 'פעיל',
      utm_source || '', utm_medium || '', utm_campaign || '',
      [campaign_name, form_name, ad_id].filter(Boolean).join(' | '),
      assignedAgent ? `assigned:${assignedAgent}` : ''
    ]);

    // Log to webhook_logs
    const logId = uuidv4();
    run(`
      INSERT INTO webhook_logs (id, source, payload, status)
      VALUES (?, ?, ?, 'success')
    `, [logId, sourceStr || 'unknown', JSON.stringify(req.body)]);

    res.json({ success: true, id: contactId });
  } catch (err) {
    // Log error
    try {
      const logId = uuidv4();
      run(`
        INSERT INTO webhook_logs (id, source, payload, status, error_message)
        VALUES (?, ?, ?, 'error', ?)
      `, [logId, 'unknown', JSON.stringify(req.body), err.message]);
    } catch (e) { /* ignore logging error */ }

    res.status(500).json({ error: err.message });
  }
});

// POST /import-csv - Import leads from CSV (AUTH REQUIRED)
router.post('/import-csv', authMiddleware, (req, res) => {
  try {
    const { leads } = req.body;
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'leads array is required' });
    }
    if (leads.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 leads per import' });
    }

    let imported = 0;
    const errors = [];

    leads.forEach((lead, index) => {
      try {
        const id = uuidv4();
        const nameParts = (lead.name || '').trim().split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        run(`
          INSERT INTO contacts (
            id, first_name, last_name, email, phone, type, contact_category, lead_status,
            source, status, utm_source, lead_source_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id, firstName, lastName,
          lead.email || '', lead.phone || '',
          'קונה', 'lead', 'חדש',
          lead.source || 'csv-import', 'פעיל',
          lead.source || '', lead.campaign || ''
        ]);
        imported++;
      } catch (e) {
        errors.push({ index, name: lead.name, error: e.message });
      }
    });

    res.json({ imported, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /webhook-logs - View webhook logs (AUTH REQUIRED, admin only)
router.get('/webhook-logs', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const logs = all('SELECT * FROM webhook_logs ORDER BY created_at DESC LIMIT 20');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /test-webhook - Insert test webhook log (AUTH REQUIRED)
router.post('/test-webhook', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    run(`
      INSERT INTO webhook_logs (id, source, payload, status)
      VALUES (?, 'test', ?, 'success')
    `, [id, JSON.stringify({ test: true, user: req.user.name, timestamp: new Date().toISOString() })]);

    const log = get('SELECT * FROM webhook_logs WHERE id = ?', [id]);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /assignment-rules - List all rules (AUTH REQUIRED)
router.get('/assignment-rules', authMiddleware, (req, res) => {
  try {
    const rules = all(`
      SELECT r.*, u.name as agent_name
      FROM lead_assignment_rules r
      LEFT JOIN users u ON r.assigned_agent = u.id
      ORDER BY r.created_at DESC
    `);
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /assignment-rules - Create rule (AUTH REQUIRED, admin only)
router.post('/assignment-rules', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { source, assigned_agent, use_round_robin } = req.body;
    if (!source) {
      return res.status(400).json({ error: 'source is required' });
    }

    const id = uuidv4();
    run(`
      INSERT INTO lead_assignment_rules (id, source, assigned_agent, use_round_robin)
      VALUES (?, ?, ?, ?)
    `, [id, source, assigned_agent || '', use_round_robin ? 1 : 0]);

    const rule = get('SELECT * FROM lead_assignment_rules WHERE id = ?', [id]);
    res.status(201).json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /assignment-rules/:id - Update rule (AUTH REQUIRED, admin only)
router.put('/assignment-rules/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const existing = get('SELECT * FROM lead_assignment_rules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const { source, assigned_agent, use_round_robin } = req.body;
    run(`
      UPDATE lead_assignment_rules SET
        source = ?, assigned_agent = ?, use_round_robin = ?
      WHERE id = ?
    `, [
      source || existing.source,
      assigned_agent !== undefined ? assigned_agent : existing.assigned_agent,
      use_round_robin !== undefined ? (use_round_robin ? 1 : 0) : existing.use_round_robin,
      req.params.id
    ]);

    const rule = get('SELECT * FROM lead_assignment_rules WHERE id = ?', [req.params.id]);
    res.json(rule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /assignment-rules/:id - Delete rule (AUTH REQUIRED, admin only)
router.delete('/assignment-rules/:id', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const rule = get('SELECT * FROM lead_assignment_rules WHERE id = ?', [req.params.id]);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    run('DELETE FROM lead_assignment_rules WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /source-stats - Lead counts grouped by utm_source (AUTH REQUIRED)
router.get('/source-stats', authMiddleware, (req, res) => {
  try {
    const stats = all(`
      SELECT
        CASE WHEN utm_source = '' OR utm_source IS NULL THEN source ELSE utm_source END as lead_source,
        COUNT(*) as count
      FROM contacts
      WHERE contact_category = 'lead'
      GROUP BY lead_source
      ORDER BY count DESC
    `);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
