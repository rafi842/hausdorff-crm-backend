const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { safeError } = require('../utils/errors');
const { resolveOccupancyStatus } = require('../utils/occupancy');

router.get('/', authMiddleware, (req, res) => {
  try {
    const { search, status, type, city, min_price, max_price, min_area, max_area, project_id, has_tenant } = req.query;
    let query = `SELECT p.*, proj.name as project_name, oc.first_name || ' ' || oc.last_name as owner_name FROM properties p LEFT JOIN projects proj ON p.project_id = proj.id LEFT JOIN contacts oc ON p.owner_id = oc.id WHERE 1=1`;
    const params = [];

    if (search) {
      query += ' AND (p.address LIKE ? OR p.city LIKE ? OR p.neighborhood LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status) { query += ' AND p.status = ?'; params.push(status); }
    if (type) { query += ' AND p.type = ?'; params.push(type); }
    if (city) { query += ' AND p.city = ?'; params.push(city); }
    if (min_price) { query += ' AND p.price >= ?'; params.push(parseInt(min_price)); }
    if (max_price) { query += ' AND p.price <= ?'; params.push(parseInt(max_price)); }
    if (min_area) { query += ' AND p.area >= ?'; params.push(parseInt(min_area)); }
    if (max_area) { query += ' AND p.area <= ?'; params.push(parseInt(max_area)); }
    if (project_id) { query += ' AND p.project_id = ?'; params.push(project_id); }
    if (has_tenant !== undefined) { query += ' AND p.has_tenant = ?'; params.push(has_tenant === 'true' ? 1 : 0); }
    if (req.query.owner_id) { query += ' AND p.owner_id = ?'; params.push(req.query.owner_id); }
    query += ' ORDER BY p.created_at DESC';

    const rows = all(query, params).map(p => ({ ...p, occupancy_status: resolveOccupancyStatus(p) }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const property = get(`
      SELECT p.*, proj.name as project_name, c.name as company_name,
        oc.first_name || ' ' || oc.last_name as owner_name
      FROM properties p
      LEFT JOIN projects proj ON p.project_id = proj.id
      LEFT JOIN companies c ON proj.company_id = c.id
      LEFT JOIN contacts oc ON p.owner_id = oc.id
      WHERE p.id = ?
    `, [req.params.id]);
    if (!property) return res.status(404).json({ error: 'Property not found' });

    // Attach attachments
    const attachments = all(`SELECT * FROM attachments WHERE entity_type='property' AND entity_id=? ORDER BY created_at DESC`, [req.params.id]);
    const files = all(`SELECT * FROM property_files WHERE property_id=? ORDER BY uploaded_at DESC`, [req.params.id]);
    res.json({ ...property, occupancy_status: resolveOccupancyStatus(property), attachments, property_files: files });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const id = uuidv4();
    const {
      project_id, address, city, neighborhood, type, status,
      price, area, rooms, floor, total_floors, parking, storage, balcony, elevator,
      description, land_use, zoning_plan, land_area_dunams,
      has_tenant, monthly_rent, annual_yield, tenant_name, lease_start_date, lease_end_date,
      exclusivity, deal_type, owner_id,
      unit_number, designated_category, frontage, rent_per_sqm, management_fee, is_anchor,
      area_gross, area_net, floor_label,
      target_profile, internal_note, turnover_pct, min_turnover,
      occupancy_status, occupancy_status_manual, map_polygon
    } = req.body;
    const now = new Date().toISOString();
    run(`INSERT INTO properties (id,project_id,address,city,neighborhood,type,status,price,area,rooms,floor,total_floors,parking,storage,balcony,elevator,description,land_use,zoning_plan,land_area_dunams,has_tenant,monthly_rent,annual_yield,tenant_name,lease_start_date,lease_end_date,exclusivity,deal_type,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, project_id||null, address, city, neighborhood||'', type||'משרד', status||'זמין',
       price||0, area||0, rooms||0, floor||0, total_floors||0,
       parking||0, storage||0, balcony||0, elevator||0, description||'',
       land_use||'', zoning_plan||'', land_area_dunams||0,
       has_tenant ? 1 : 0, monthly_rent||0, annual_yield||0,
       tenant_name||'', lease_start_date||'', lease_end_date||'',
       exclusivity ? 1 : 0, deal_type||'מכירה', owner_id||null, now, now]);
    run(`UPDATE properties SET unit_number=?,designated_category=?,frontage=?,rent_per_sqm=?,management_fee=?,is_anchor=?,area_gross=?,area_net=?,floor_label=?,target_profile=?,internal_note=?,turnover_pct=?,min_turnover=?,occupancy_status=?,occupancy_status_manual=?,map_polygon=? WHERE id=?`,
      [unit_number||'', designated_category||'', frontage||0, rent_per_sqm||0, management_fee||0, is_anchor ? 1 : 0, area_gross||0, area_net||0, floor_label||'',
       target_profile||'', internal_note||'', turnover_pct||0, min_turnover||0, occupancy_status||'', occupancy_status_manual ? 1 : 0, map_polygon||'', id]);
    res.status(201).json(get('SELECT * FROM properties WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const {
      project_id, address, city, neighborhood, type, status,
      price, area, rooms, floor, total_floors, parking, storage, balcony, elevator,
      description, land_use, zoning_plan, land_area_dunams,
      has_tenant, monthly_rent, annual_yield, tenant_name, lease_start_date, lease_end_date,
      exclusivity, deal_type, owner_id,
      unit_number, designated_category, frontage, rent_per_sqm, management_fee, is_anchor,
      area_gross, area_net, floor_label,
      target_profile, internal_note, turnover_pct, min_turnover,
      occupancy_status, occupancy_status_manual, map_polygon
    } = req.body;
    const now = new Date().toISOString();
    run(`UPDATE properties SET project_id=?,address=?,city=?,neighborhood=?,type=?,status=?,price=?,area=?,rooms=?,floor=?,total_floors=?,parking=?,storage=?,balcony=?,elevator=?,description=?,land_use=?,zoning_plan=?,land_area_dunams=?,has_tenant=?,monthly_rent=?,annual_yield=?,tenant_name=?,lease_start_date=?,lease_end_date=?,exclusivity=?,deal_type=?,owner_id=?,updated_at=? WHERE id=?`,
      [project_id||null, address, city, neighborhood||'', type||'משרד', status||'זמין',
       price||0, area||0, rooms||0, floor||0, total_floors||0,
       parking||0, storage||0, balcony||0, elevator||0, description||'',
       land_use||'', zoning_plan||'', land_area_dunams||0,
       has_tenant ? 1 : 0, monthly_rent||0, annual_yield||0,
       tenant_name||'', lease_start_date||'', lease_end_date||'',
       exclusivity ? 1 : 0, deal_type||'מכירה', owner_id||null, now, req.params.id]);
    run(`UPDATE properties SET unit_number=?,designated_category=?,frontage=?,rent_per_sqm=?,management_fee=?,is_anchor=?,area_gross=?,area_net=?,floor_label=?,target_profile=?,internal_note=?,turnover_pct=?,min_turnover=?,occupancy_status=?,occupancy_status_manual=?,map_polygon=? WHERE id=?`,
      [unit_number||'', designated_category||'', frontage||0, rent_per_sqm||0, management_fee||0, is_anchor ? 1 : 0, area_gross||0, area_net||0, floor_label||'',
       target_profile||'', internal_note||'', turnover_pct||0, min_turnover||0, occupancy_status||'', occupancy_status_manual ? 1 : 0, map_polygon||'', req.params.id]);
    res.json(get('SELECT * FROM properties WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    run('DELETE FROM properties WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PUT /:id/polygon — save only the traced map polygon (avoids clobbering the
// full unit record when the floor-plan editor saves a shape).
router.put('/:id/polygon', authMiddleware, (req, res) => {
  try {
    run('UPDATE properties SET map_polygon = ? WHERE id = ?', [req.body.map_polygon || '', req.params.id]);
    res.json(get('SELECT * FROM properties WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// PUT /:id/marketing-plan — save only the unit's marketing-plan image (data URI).
router.put('/:id/marketing-plan', authMiddleware, (req, res) => {
  try {
    run('UPDATE properties SET marketing_plan = ? WHERE id = ?', [req.body.marketing_plan || '', req.params.id]);
    res.json(get('SELECT * FROM properties WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// POST smart match for property — find matching contacts
router.post('/:id/smart-match', authMiddleware, (req, res) => {
  try {
    const prop = get('SELECT * FROM properties WHERE id = ?', [req.params.id]);
    if (!prop) return res.status(404).json({ error: 'Property not found' });

    const contacts = all(`SELECT * FROM contacts WHERE status = 'פעיל'`);

    const scored = contacts.map(contact => {
      let score = 0;
      const reasons = [];
      const preferredAreas = JSON.parse(contact.preferred_areas || '[]');

      // Location (40 pts)
      if (preferredAreas.length > 0 && preferredAreas.some(a => (prop.city||'').includes(a) || (prop.neighborhood||'').includes(a))) {
        score += 40; reasons.push('מיקום מתאים');
      }

      // Price (30 pts)
      if (contact.budget_min > 0 || contact.budget_max > 0) {
        if (prop.price >= (contact.budget_min || 0) && (contact.budget_max === 0 || prop.price <= contact.budget_max)) {
          score += 30; reasons.push('מחיר בטווח התקציב');
        } else if (contact.budget_max > 0 && prop.price <= contact.budget_max * 1.1) {
          score += 15; reasons.push('מחיר קרוב לתקציב');
        }
      } else { score += 15; }

      // Area (15 pts)
      if (contact.min_area > 0 || contact.max_area > 0) {
        if (prop.area >= (contact.min_area || 0) && (contact.max_area === 0 || prop.area <= contact.max_area)) {
          score += 15; reasons.push('גודל מתאים');
        }
      } else { score += 10; }

      // Rooms (15 pts)
      if (contact.min_rooms > 0 || contact.max_rooms > 0) {
        if (prop.rooms >= (contact.min_rooms || 0) && (contact.max_rooms === 0 || prop.rooms <= contact.max_rooms)) {
          score += 15; reasons.push('מספר חדרים מתאים');
        }
      } else { score += 10; }

      // Yield match
      if (contact.desired_yield > 0 && prop.annual_yield >= contact.desired_yield) {
        score = Math.max(score, 80);
        reasons.push(`תשואה ${prop.annual_yield}% >= ${contact.desired_yield}% המבוקש`);
      }

      return {
        id: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        phone: contact.phone, email: contact.email, type: contact.type,
        budget_min: contact.budget_min, budget_max: contact.budget_max,
        match_score: score, match_reasons: reasons,
      };
    });

    scored.sort((a, b) => b.match_score - a.match_score);
    res.json(scored.filter(c => c.match_score >= 50));
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /:id/chain-match — commercial: retail chains matching this unit by
// category, size and budget.
router.get('/:id/chain-match', authMiddleware, (req, res) => {
  try {
    const unit = get('SELECT * FROM properties WHERE id = ?', [req.params.id]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    // Resolve the main category of the unit's designated sub-category.
    let unitMain = '';
    if (unit.designated_category) {
      const sub = get('SELECT parent_id FROM business_categories WHERE name = ? AND parent_id IS NOT NULL', [unit.designated_category]);
      if (sub && sub.parent_id) {
        const main = get('SELECT name FROM business_categories WHERE id = ?', [sub.parent_id]);
        unitMain = main ? main.name : '';
      }
    }

    const chains = all(`SELECT * FROM companies WHERE (business_category != '' OR business_subcategory != '') AND chain_status != 'לא רלוונטי'`);
    const scored = chains.map(ch => {
      let score = 0; const reasons = [];
      // Category (primary, up to 60)
      if (unit.designated_category && ch.business_subcategory === unit.designated_category) {
        score += 60; reasons.push('קטגוריה מדויקת');
      } else if (unitMain && ch.business_category === unitMain) {
        score += 40; reasons.push('קטגוריה ראשית תואמת');
      }
      // Size (up to 25) — matched on gross area
      const uArea = unit.area_gross || unit.area || 0;
      const min = ch.target_area_min || 0, max = ch.target_area_max || 0;
      if (uArea && (min || max)) {
        if ((!min || uArea >= min) && (!max || uArea <= max)) { score += 25; reasons.push('שטח מתאים'); }
        else if (max && uArea <= max * 1.15) { score += 10; reasons.push('שטח קרוב'); }
      } else if (uArea) { score += 10; }
      // Budget (up to 15)
      if (unit.rent_per_sqm && ch.rent_budget_per_sqm) {
        if (unit.rent_per_sqm <= ch.rent_budget_per_sqm) { score += 15; reasons.push('בתקציב'); }
      } else { score += 5; }
      return {
        id: ch.id, name: ch.name,
        business_category: ch.business_category, business_subcategory: ch.business_subcategory,
        chain_status: ch.chain_status, branch_count: ch.branch_count, phone: ch.phone,
        match_score: score, match_reasons: reasons,
      };
    }).filter(c => c.match_score >= 40).sort((a, b) => b.match_score - a.match_score);

    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

module.exports = router;
