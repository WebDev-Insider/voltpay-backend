const pool = require('./config');

async function seedDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('Seeding database with initial data...');
    
    // Seed countries - Focus on African countries
    const countries = [
      { name: 'Nigeria', code: 'NG', dial_code: '234', mobile_number_digit: 11 },
      { name: 'Ghana', code: 'GH', dial_code: '233', mobile_number_digit: 10 },
      { name: 'Kenya', code: 'KE', dial_code: '254', mobile_number_digit: 9 },
      { name: 'South Africa', code: 'ZA', dial_code: '27', mobile_number_digit: 9 },
      { name: 'Egypt', code: 'EG', dial_code: '20', mobile_number_digit: 10 },
      { name: 'Morocco', code: 'MA', dial_code: '212', mobile_number_digit: 9 },
      { name: 'Tunisia', code: 'TN', dial_code: '216', mobile_number_digit: 8 },
      { name: 'Algeria', code: 'DZ', dial_code: '213', mobile_number_digit: 9 },
      { name: 'Ethiopia', code: 'ET', dial_code: '251', mobile_number_digit: 9 },
      { name: 'Tanzania', code: 'TZ', dial_code: '255', mobile_number_digit: 9 },
      { name: 'Uganda', code: 'UG', dial_code: '256', mobile_number_digit: 9 },
      { name: 'Rwanda', code: 'RW', dial_code: '250', mobile_number_digit: 9 },
      { name: 'Senegal', code: 'SN', dial_code: '221', mobile_number_digit: 9 },
      { name: 'Ivory Coast', code: 'CI', dial_code: '225', mobile_number_digit: 10 },
      { name: 'Cameroon', code: 'CM', dial_code: '237', mobile_number_digit: 9 },
      { name: 'Zambia', code: 'ZM', dial_code: '260', mobile_number_digit: 9 },
      { name: 'Zimbabwe', code: 'ZW', dial_code: '263', mobile_number_digit: 9 },
      { name: 'Botswana', code: 'BW', dial_code: '267', mobile_number_digit: 8 },
      { name: 'Namibia', code: 'NA', dial_code: '264', mobile_number_digit: 9 },
      { name: 'Mali', code: 'ML', dial_code: '223', mobile_number_digit: 8 }
    ];
    
    for (const country of countries) {
      await client.query(`
        INSERT INTO countries (name, code, dial_code, mobile_number_digit, status)
        VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          dial_code = EXCLUDED.dial_code,
          mobile_number_digit = EXCLUDED.mobile_number_digit,
          updated_at = CURRENT_TIMESTAMP
      `, [country.name, country.code, country.dial_code, country.mobile_number_digit]);
    }
    
    // Seed languages
    const languages = [
      { name: 'English', code: 'en', image: 'en.png' },
      { name: 'French', code: 'fr', image: 'fr.png' },
      { name: 'Spanish', code: 'es', image: 'es.png' },
      { name: 'German', code: 'de', image: 'de.png' },
      { name: 'Portuguese', code: 'pt', image: 'pt.png' }
    ];
    
    for (const language of languages) {
      await client.query(`
        INSERT INTO languages (name, code, image, status)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          image = EXCLUDED.image,
          updated_at = CURRENT_TIMESTAMP
      `, [language.name, language.code, language.image]);
    }
    
    // Seed English translations
    const englishTranslations = [
      { key: 'language', value: 'Language' },
      { key: 'selectCountryOfResidence', value: 'Select country of residence' },
      { key: 'phoneNumber', value: 'Phone Number' },
      { key: 'login', value: 'Login' },
      { key: 'register', value: 'Register' },
      { key: 'dashboard', value: 'Dashboard' },
      { key: 'profile', value: 'Profile' },
      { key: 'settings', value: 'Settings' },
      { key: 'logout', value: 'Logout' },
      { key: 'sendMoney', value: 'Send Money' },
      { key: 'requestMoney', value: 'Request Money' },
      { key: 'cashOut', value: 'Cash Out' },
      { key: 'billPayment', value: 'Bill Payment' },
      { key: 'mobileRecharge', value: 'Mobile Recharge' }
    ];
    
    for (const translation of englishTranslations) {
      await client.query(`
        INSERT INTO language_translations (language_code, translation_key, translation_value)
        VALUES ('en', $1, $2)
        ON CONFLICT (language_code, translation_key) DO UPDATE SET
          translation_value = EXCLUDED.translation_value,
          updated_at = CURRENT_TIMESTAMP
      `, [translation.key, translation.value]);
    }
    
    // Seed French translations
    const frenchTranslations = [
      { key: 'language', value: 'Langue' },
      { key: 'selectCountryOfResidence', value: 'Sélectionnez le pays de résidence' },
      { key: 'phoneNumber', value: 'Numéro de téléphone' },
      { key: 'login', value: 'Connexion' },
      { key: 'register', value: 'S\'inscrire' },
      { key: 'dashboard', value: 'Tableau de bord' },
      { key: 'profile', value: 'Profil' },
      { key: 'settings', value: 'Paramètres' },
      { key: 'logout', value: 'Déconnexion' },
      { key: 'sendMoney', value: 'Envoyer de l\'argent' },
      { key: 'requestMoney', value: 'Demander de l\'argent' },
      { key: 'cashOut', value: 'Retirer de l\'argent' },
      { key: 'billPayment', value: 'Paiement de factures' },
      { key: 'mobileRecharge', value: 'Recharge mobile' }
    ];
    
    for (const translation of frenchTranslations) {
      await client.query(`
        INSERT INTO language_translations (language_code, translation_key, translation_value)
        VALUES ('fr', $1, $2)
        ON CONFLICT (language_code, translation_key) DO UPDATE SET
          translation_value = EXCLUDED.translation_value,
          updated_at = CURRENT_TIMESTAMP
      `, [translation.key, translation.value]);
    }
    
    // Seed app settings
    const settings = [
      { key: 'default_country_code', value: 'US', description: 'Default country code for the app' },
      { key: 'language_image_path', value: 'images/languages', description: 'Path to language flag images' },
      { key: 'app_version', value: '1.0.0', description: 'Current app version' },
      { key: 'maintenance_mode', value: 'false', description: 'Enable/disable maintenance mode' }
    ];
    
    for (const setting of settings) {
      await client.query(`
        INSERT INTO app_settings (setting_key, setting_value, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (setting_key) DO UPDATE SET
          setting_value = EXCLUDED.setting_value,
          description = EXCLUDED.description,
          updated_at = CURRENT_TIMESTAMP
      `, [setting.key, setting.value, setting.description]);
    }
    
    console.log('✅ Database seeded successfully!');
    
  } catch (error) {
    console.error('❌ Error seeding database:', error);
  } finally {
    client.release();
  }
}

// Run seeding
seedDatabase()
  .then(() => {
    console.log('Seeding completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Seeding failed:', error);
    process.exit(1);
  });
