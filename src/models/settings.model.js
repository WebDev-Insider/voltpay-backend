const prisma = require('../../database/prisma');

async function getDefaultCountryCode() {
  const row = await prisma.appSetting.findUnique({
    where: { setting_key: 'default_country_code' },
    select: { setting_value: true },
  });
  return row?.setting_value || 'NG';
}

async function getActiveCountries() {
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
}

async function getLanguageImagePath() {
  const row = await prisma.appSetting.findUnique({
    where: { setting_key: 'language_image_path' },
    select: { setting_value: true },
  });
  return row?.setting_value || 'images/languages';
}

async function getActiveLanguages() {
  const rows = await prisma.language.findMany({
    where: { status: 1 },
    select: { name: true, code: true, image: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

async function getTranslationsByCode(code) {
  const rows = await prisma.languageTranslation.findMany({
    where: { language_code: code },
    select: { translation_key: true, translation_value: true },
  });
  return rows;
}

async function getEnglishTranslations() {
  const rows = await prisma.languageTranslation.findMany({
    where: { language_code: 'en' },
    select: { translation_key: true, translation_value: true },
  });
  return rows;
}

async function getAllSettings() {
  const rows = await prisma.appSetting.findMany({
    select: { setting_key: true, setting_value: true },
  });
  return rows;
}

module.exports = {
  getDefaultCountryCode,
  getActiveCountries,
  getLanguageImagePath,
  getActiveLanguages,
  getTranslationsByCode,
  getEnglishTranslations,
  getAllSettings,
};
