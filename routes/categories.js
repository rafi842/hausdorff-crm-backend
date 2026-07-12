const express = require('express');
const router = express.Router();
const { all } = require('../database');
const { authMiddleware } = require('../middleware/auth');

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

module.exports = router;
