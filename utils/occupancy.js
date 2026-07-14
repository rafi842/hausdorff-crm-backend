const { get } = require('../database');

// The four occupancy statuses of a unit (matches the developer's color legend):
//   ⬛ פנוי · 🟩 במו"מ · 🟦 חתמו תנאים · 🟥 חתום חוזה
const OCC_VACANT = 'פנוי';
const OCC_NEGOTIATION = 'במו"מ';
const OCC_TERMS = 'חתמו תנאים';
const OCC_SIGNED = 'חתום חוזה';

// Map a deal pipeline stage (1..7) to a unit occupancy status.
// Stages: 1 פנייה · 2 גילוי עניין · 3 פגישה · 4 הצעה/עקרונות · 5 מו"מ חוזה · 6 חתום · 7 לא רלוונטי
function stageToStatus(stage) {
  if (stage >= 6) return OCC_SIGNED;            // signed contract
  if (stage === 4 || stage === 5) return OCC_TERMS; // terms / principles agreed
  if (stage >= 1 && stage <= 3) return OCC_NEGOTIATION;
  return null;
}

// Derive a unit's occupancy status from the furthest-along active deal on it.
// Stage 7 (לא רלוונטי) is ignored; a unit with no active deal is vacant.
function deriveOccupancyStatus(propertyId) {
  const row = get(
    `SELECT MAX(stage) AS s FROM deals WHERE property_id = ? AND stage <> 7`,
    [propertyId]
  );
  if (!row || row.s == null) return OCC_VACANT;
  return stageToStatus(row.s) || OCC_VACANT;
}

// Effective status: a manual lock wins; otherwise it is auto-derived.
function resolveOccupancyStatus(unit) {
  if (!unit) return OCC_VACANT;
  if (unit.occupancy_status_manual && unit.occupancy_status) return unit.occupancy_status;
  return deriveOccupancyStatus(unit.id);
}

module.exports = {
  OCC_VACANT, OCC_NEGOTIATION, OCC_TERMS, OCC_SIGNED,
  stageToStatus, deriveOccupancyStatus, resolveOccupancyStatus,
};
