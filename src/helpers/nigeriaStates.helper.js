// The 36 Nigerian states plus the Federal Capital Territory, with capitals.
// Signup accepts a state only if it appears here - the client picker and this
// list must agree, so the same list is mirrored in
// lib/core/utils/nigeria_states.dart. It has not changed since 1996.
const NIGERIA_STATES = [
  { state: 'Abia', capital: 'Umuahia' },
  { state: 'Adamawa', capital: 'Yola' },
  { state: 'Akwa Ibom', capital: 'Uyo' },
  { state: 'Anambra', capital: 'Awka' },
  { state: 'Bauchi', capital: 'Bauchi' },
  { state: 'Bayelsa', capital: 'Yenagoa' },
  { state: 'Benue', capital: 'Makurdi' },
  { state: 'Borno', capital: 'Maiduguri' },
  { state: 'Cross River', capital: 'Calabar' },
  { state: 'Delta', capital: 'Asaba' },
  { state: 'Ebonyi', capital: 'Abakaliki' },
  { state: 'Edo', capital: 'Benin City' },
  { state: 'Ekiti', capital: 'Ado Ekiti' },
  { state: 'Enugu', capital: 'Enugu' },
  { state: 'Gombe', capital: 'Gombe' },
  { state: 'Imo', capital: 'Owerri' },
  { state: 'Jigawa', capital: 'Dutse' },
  { state: 'Kaduna', capital: 'Kaduna' },
  { state: 'Kano', capital: 'Kano' },
  { state: 'Katsina', capital: 'Katsina' },
  { state: 'Kebbi', capital: 'Birnin Kebbi' },
  { state: 'Kogi', capital: 'Lokoja' },
  { state: 'Kwara', capital: 'Ilorin' },
  { state: 'Lagos', capital: 'Ikeja' },
  { state: 'Nasarawa', capital: 'Lafia' },
  { state: 'Niger', capital: 'Minna' },
  { state: 'Ogun', capital: 'Abeokuta' },
  { state: 'Ondo', capital: 'Akure' },
  { state: 'Osun', capital: 'Osogbo' },
  { state: 'Oyo', capital: 'Ibadan' },
  { state: 'Plateau', capital: 'Jos' },
  { state: 'Rivers', capital: 'Port Harcourt' },
  { state: 'Sokoto', capital: 'Sokoto' },
  { state: 'Taraba', capital: 'Jalingo' },
  { state: 'Yobe', capital: 'Damaturu' },
  { state: 'Zamfara', capital: 'Gusau' },
  { state: 'Federal Capital Territory', capital: 'Abuja' },
];

const BY_NAME = new Map(NIGERIA_STATES.map(s => [s.state.toLowerCase(), s]));
// Older rows and hand-typed input use these spellings for the FCT.
BY_NAME.set('fct', BY_NAME.get('federal capital territory'));
BY_NAME.set('abuja', BY_NAME.get('federal capital territory'));

function isNigerianState(name) {
  return BY_NAME.has(String(name ?? '').trim().toLowerCase());
}

// Returns the canonical spelling so every row stores the same string.
function canonicalNigerianState(name) {
  const found = BY_NAME.get(String(name ?? '').trim().toLowerCase());
  return found ? found.state : '';
}

module.exports = { NIGERIA_STATES, isNigerianState, canonicalNigerianState };
