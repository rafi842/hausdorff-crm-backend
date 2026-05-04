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

// Helper: parse custom fields from Facebook form into structured CRM fields
function parseCustomFields(customFields) {
  if (!customFields || typeof customFields !== 'object') return {};
  const mapped = {};
  for (const [rawKey, rawValue] of Object.entries(customFields)) {
    const k = String(rawKey).toLowerCase();
    const v = Array.isArray(rawValue) ? String(rawValue[0] || '') : String(rawValue || '');
    if (!v) continue;
    if (k.includes('תקציב') || k.includes('budget')) {
      const num = parseInt(v.replace(/\D/g, '')) || 0;
      if (num > 0) mapped.budget_max = num;
    } else if (k.includes('איזור') || k.includes('אזור') || k.includes('area') || k.includes('עיר') || k.includes('city')) {
      mapped.preferred_areas = JSON.stringify([v]);
    } else if (k.includes('סוג נכס') || k.includes('property type') || k.includes('property_type')) {
      mapped.preferred_property_types = JSON.stringify([v]);
    } else if (k.includes('הערות') || k.includes('notes') || k.includes('message')) {
      mapped.notes = v;
    }
  }
  return mapped;
}

// POST /webhook - Receive lead from Facebook/Google Ads (PUBLIC - NO AUTH)
router.post('/webhook', (req, res) => {
  try {
    const {
      // Existing fields
      name, phone, email, source,
      campaign_name, form_name, ad_id,
      utm_source, utm_medium, utm_campaign,
      // Facebook-specific fields
      facebook_lead_id, facebook_form_id, facebook_form_name,
      facebook_ad_id, facebook_ad_name, facebook_adset_name,
      facebook_campaign_id, facebook_campaign_name, facebook_platform,
      // Custom fields from Lead Form (key-value)
      custom_fields,
    } = req.body;

    // Deduplication: same facebook_lead_id = same lead
    if (facebook_lead_id) {
      const existing = get('SELECT id FROM contacts WHERE facebook_lead_id = ?', [facebook_lead_id]);
      if (existing) {
        const logId = uuidv4();
        run(`INSERT INTO webhook_logs (id, source, payload, status)
             VALUES (?, ?, ?, 'duplicate')`,
          [logId, source || 'facebook', JSON.stringify(req.body)]);
        return res.json({ success: true, id: existing.id, duplicate: true });
      }
    }

    const contactId = uuidv4();

    // Parse name into first/last
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Parse custom fields → structured CRM fields
    const fromCustom = parseCustomFields(custom_fields);

    // Find assignment rule for this source
    let assignedAgent = '';
    const sourceStr = source || utm_source || '';
    if (sourceStr) {
      const rule = get('SELECT * FROM lead_assignment_rules WHERE source = ?', [sourceStr]);
      if (rule) {
        if (rule.use_round_robin) {
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
          const agent = get('SELECT name FROM users WHERE id = ?', [rule.assigned_agent]);
          assignedAgent = agent ? agent.name : rule.assigned_agent;
        }
      }
    }

    // Resolve final values (custom_fields take priority where they exist)
    const finalPhone = fromCustom.phone || phone || '';
    const finalNotes = (fromCustom.notes || '') + (assignedAgent ? `\nassigned:${assignedAgent}` : '');
    const finalBudgetMax = fromCustom.budget_max || 0;
    const finalAreas = fromCustom.preferred_areas || '[]';
    const finalTypes = fromCustom.preferred_property_types || '[]';

    // Create contact with all fields
    run(`
      INSERT INTO contacts (
        id, first_name, last_name, email, phone, type, contact_category, lead_status,
        source, status, utm_source, utm_medium, utm_campaign, lead_source_detail, notes,
        budget_max, preferred_areas, preferred_property_types,
        facebook_lead_id, facebook_form_id, facebook_form_name,
        facebook_ad_id, facebook_ad_name, facebook_adset_name,
        facebook_campaign_id, facebook_campaign_name, facebook_platform, facebook_lead_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId, firstName, lastName,
      email || '', finalPhone,
      'קונה', 'lead', 'חדש',
      sourceStr || 'webhook', 'פעיל',
      utm_source || '', utm_medium || '', utm_campaign || '',
      [campaign_name || facebook_campaign_name, form_name || facebook_form_name, ad_id || facebook_ad_id].filter(Boolean).join(' | '),
      finalNotes.trim(),
      finalBudgetMax, finalAreas, finalTypes,
      facebook_lead_id || '', facebook_form_id || '', facebook_form_name || '',
      facebook_ad_id || '', facebook_ad_name || '', facebook_adset_name || '',
      facebook_campaign_id || '', facebook_campaign_name || '', facebook_platform || '',
      custom_fields ? JSON.stringify(custom_fields) : ''
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
