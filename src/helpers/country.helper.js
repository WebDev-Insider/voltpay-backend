function getCountryByCode(countryCode) {
  const countries = [
    { id: 1, name: 'Nigeria', code: 'NG', dial_code: '234', image_src: 'ng.png' },
    { id: 2, name: 'Ghana', code: 'GH', dial_code: '233', image_src: 'gh.png' },
    { id: 3, name: 'Kenya', code: 'KE', dial_code: '254', image_src: 'ke.png' },
    { id: 4, name: 'South Africa', code: 'ZA', dial_code: '27', image_src: 'za.png' },
    { id: 5, name: 'Egypt', code: 'EG', dial_code: '20', image_src: 'eg.png' },
    { id: 6, name: 'Morocco', code: 'MA', dial_code: '212', image_src: 'ma.png' },
    { id: 7, name: 'Tunisia', code: 'TN', dial_code: '216', image_src: 'tn.png' },
    { id: 8, name: 'Algeria', code: 'DZ', dial_code: '213', image_src: 'dz.png' },
    { id: 9, name: 'Ethiopia', code: 'ET', dial_code: '251', image_src: 'et.png' }
  ];
  return countries.find(c => c.code === countryCode) || { id: 0, name: 'Unknown', code: 'XX', dial_code: '0', image_src: 'default.png' };
}

module.exports = { getCountryByCode };
