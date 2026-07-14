const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// GET /api/categories — the business-category taxonomy, grouped main → subs.
router.get('/', authMiddleware, (req, res) => {
  try {
    const rows = all('SELECT id, name, parent_id, sort_order FROM business_categories WHERE active = 1 ORDER BY sort_order');
    const mains = rows
      .filter(r => !r.parent_id)
      .map(m => ({
        id: m.id,
        name: m.name,
        subs: rows.filter(r => r.parent_id === m.id).map(s => ({ id: s.id, name: s.name })),
      }));
    res.json(mains);
  } catch (err) {
    console.error('[Categories] list error:', err.message);
    res.status(500).json({ error: 'שגיאת שרת פנימית' });
  }
});

// POST /api/categories — add a main category (no parent_id) or a sub (parent_id).
router.post('/', authMiddleware, adminOnly, (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const parentId = req.body.parent_id || null;
    if (!name) return res.status(400).json({ error: 'יש להזין שם קטגוריה' });
    if (parentId) {
      const parent = get('SELECT id, parent_id FROM business_categories WHERE id = ?', [parentId]);
      if (!parent || parent.parent_id) return res.status(400).json({ error: 'קטגוריית אב לא תקינה' });
    }
    // Reactivate a previously soft-deleted entry with the same name+parent, if any.
    const existing = get('SELECT id FROM business_categories WHERE name = ? AND ifnull(parent_id,\'\') = ifnull(?,\'\')', [name, parentId]);
    if (existing) {
      run('UPDATE business_categories SET active = 1 WHERE id = ?', [existing.id]);
      return res.status(201).json(get('SELECT id, name, parent_id FROM business_categories WHERE id = ?', [existing.id]));
    }
    const maxRow = get('SELECT MAX(sort_order) AS m FROM business_categories WHERE ifnull(parent_id,\'\') = ifnull(?,\'\')', [parentId]);
    const sort = (maxRow && maxRow.m != null ? maxRow.m : 0) + 1;
    const id = uuidv4();
    run('INSERT INTO business_categories (id,name,parent_id,sort_order,active) VALUES (?,?,?,?,1)', [id, name, parentId, sort]);
    res.status(201).json(get('SELECT id, name, parent_id FROM business_categories WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/categories/:id — rename.
router.put('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'יש להזין שם קטגוריה' });
    run('UPDATE business_categories SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json(get('SELECT id, name, parent_id FROM business_categories WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id — soft-delete (active=0). A main also hides its
// subs. Soft-delete so the idempotent boot seed does not resurrect removals.
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('UPDATE business_categories SET active = 0 WHERE id = ? OR parent_id = ?', [req.params.id, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
