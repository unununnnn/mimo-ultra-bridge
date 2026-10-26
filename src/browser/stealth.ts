import { BrowserContext } from 'playwright';

/**
 * Injects CDP-level stealth evasion hooks into a Playwright Chromium context,
 * modeled after AdhirajPersonal/antigravity-argon-bridge.
 */
export async function applyStealthHooks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // 1. Mask navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // 2. Spoof window.chrome runtime object
    const win = window as unknown as Record<string, unknown>;
    if (!win.chrome) {
      win.chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: { isInstalled: false },
      };
    }

    // 3. Ensure realistic languages & platform
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
    });

    // 4. Spoof permissions query for notifications
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
    }
  });
}

export const STEALTH_LAUNCH_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--window-size=1440,900',
];
