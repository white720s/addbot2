// Handles all browser automation against rolimons.com for the verification flow.
// One persistent browser context (session) is saved to disk per Discord user,
// so we don't need to re-verify every time.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function sessionFile(discordId) {
  return path.join(SESSIONS_DIR, `${discordId}.json`);
}

const SHOW_BROWSER = process.env.SHOW_BROWSER !== 'false';

/**
 * Opens rolimons.com/verify, enters the given Roblox ID, and returns the
 * verification phrase shown on the page. Leaves the browser context open
 * and returns it so the SAME browser can later click "Complete Profile
 * Verification" (the phrase + the click must happen in the same session
 * for Rolimons to associate them correctly).
 */
async function startVerification(robloxUsername) {
  const browser = await chromium.launch({ headless: !SHOW_BROWSER });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.rolimons.com/verify', { waitUntil: 'domcontentloaded' });

  // Confirmed via DevTools: the verify page's own search box has
  // id="player_search_textbox" (distinct from the site-wide global
  // search bar, which is id="global_player_search_textbox").
  const verifyInput = page.locator('#player_search_textbox');
  await verifyInput.waitFor({ state: 'visible', timeout: 10000 });

  // The live search likely listens for real keystroke/blur events rather
  // than a single value-set, so type it out character by character (like
  // a real person typing) instead of using fill().
  await verifyInput.click();
  await verifyInput.pressSequentially(String(robloxUsername), { delay: 80 });

  // Tab out of the field, since the search/result card may only appear
  // once the field loses focus.
  await page.keyboard.press('Tab');

  // Give the live search a moment to fetch and render matching players
  // before we look for the result card.
  await page.waitForTimeout(1500);

  // The search box shows a clickable result card below it
  // (div[data-ref="player"] with an onclick handler) — we need to
  // actually click it, pressing Enter alone does not select a result.
  const resultCard = page.locator('div[data-ref="player"]').first();
  await resultCard.waitFor({ state: 'visible', timeout: 15000 });
  await resultCard.click();

  // Give the page a moment to load the verification phrase section
  // after selecting the player.
  await page.waitForTimeout(2000);

  // Wait for the phrase box to populate.
  // Confirmed via DevTools: it's a <textarea id="verification_phrase_textbox">,
  // not an <input> as originally guessed.
  await page.waitForSelector('#verification_phrase_textbox', { timeout: 15000 });
  const phrase = await page.inputValue('#verification_phrase_textbox');

  // Make sure "Verify On Profile" mode is selected (vs in-game).
  const verifyOnProfileBtn = page.locator('text=Verify On Profile').first();
  if (await verifyOnProfileBtn.isVisible().catch(() => false)) {
    await verifyOnProfileBtn.click();
  }

  return { browser, context, page, phrase };
}

/**
 * Clicks "Complete Profile Verification" on an already-open verify page.
 * Returns true/false for success, and saves the browser's storage state
 * (cookies, session) to disk if successful so we can reuse it later.
 */
async function confirmVerification(discordId, page, context, browser) {
  try {
    const confirmBtn = page.locator('text=Complete Profile Verification').first();
    await confirmBtn.click();

    // Wait for either a success indicator or an error message.
    const result = await Promise.race([
      page.waitForSelector('text=Verified!', { timeout: 15000 }).then(() => 'success'),
      page.waitForSelector('text=error', { timeout: 15000 }).then(() => 'error'),
    ]).catch(() => 'timeout');

    if (result === 'success') {
      await context.storageState({ path: sessionFile(discordId) });
      await browser.close();
      return true;
    }

    await browser.close();
    return false;
  } catch (err) {
    console.error('confirmVerification error:', err.message);
    await browser.close().catch(() => {});
    return false;
  }
}

/**
 * Loads a saved session for a user and returns a ready-to-use page,
 * already logged in. Returns null if no session exists or it's expired.
 */
async function loadSession(discordId) {
  const file = sessionFile(discordId);
  if (!fs.existsSync(file)) return null;

  const browser = await chromium.launch({ headless: !SHOW_BROWSER });
  const context = await browser.newContext({ storageState: file });
  const page = await context.newPage();

  await page.goto('https://www.rolimons.com/tradeadcreate', { waitUntil: 'domcontentloaded' });

  // If the nav shows "Verify Your Account" instead of "My Profile",
  // the session has expired and the user needs to log in again.
  const loggedOut = await page.locator('text=Verify Your Account').isVisible().catch(() => false);
  if (loggedOut) {
    await browser.close();
    return null;
  }

  return { browser, context, page };
}

function hasSession(discordId) {
  return fs.existsSync(sessionFile(discordId));
}

module.exports = { startVerification, confirmVerification, loadSession, hasSession };
