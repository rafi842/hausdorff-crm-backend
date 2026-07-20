const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');
const { resolveOccupancyStatus } = require('../utils/occupancy');

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
    res.status(500).json({ error: safeError(err) });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const project = get(`SELECT p.*, c.name as company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`, [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.get('/:id/properties', authMiddleware, (req, res) => {
  try {
    res.json(all('SELECT * FROM properties WHERE project_id = ? ORDER BY floor', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion, gross_net_ratio, mgmt_fee_per_sqm } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO projects (id,name,company_id,address,city,neighborhood,total_units,available_units,status,description,amenities,expected_completion,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, now]);
    run(`UPDATE projects SET gross_net_ratio=?,mgmt_fee_per_sqm=? WHERE id=?`, [gross_net_ratio||0, mgmt_fee_per_sqm != null ? mgmt_fee_per_sqm : 35, id]);
    res.status(201).json(get('SELECT * FROM projects WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { name, company_id, address, city, neighborhood, total_units, available_units, status, description, amenities, expected_completion, gross_net_ratio, mgmt_fee_per_sqm } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE projects SET name=?,company_id=?,address=?,city=?,neighborhood=?,total_units=?,available_units=?,status=?,description=?,amenities=?,expected_completion=?,updated_at=? WHERE id=?`,
      [name, company_id||null, address||'', city||'', neighborhood||'', total_units||0, available_units||0, status||'בתכנון', description||'', JSON.stringify(amenities||[]), expected_completion||null, now, req.params.id]);
    run(`UPDATE projects SET gross_net_ratio=?,mgmt_fee_per_sqm=? WHERE id=?`, [gross_net_ratio||0, mgmt_fee_per_sqm != null ? mgmt_fee_per_sqm : 35, req.params.id]);
    res.json(get('SELECT * FROM projects WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
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

    const rawUnits = all('SELECT * FROM properties WHERE project_id = ? ORDER BY floor, unit_number', [req.params.id]);
    // Enrich each unit with its effective occupancy status and proposed-mix shortlist.
    const units = rawUnits.map(u => {
      const cands = all(`
        SELECT uc.chain_name, uc.candidate_status, uc.deal_id, c.name AS company_name
        FROM unit_candidates uc LEFT JOIN companies c ON uc.company_id = c.id
        WHERE uc.property_id = ? ORDER BY uc.rank ASC, uc.created_at ASC
      `, [u.id]).map(x => ({ name: x.chain_name || x.company_name || '', candidate_status: x.candidate_status, promoted: !!x.deal_id }));
      return { ...u, occupancy_status: resolveOccupancyStatus(u), candidates: cands };
    });
    const unitIds = units.map(u => u.id);

    let deals = [];
    if (unitIds.length) {
      const ph = unitIds.map(() => '?').join(',');
      deals = all(`
        SELECT d.*, c.first_name || ' ' || c.last_name as contact_name,
               comp.name as chain_name, p.unit_number as unit_number, p.designated_category as unit_category,
               p.area_gross as unit_gross, p.area_net as unit_net
        FROM deals d
        LEFT JOIN contacts c ON d.contact_id = c.id
        LEFT JOIN companies comp ON c.company_id = comp.id
        LEFT JOIN properties p ON d.property_id = p.id
        WHERE d.property_id IN (${ph})
        ORDER BY d.stage DESC, d.updated_at DESC
      `, unitIds);
    }

    // An activity counts toward this centre if it is attached to one of its units
    // or their deals, OR if the agent tagged it to the project directly. The tag is
    // what captures early-stage work — prospecting a chain before any unit is on
    // the table attaches to a contact, which no unit or deal would ever match.
    const entityIds = [...deals.map(d => d.id), ...unitIds];
    const ph = entityIds.map(() => '?').join(',');
    // `let`, not `const` — the enrichment step below reassigns this.
    let activities = all(
      `SELECT * FROM activities
        WHERE (${entityIds.length ? `entity_id IN (${ph}) OR ` : ''}project_id = ?)
          AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC`,
      [...entityIds, req.params.id, fromDate, toDate]
    );
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

    const summary = {
      totalUnits: units.length, leased: 0, nego: 0, free: 0,
      activityCount: activities.length,
      openDeals: deals.filter(d => d.stage >= 1 && d.stage <= 5).length,
      signed: deals.filter(d => d.stage === 6).length,
    };
    // ── Pro-forma: roll the units up into project-level economics (full occupancy)
    const mgmtDefault = project.mgmt_fee_per_sqm != null ? project.mgmt_fee_per_sqm : 35;
    const pf = { gross: 0, net: 0, monthlyRent: 0, monthlyMgmt: 0, signedNet: 0, termsNet: 0, negoNet: 0, freeNet: 0 };
    units.forEach(u => {
      const g = u.area_gross || u.area || 0, n = u.area_net || u.area || 0;
      pf.gross += g; pf.net += n;
      pf.monthlyRent += g * (u.rent_per_sqm || 0);
      pf.monthlyMgmt += g * (u.management_fee || mgmtDefault);
      const os = u.occupancy_status;
      if (os === 'חתום חוזה') { pf.signedNet += n; summary.leased++; }
      else if (os === 'חתמו תנאים') { pf.termsNet += n; summary.nego++; }
      else if (os === 'במו"מ') { pf.negoNet += n; summary.nego++; }
      else { pf.freeNet += n; summary.free++; }
    });
    const proforma = {
      grossArea: pf.gross, netArea: pf.net,
      annualRent: pf.monthlyRent * 12, monthlyRent: pf.monthlyRent,
      annualMgmt: pf.monthlyMgmt * 12, monthlyMgmt: pf.monthlyMgmt,
      avgRentGross: pf.gross ? pf.monthlyRent / pf.gross : 0,
      avgRentNet: pf.net ? pf.monthlyRent / pf.net : 0,
      occupancyPct: pf.net ? Math.round(pf.signedNet / pf.net * 100) : 0,
      byStatusNet: { signed: pf.signedNet, terms: pf.termsNet, nego: pf.negoNet, free: pf.freeNet },
    };

    const floorPlans = all('SELECT * FROM floor_plans WHERE project_id = ? ORDER BY created_at ASC', [req.params.id]);

    res.json({ project, from: from || '', to: to || '', units, deals, activities, summary, proforma, floorPlans });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
