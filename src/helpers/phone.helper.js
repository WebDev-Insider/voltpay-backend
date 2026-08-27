// Nigerian numbers only. Accept whatever the keyboard produced - 0803...,
// 234803..., +234803..., 803... - and settle on the two forms we need:
// `local` (0803..., what the bills provider wants) and `msisdn` (234803...,
// what we show).
//
// Lived in bills.controller.js first; lifted here once StaffPay needed the
// same rule. support.controller.js still has its own string-returning variant.
function normalizeNgPhone(input) {
  const raw = String(input || '').replace(/\D/g, '');
  let local = '';
  if (raw.length === 11 && raw.startsWith('0')) local = raw;
  else if (raw.length === 13 && raw.startsWith('234')) local = `0${raw.slice(3)}`;
  else if (raw.length === 10) local = `0${raw}`;
  if (!/^0[789][01]\d{8}$/.test(local)) return null;
  return { local, msisdn: `234${local.slice(1)}` };
}

module.exports = { normalizeNgPhone };
