let currentUser = null;

function getCurrentUser() {
  return currentUser;
}

function setCurrentUser(user) {
  currentUser = user ? { ...user } : null;
}

module.exports = { getCurrentUser, setCurrentUser };
