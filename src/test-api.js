// Standalone test script — run this directly to see exactly what
// Rolimons' API returns, BEFORE we wire it into the actual bot commands.
//
// Usage:  node src/test-api.js YourRobloxUsername
//
// This prints raw responses so we can confirm the real shape of the
// data and fix any mismatches in rolimons-api.js with certainty.

const username = process.argv[2];

if (!username) {
  console.log('Usage: node src/test-api.js YourRobloxUsername');
  process.exit(1);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.rolimons.com/',
};

(async () => {
  console.log('--- TEST 1: Item catalog (first 3 items) ---');
  try {
    const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
    console.log('Status:', res.status);
    const data = await res.json();
    const entries = Object.entries(data.items || {}).slice(0, 3);
    console.log(JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  console.log('\n--- TEST 2: Player search ---');
  let playerId = null;
  try {
    const res = await fetch(
      `https://api.rolimons.com/players/v1/playersearch?searchstring=${encodeURIComponent(username)}`,
      { headers: HEADERS }
    );
    console.log('Status:', res.status);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    playerId = data.players?.[0]?.[0];
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  if (!playerId) {
    console.log('\nNo player ID found, skipping inventory test.');
    return;
  }

  console.log(`\n--- TEST 3: Player inventory (id ${playerId}) ---`);
  try {
    const res = await fetch(`https://api.rolimons.com/players/v1/playerassets/${playerId}`, {
      headers: HEADERS,
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Raw response (first 1500 chars):');
    console.log(text.slice(0, 1500));
  } catch (err) {
    console.error('FAILED:', err.message);
  }
  console.log('\n--- TEST 4: Catalog lookup for item 1365767 ---');
  try {
    const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
    const data = await res.json();
    console.log('Catalog entry for "1365767":', JSON.stringify(data.items['1365767']));

    // Also search for "Valkyrie Helm" by name to find its REAL id.
    const valkEntry = Object.entries(data.items || {}).find(
      ([, fields]) => fields[0] && fields[0].toLowerCase().includes('valkyrie helm')
    );
    console.log('Catalog entry whose NAME is "Valkyrie Helm":', JSON.stringify(valkEntry));
  } catch (err) {
    console.error('FAILED:', err.message);
  }
  console.log('\n--- TEST 5: Find Clockwork headphone items in catalog ---');
  try {
    const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
    const data = await res.json();
    const matches = Object.entries(data.items || {}).filter(
      ([, fields]) => fields[0] && fields[0].toLowerCase().includes('clockwork')
    );
    console.log('Catalog entries containing "clockwork":', JSON.stringify(matches, null, 2));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  console.log('\n--- TEST 6: Check if playerAssets has unmatched item IDs ---');
  try {
    const res = await fetch(`https://api.rolimons.com/players/v1/playerassets/${playerId}`, { headers: HEADERS });
    const data = await res.json();
    const catalogRes = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
    const catalogData = await catalogRes.json();
    const unmatched = Object.keys(data.playerAssets || {}).filter(id => !catalogData.items[id]);
    console.log('playerAssets item IDs with NO catalog match:', JSON.stringify(unmatched));
  } catch (err) {
    console.error('FAILED:', err.message);
  }
  console.log('\n--- TEST 7: Check specific named items the user says exist ---');
  try {
    const res = await fetch('https://www.rolimons.com/itemapi/itemdetails', { headers: HEADERS });
    const data = await res.json();
    const names = ['fall fairy', 'golden shades', 'gold clockwork headphones'];
    for (const n of names) {
      const found = Object.entries(data.items || {}).filter(
        ([, fields]) => fields[0] && fields[0].toLowerCase().includes(n)
      );
      console.log(`Search "${n}":`, JSON.stringify(found));
    }

    // Specifically check id 128217885 (the one showing as "Unknown").
    console.log('Catalog entry for "128217885":', JSON.stringify(data.items['128217885']));
  } catch (err) {
    console.error('FAILED:', err.message);
  }
})();
