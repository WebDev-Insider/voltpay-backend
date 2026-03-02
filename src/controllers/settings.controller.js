const SettingsModel = require('../models/settings.model');

async function getCountries(req, res) {
  try {
    const defaultCountryCode = await SettingsModel.getDefaultCountryCode();
    const countries = await SettingsModel.getActiveCountries();

    const response = {
      remark: 'country_list',
      status: 'success',
      message: ['Country list fetched successfully'],
      data: {
        selected_country_code: defaultCountryCode,
        countries: countries.map(country => ({
          id: country.id,
          name: country.name,
          code: country.code,
          dial_code: country.dial_code,
          mobile_number_digit: country.mobile_number_digit.toString(),
          status: country.status,
          created_at: country.created_at,
          updated_at: country.updated_at,
          image_src: country.image_src
        }))
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching countries (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch countries'],
      data: null
    });
  }
}

async function getLanguage(req, res) {
  try {
    const { code } = req.params;
    const imagePath = await SettingsModel.getLanguageImagePath();
    const languages = await SettingsModel.getActiveLanguages();
    let translations = await SettingsModel.getTranslationsByCode(code);

    const translationsObj = {};
    if (!translations || translations.length === 0) {
      if (code !== 'en') {
        translations = await SettingsModel.getEnglishTranslations();
      }
    }
    (translations || []).forEach(row => {
      translationsObj[row.translation_key] = row.translation_value;
    });

    const response = {
      remark: 'language',
      status: 'success',
      message: ['Language fetched successfully'],
      data: {
        image_path: imagePath,
        languages: languages,
        file: translationsObj
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching language (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch language data'],
      data: null
    });
  }
}

async function getGeneralSetting(req, res) {
  try {
    const settingsRows = await SettingsModel.getAllSettings();
    const settings = {};
    settingsRows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });

    const response = {
      remark: 'general_setting',
      status: 'success',
      message: ['General settings fetched successfully'],
      data: {
        general_setting: {
          cur_text: 'NGN',
          cur_sym: '₦',
          app_name: 'VoltPay',
          app_version: settings.app_version || '1.0.0',
          maintenance_mode: settings.maintenance_mode === 'true'
        }
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching general settings (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch general settings'],
      data: null
    });
  }
}

async function getModuleSetting(req, res) {
  const response = {
    remark: 'module_setting',
    status: 'success',
    message: ['Module settings fetched successfully'],
    data: {
      module_setting: {
        user: [
          { slug: 'send_money', status: '1' },
          { slug: 'request_money', status: '1' },
          { slug: 'cash_out', status: '1' },
          { slug: 'bill_payment', status: '1' },
          { slug: 'mobile_recharge', status: '1' },
          { slug: 'fund_account', status: '1' }
        ]
      }
    }
  };
  return res.json(response);
}

module.exports = { getCountries, getLanguage, getGeneralSetting, getModuleSetting };
