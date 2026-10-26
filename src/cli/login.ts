import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { AccountPool } from '../browser/accountPool';
import { applyStealthHooks, STEALTH_LAUNCH_ARGS } from '../browser/stealth';

dotenv.config();

/**
 * Interactive Account Login Helper (modeled after `+ Add Google Pro Account` in antigravity-argon-bridge).
 *
 * Usage:
 *   npm run login
 *   npm run login -- account2
 */
async function main() {
  const accountId = process.argv[2] || 'default';
  const targetUrl = process.env.MIMO_ULTRA_URL || 'https://aistudio.xiaomimimo.com/#/ultra';
  const pool = new AccountPool();
  const account = pool.registerOrUpdateAccount(accountId);

  console.log(`\n=============================================================`);
  console.log(`[MiMo Ultra Bridge] Launching Chromium for account: ${accountId}`);
  console.log(`Profile Directory: ${account.userDataDir}`);
  console.log(`Please sign in to your Xiaomi account in the browser window.`);
  console.log(`Once signed in on #/ultra, this window will save & close automatically.`);
  console.log(`=============================================================\n`);

  const context = await chromium.launchPersistentContext(account.userDataDir, {
    headless: false,
    args: STEALTH_LAUNCH_ARGS,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  await applyStealthHooks(context);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // Poll cookies until Xiaomi authentication cookies (`serviceToken` & `xiaomichatbot_ph`) are present
  const maxWaitMs = 5 * 60 * 1000;
  const start = Date.now();
  let linkedUserId: string | undefined;

  while (Date.now() - start < maxWaitMs) {
    if (page.isClosed()) {
      break;
    }
    const cookies = await context.cookies('https://aistudio.xiaomimimo.com');
    const serviceToken = cookies.find((c) => c.name === 'serviceToken')?.value;
    const ph = cookies.find((c) => c.name === 'xiaomichatbot_ph')?.value;
    const userId = cookies.find((c) => c.name === 'userId')?.value;

    if (serviceToken && ph) {
      linkedUserId = userId;
      console.log(`\n[MiMo Ultra Bridge] Detected valid session cookies!`);
      console.log(`  - userId: ${userId || 'detected'}`);
      console.log(`  - xiaomichatbot_ph: ${ph.slice(0, 8)}...`);
      // Wait 2 seconds to let local storage flush cleanly
      await page.waitForTimeout(2000);
      break;
    }

    await page.waitForTimeout(1500);
  }

  await context.close();

  if (linkedUserId) {
    pool.registerOrUpdateAccount(accountId, linkedUserId, `Xiaomi (${linkedUserId})`);
    console.log(`[MiMo Ultra Bridge] Account '${accountId}' linked and saved to pool!`);
  } else {
    console.log(`[MiMo Ultra Bridge] Browser closed. Profile state saved for '${accountId}'.`);
  }
}

main().catch((err) => {
  console.error('[MiMo Ultra Bridge] Login error:', err);
  process.exit(1);
});
