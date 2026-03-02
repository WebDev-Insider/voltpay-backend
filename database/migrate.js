const pool = require('./config');

async function createTables() {
  const client = await pool.connect();
  
  try {
    console.log('Creating database tables...');
    
    // Create countries table
    await client.query(`
      CREATE TABLE IF NOT EXISTS countries (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(3) NOT NULL UNIQUE,
        dial_code VARCHAR(10) NOT NULL,
        mobile_number_digit INTEGER DEFAULT 10,
        status INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        image_src VARCHAR(255) DEFAULT ''
      )
    `);
    
    // Create languages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS languages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        code VARCHAR(5) NOT NULL UNIQUE,
        image VARCHAR(100) DEFAULT '',
        status INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create language_translations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS language_translations (
        id SERIAL PRIMARY KEY,
        language_code VARCHAR(5) NOT NULL,
        translation_key VARCHAR(100) NOT NULL,
        translation_value TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (language_code) REFERENCES languages(code) ON DELETE CASCADE,
        UNIQUE(language_code, translation_key)
      )
    `);
    
    // Create settings table for general app settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Database tables created successfully!');
    
  } catch (error) {
    console.error('❌ Error creating tables:', error);
  } finally {
    client.release();
  }
}

// Run migration
createTables()
  .then(() => {
    console.log('Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
