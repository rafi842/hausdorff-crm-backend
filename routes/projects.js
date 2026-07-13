const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE 1=1`;
    const params = [];
    if (search) {
      query += ' AND (p.name LIKE ? OR p.city LIKE ? OR p.neighborhood LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    query += ' ORDER BY p.created_at DESC';
    res.json(all(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const project = get(`SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`, [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/properties', (req, res) => {
  try {
    res.json(all('SELECT * FROM properties WHERE project_id = ? ORDER BY floor', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, now]);
    res.status(201).json(get('SELECT * FROM projects WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE projects SET name=?,company_id=?,address=?,city=?,neighborhood=?,total_units=?,available_units=?,status=?,description=?,amenities=?,expected_completion=?,updated_at=? WHERE id=?`,
      [name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, req.params.id]);
    res.json(get('SELECT * FROM projects WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/marketing-report?from=&to= — data for the developer marketing PDF:
// activities (calls/meetings), negotiation status per unit, tenant-mix progress.
router.get('/:id/marketing-report', authMiddleware, (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || '2000-01-01';
    const toDate = to ? to + ' 23:59:59' : '2999-12-31';

    const project = get(`SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`, [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const units = all('SELECT * FROM properties WHERE project_id = ? ORDER BY floor, unit_number', [req.params.id]);
    const unitIds = units.map(u => u.id);

    let deals = [];
    if (unitIds.length) {
      const ph = unitIds.map(() => '?').join(',');
      deals = all(`
        SELECT d.*, c.first_name || ' ' || c.last_name as contact_name,
               comp.name as chain_name, p.unit_number as unit_number, p.designated_category as unit_category
        FROM deals d
        LEFT JOIN contacts c ON d.contact_id = c.id
        LEFT JOIN companies comp ON c.company_id = comp.id
        LEFT JOIN properties p ON d.property_id = p.id
        WHERE d.property_id IN (${ph})
        ORDER BY d.stage DESC, d.updated_at DESC
      `, unitIds);
    }

    const entityIds = [...deals.map(d => d.id), ...unitIds];
    let activities = [];
    if (entityIds.length) {
      const ph = entityIds.map(() => '?').join(',');
      activities = all(
        `SELECT * FROM activities WHERE entity_id IN (${ph}) AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC`,
        [...entityIds, fromDate, toDate]
      );
    }
    // Enrich activities with chain/unit context
    const dealById = {}; deals.forEach(d => { dealById[d.id] = d; });
    const unitById = {}; units.forEach(u => { unitById[u.id] = u; });
    activities = activities.map(a => {
      let contact_name = '', chain_name = '', unit_number = '';
      if (a.entity_type === 'deal' && dealById[a.entity_id]) {
        contact_name = dealById[a.entity_id].contact_name || '';
        chain_name = dealById[a.entity_id].chain_name || '';
        unit_number = dealById[a.entity_id].unit_number || '';
      } else if (a.entity_type === 'property' && unitById[a.entity_id]) {
        unit_number = unitById[a.entity_id].unit_number || '';
      }
      return { ...a, contact_name, chain_name, unit_number };
    });

    const statusOf = s => (s === 'תפוס' || s === 'נמכר') ? 'leased' : s === 'בתהליך' ? 'nego' : 'free';
    const summary = {
      totalUnits: units.length, leased: 0, nego: 0, free: 0,
      activityCount: activities.length,
      openDeals: deals.filter(d => d.stage >= 1 && d.stage <= 5).length,
      signed: deals.filter(d => d.stage === 6).length,
    };
    units.forEach(u => { summary[statusOf(u.status)]++; });

    res.json({ project, from: from || '', to: to || '', units, deals, activities, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
