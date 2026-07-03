// Simple JSON-file storage. No database setup needed.
// Each user's data lives in data/users.json, keyed by Discord ID.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'users.json');

function loadAll() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read users.json, starting fresh:', err.message);
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUser(discordId) {
  const all = loadAll();
  return all[discordId] || null;
}

function setUser(discordId, patch) {
  const all = loadAll();
  all[discordId] = { ...(all[discordId] || {}), ...patch };
  saveAll(all);
  return all[discordId];
}

function deleteUser(discordId) {
  const all = loadAll();
  delete all[discordId];
  saveAll(all);
}

module.exports = { getUser, setUser, deleteUser };
