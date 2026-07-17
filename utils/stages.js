// Single source of truth for pipeline stages.
//
// These were duplicated in routes/deals.js and routes/dashboard.js, and the copies
// drifted: the residential→commercial conversion remapped 9 stages to 7 (8→6, 9→7,
// see the data migration in database.js) but dashboard.js kept querying the old
// numbers. Every revenue and commission KPI it served therefore read 0, because
// nothing sits at stage 8 any more, while its "active" filter (NOT IN (8,9)) let
// signed and dead deals through.
//
// frontend/src/types/index.ts holds a matching PIPELINE_STAGES list — keep in sync.

const STAGE_NAMES = {
  1: 'פנייה',
  2: 'גילוי עניין',
  3: 'פגישה',
  4: 'הצעה / עקרונות',
  5: 'מו"מ חוזה',
  6: 'חתום',
  7: 'לא רלוונטי',
};

const STAGE_SIGNED = 6;       // won — the only stage that counts as revenue
const STAGE_IRRELEVANT = 7;   // lost/dead
const STAGE_NEGOTIATION = 5;  // מו"מ חוזה — where going quiet costs a deal

// Deals still in play: neither won nor dead.
const OPEN_STAGES = [1, 2, 3, 4, 5];

// For inlining into SQL. Values are module constants, never user input.
const SQL_OPEN = `stage NOT IN (${STAGE_SIGNED}, ${STAGE_IRRELEVANT})`;
const SQL_SIGNED = `stage = ${STAGE_SIGNED}`;

module.exports = {
  STAGE_NAMES, STAGE_SIGNED, STAGE_IRRELEVANT, STAGE_NEGOTIATION,
  OPEN_STAGES, SQL_OPEN, SQL_SIGNED,
};
