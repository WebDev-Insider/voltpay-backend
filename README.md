# VoltPay API Backend

A Node.js/Express API service for the OvoPay Flutter application with PostgreSQL database integration.

## Features

- **Country API**: Get list of countries with dial codes and mobile number formats
- **Language API**: Multi-language support with translations
- **General Settings**: App configuration and settings
- **Module Settings**: Feature toggles and module configurations
- **Health Check**: Database connectivity monitoring

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Setup Instructions

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Database Setup

1. **Create PostgreSQL Database**:
   ```sql
   CREATE DATABASE ovopay_db;
   ```

2. **Configure Environment Variables**:
   Update the `.env` file with your database credentials:
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=ovopay_db
   DB_USER=postgres
   DB_PASSWORD=your_password_here
   ```

3. **Run Database Migration**:
   ```bash
   npm run db:migrate
   ```

4. **Seed Initial Data**:
   ```bash
   npm run db:seed
   ```

### 3. Start the Server

**Development Mode** (with auto-restart):
```bash
npm run dev
```

**Production Mode**:
```bash
npm start
```

The server will start on `http://localhost:3000`

## API Endpoints

### Countries
- **GET** `/api/get-countries` - Get list of all countries

### Languages
- **GET** `/api/language/:code` - Get language translations (e.g., `/api/language/en`)

### Settings
- **GET** `/api/general-setting` - Get general app settings
- **GET** `/api/module-setting` - Get module configurations

### Health Check
- **GET** `/health` - Check server and database status

## Database Schema

### Tables Created:
- `countries` - Country information with dial codes
- `languages` - Supported languages
- `language_translations` - Translation key-value pairs
- `app_settings` - General application settings

## Sample Data Included

### Countries (15 countries):
- United States, United Kingdom, Canada, Nigeria, Ghana, South Africa, Australia, Germany, France, India, Brazil, Mexico, Japan, China, Kenya

### Languages (5 languages):
- English (en), French (fr), Spanish (es), German (de), Portuguese (pt)

### Translations:
- Basic UI translations for multiple languages
- Easily extensible for more translation keys

## Configuration

### Environment Variables:
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment mode
- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port
- `DB_NAME` - Database name
- `DB_USER` - Database username
- `DB_PASSWORD` - Database password
- `API_PREFIX` - API route prefix (default: /api)

## Redis (Upstash)

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to turn on caching,
shared rate-limit/lockout counters and the pending-confirmation store. Leave
them unset and everything falls back to Postgres or in-process memory - the API
works either way. `GET /health` reports `redis: connected | unreachable |
disabled`.

**Put Upstash in the same region as the API host.** A cache only helps if the
round trip to Redis is shorter than the query it replaces. Measured from a
developer laptop in Nigeria against `us-east-*`, Upstash and Neon were the same
distance away - median 252 ms to Redis vs 224 ms for `SELECT 1` - so the user
cache would have *cost* time there. On a server sitting next to the Upstash
region, the same lookup is single-digit milliseconds. Measure before trusting
it:

```bash
node -e "require('dotenv').config({path:'.env'});const r=require('./src/services/redis.service');(async()=>{for(let i=0;i<8;i++){const t=Date.now();await r.ping();console.log(Date.now()-t)}})()"
```

If Redis turns out to be the slower hop, set `USER_CACHE_TTL_SECONDS=0` to
disable the per-request user cache while keeping the counters and the pending
store, which are about correctness across instances rather than speed.

Tuning knobs: `USER_CACHE_TTL_SECONDS` (default 15),
`REFERENCE_CACHE_TTL_SECONDS` (default 600), `REDIS_TIMEOUT_MS` (default 1200).

## Development

### Adding New Countries:
```sql
INSERT INTO countries (name, code, dial_code, mobile_number_digit, status)
VALUES ('Country Name', 'CC', 'XXX', 10, 1);
```

### Adding New Languages:
```sql
INSERT INTO languages (name, code, image, status)
VALUES ('Language Name', 'lang_code', 'flag.png', 1);
```

### Adding Translations:
```sql
INSERT INTO language_translations (language_code, translation_key, translation_value)
VALUES ('en', 'new_key', 'Translation Value');
```

## Testing

Test the API endpoints:

```bash
# Test countries endpoint
curl http://localhost:3000/api/get-countries

# Test language endpoint
curl http://localhost:3000/api/language/en

# Test health check
curl http://localhost:3000/health
```

## Deployment

For production deployment:

1. Set `NODE_ENV=production` in your environment
2. Configure production database credentials
3. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "VoltPay-api"
   ```

## Troubleshooting

### Database Connection Issues:
- Verify PostgreSQL is running
- Check database credentials in `.env`
- Ensure database exists and is accessible

### Port Already in Use:
- Change the `PORT` in `.env` file
- Or kill the process using the port: `lsof -ti:3000 | xargs kill`

## License

MIT License



for /f "tokens=5" %a in ('netstat -aon ^| findstr :3000') do taskkill /f /pid %a