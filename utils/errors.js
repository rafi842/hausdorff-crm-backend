// Never hand a raw error to the client. err.message on a 500 leaks internals —
// SQL text, file paths, library stack detail — which is reconnaissance for an
// attacker and noise for a user. Log the real error where the operator can see it
// (Railway logs), and return a generic message in production. In development the
// real message still comes through so debugging isn't blindfolded.
function safeError(err) {
  console.error('[server error]', err && err.stack ? err.stack : err);
  if (process.env.NODE_ENV === 'production') return 'שגיאת שרת. נסה שוב מאוחר יותר.';
  return err && err.message ? err.message : 'Server error';
}

module.exports = { safeError };
