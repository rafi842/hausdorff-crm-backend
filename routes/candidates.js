const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { safeError } = require('../utils/errors');

// GET /api/unit-candidates?property_id=... — proposed-mix shortlist for a unit.
// Enriches each candidate with the live chain status/category from companies.
router.get('/', authMiddleware, (req, res) => {
  try {
    const { property_id } = req.query;
    if (!property_id) return res.status(400).json({ error: 'property_id required' });
    const rows = all(`
      SELECT uc.*, c.name AS company_name, c.chain_status, c.branch_count,
             c.business_category, c.business_subcategory
      FROM unit_candidates uc
      LEFT JOIN companies c ON uc.company_id = c.id
      WHERE uc.property_id = ?
      ORDER BY uc.rank ASC, uc.created_at ASC
    `, [property_id]);
    // Attach the deal stage for candidates already promoted to a negotiation.
    const out = rows.map(r => {
      let deal_stage = null;
      if (r.deal_id) {
        const d = get('SELECT stage FROM deals WHERE id = ?', [r.deal_id]);
        deal_stage = d ? d.stage : null;
      }
      return { ...r, deal_stage };
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/unit-candidates — add a chain to a unit's proposed-mix shortlist.
router.post('/', authMiddleware, (req, res) => {
  try {
    const { property_id, company_id, chain_name, category, note, candidate_status, rank } = req.body;
    if (!property_id) return res.status(400).json({ error: 'property_id required' });
    // Default the category from the unit's designated category if not supplied.
    let cat = category || '';
    if (!cat) {
      const unit = get('SELECT designated_category FROM properties WHERE id = ?', [property_id]);
      cat = unit ? (unit.designated_category || '') : '';
    }
    // Resolve a display name if only a company id was given.
    let name = chain_name || '';
    if (!name && company_id) {
      const co = get('SELECT name FROM companies WHERE id = ?', [company_id]);
      name = co ? co.name : '';
    }
    const id = uuidv4();
    run(`INSERT INTO unit_candidates (id,property_id,company_id,chain_name,category,note,candidate_status,rank) VALUES (?,?,?,?,?,?,?,?)`,
      [id, property_id, company_id || null, name, cat, note || '', candidate_status || 'הוצע', rank || 0]);
    res.status(201).json(get('SELECT * FROM unit_candidates WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PUT /api/unit-candidates/:id — edit status / rank / note / category.
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const existing = get('SELECT * FROM unit_candidates WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Candidate not found' });
    const { chain_name, company_id, category, note, candidate_status, rank } = req.body;
    run(`UPDATE unit_candidates SET chain_name=?,company_id=?,category=?,note=?,candidate_status=?,rank=? WHERE id=?`,
      [chain_name !== undefined ? chain_name : existing.chain_name,
       company_id !== undefined ? company_id : existing.company_id,
       category !== undefined ? category : existing.category,
       note !== undefined ? note : existing.note,
       candidate_status !== undefined ? candidate_status : existing.candidate_status,
       rank !== undefined ? rank : existing.rank,
       req.params.id]);
    res.json(get('SELECT * FROM unit_candidates WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// DELETE /api/unit-candidates/:id
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    run('DELETE FROM unit_candidates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /api/unit-candidates/:id/promote — turn a candidate into a live deal
// (pipeline stage 1), link it back, and mark the candidate as advanced.
router.post('/:id/promote', authMiddleware, (req, res) => {
  try {
    const cand = get('SELECT * FROM unit_candidates WHERE id = ?', [req.params.id]);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    if (cand.deal_id) {
      const existing = get('SELECT * FROM deals WHERE id = ?', [cand.deal_id]);
      if (existing) return res.json({ candidate: cand, deal: existing, already: true });
    }
    const unit = get('SELECT * FROM properties WHERE id = ?', [cand.property_id]);
    // Prefer a real contact at the chain company so the deal joins cleanly.
    let contactId = null;
    if (cand.company_id) {
      const c = get('SELECT id FROM contacts WHERE company_id = ? ORDER BY created_at ASC LIMIT 1', [cand.company_id]);
      if (c) contactId = c.id;
    }
    const gross = (unit && (unit.area_gross || unit.area)) || 0;
    const monthlyRent = unit ? Math.round(gross * (unit.rent_per_sqm || 0)) : 0;
    const unitLabel = unit ? (unit.unit_number ? `יח' ${unit.unit_number}` : (unit.address || '')) : '';
    const title = `${cand.chain_name || 'רשת'}${unitLabel ? ' – ' + unitLabel : ''}`;
    const dealId = uuidv4();
    const now = new Date().toISOString();
    run(`INSERT INTO deals (id,title,contact_id,property_id,stage,value,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealId, title, contactId, cand.property_id, 1, monthlyRent, cand.note || '', now, now]);
    run(`UPDATE unit_candidates SET deal_id=?, candidate_status=? WHERE id=?`, [dealId, 'הועבר למו"מ', req.params.id]);
    res.status(201).json({ candidate: get('SELECT * FROM unit_candidates WHERE id = ?', [req.params.id]), deal: get('SELECT * FROM deals WHERE id = ?', [dealId]) });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
