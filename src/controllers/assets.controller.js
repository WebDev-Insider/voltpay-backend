function getProfileImage(req, res) {
  let { filename } = req.params;
  console.log('📥 Image request for:', filename);

  if (!filename || filename === '' || filename === '/') {
    filename = 'sample.jpg';
  }

  if (filename.startsWith('https://res.cloudinary.com/')) {
    console.log('📸 Redirecting to Cloudinary URL:', filename);
    return res.redirect(filename);
  }

  if (filename === 'sample.jpg') {
    return res.redirect('https://res.cloudinary.com/demo/image/upload/v1640995392/sample.jpg');
  }

  if (filename.includes('ovopay') || filename.includes('cloudinary')) {
    const cloudinaryUrl = `https://res.cloudinary.com/demo/image/upload/v1640995392/${filename}`;
    return res.redirect(cloudinaryUrl);
  }

  return res.redirect('https://res.cloudinary.com/demo/image/upload/v1640995392/sample.jpg');
}

function getCountryFlag(req, res) {
  const { filename } = req.params;
  console.log('📥 Country flag request for:', filename);

  const flagMappings = {
    'us.png': 'https://flagcdn.com/w320/us.png',
    'gb.png': 'https://flagcdn.com/w320/gb.png',
    'ca.png': 'https://flagcdn.com/w320/ca.png',
    'af.png': 'https://flagcdn.com/w320/af.png',
    'au.png': 'https://flagcdn.com/w320/au.png',
    'de.png': 'https://flagcdn.com/w320/de.png',
    'fr.png': 'https://flagcdn.com/w320/fr.png',
    'in.png': 'https://flagcdn.com/w320/in.png',
    'ng.png': 'https://flagcdn.com/w320/ng.png',
    'default.png': 'https://flagcdn.com/w320/un.png'
  };

  const flagUrl = flagMappings[filename] || flagMappings['default.png'];
  console.log('📥 Redirecting to flag URL:', flagUrl);
  return res.redirect(flagUrl);
}

function getDoubleSlashProfileImage(req, res) {
  const { filename } = req.params;
  console.log('📥 Double slash image request for:', filename);
  return res.redirect(`/assets/images/user/profile/${filename || 'sample.jpg'}`);
}

function getUrlEncodedProfileImage(req, res) {
  let fullPath = req.path.replace('/assets/images/user/profile/', '');
  let cloudinaryUrl = fullPath;
  if (cloudinaryUrl.startsWith('https:////')) {
    cloudinaryUrl = cloudinaryUrl.replace('https:////', 'https://');
  } else if (cloudinaryUrl.startsWith('https:///')) {
    cloudinaryUrl = cloudinaryUrl.replace('https:///', 'https://');
  } else if (cloudinaryUrl.startsWith('https://')) {
    // ok
  } else if (cloudinaryUrl.startsWith('https:')) {
    cloudinaryUrl = cloudinaryUrl.replace('https:', 'https://');
  }
  console.log('📥 URL-encoded Cloudinary request');
  console.log('📥 Original path:', req.path);
  console.log('📥 Redirecting to:', cloudinaryUrl);
  return res.redirect(cloudinaryUrl);
}

module.exports = {
  getProfileImage,
  getCountryFlag,
  getDoubleSlashProfileImage,
  getUrlEncodedProfileImage,
};
