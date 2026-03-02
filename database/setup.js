const pool = require('./config');
const fs = require('fs');
const path = require('path');

async function setupDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Setting up VoltPay database...');
    
    // Read and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    console.log('📋 Creating database schema...');
    await client.query(schemaSQL);
    console.log('✅ Database schema created successfully!');
    
    // Run seed data
    console.log('🌱 Seeding database with initial data...');
    
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
      { name: 'Spanish', code: 'es', image: 'es.png' }
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
      { key: 'sendMoney', value: 'Send Money' },
      { key: 'requestMoney', value: 'Request Money' }
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
    
    console.log('✅ Database setup completed successfully!');
    console.log('🇳🇬 Default country set to Nigeria (NG)');
    console.log('🌍 African countries loaded');
    console.log('📱 Ready for VoltPay app!');
    
  } catch (error) {
    console.error('❌ Error setting up database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run setup
setupDatabase()
  .then(() => {
    console.log('Database setup completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Database setup failed:', error);
    process.exit(1);
  });
