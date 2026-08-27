// Reference data: countries, languages, translations, app settings.
//
// Every cold app start hits all of these, they are read on public endpoints
// (no auth, so no other cache in front of them), and they change maybe once a
// month. Cached in Redis for REFERENCE_CACHE_TTL_SECONDS - a stale country
// flag for ten minutes is not a fintech problem, an extra four queries on
// every app launch is.
const prisma = require('../../database/prisma');
const redis = require('../services/redis.service');

const TTL = Number(process.env.REFERENCE_CACHE_TTL_SECONDS || 600);

async function getDefaultCountryCode() {
  return redis.cached(redis.key('ref', 'default_country'), TTL, async () => {
    const row = await prisma.appSetting.findUnique({
      where: { setting_key: 'default_country_code' },
      select: { setting_value: true },
    });
    return row?.setting_value || 'NG';
  });
}

async function getActiveCountries() {
  return redis.cached(redis.key('ref', 'countries'), TTL, async () => {
    const rows = await prisma.country.findMany({
      where: { status: 1 },
      select: {
        id: true,
        name: true,
        code: true,
        dial_code: true,
        mobile_number_digit: true,
        status: true,
        created_at: true,
        updated_at: true,
        image_src: true,
      },
      orderBy: { name: 'asc' },
    });
    // Mimic CASE ordering to prioritize NG first
    return rows.sort((a, b) => (a.code === 'NG' ? -1 : b.code === 'NG' ? 1 : a.name.localeCompare(b.name)));
  });
}

async function getLanguageImagePath() {
  return redis.cached(redis.key('ref', 'language_image_path'), TTL, async () => {
    const row = await prisma.appSetting.findUnique({
      where: { setting_key: 'language_image_path' },
      select: { setting_value: true },
    });
    return row?.setting_value || 'images/languages';
  });
}

async function getActiveLanguages() {
  return redis.cached(redis.key('ref', 'languages'), TTL, async () => {
    return prisma.language.findMany({
      where: { status: 1 },
      select: { name: true, code: true, image: true },
      orderBy: { name: 'asc' },
    });
  });
}

async function getTranslationsByCode(code) {
  return redis.cached(redis.key('ref', 'translations', String(code || '')), TTL, async () => {
    return prisma.languageTranslation.findMany({
      where: { language_code: code },
      select: { translation_key: true, translation_value: true },
    });
  });
}

async function getEnglishTranslations() {
  return getTranslationsByCode('en');
}

async function getAllSettings() {
  return redis.cached(redis.key('ref', 'app_settings'), TTL, async () => {
    return prisma.appSetting.findMany({
      select: { setting_key: true, setting_value: true },
    });
  });
}

/**
 * Call after an admin edits settings, countries or translations, otherwise the
 * change is invisible for up to TTL. Cheap enough to call unconditionally.
 */
async function invalidateReferenceCache() {
  await redis.del(
    redis.key('ref', 'default_country'),
    redis.key('ref', 'countries'),
    redis.key('ref', 'language_image_path'),
    redis.key('ref', 'languages'),
    redis.key('ref', 'app_settings'),
  );
}

module.exports = {
  getDefaultCountryCode,
  getActiveCountries,
  getLanguageImagePath,
  getActiveLanguages,
  getTranslationsByCode,
  getEnglishTranslations,
  getAllSettings,
  invalidateReferenceCache,
};
