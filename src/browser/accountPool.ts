import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountMetadata } from '../types';

export class AccountPool {
  private profilesRoot: string;
  private metadataFile: string;
  private accounts: Map<string, AccountMetadata> = new Map();
  private roundRobinIndex = 0;

  constructor(profilesDir?: string) {
    const rawDir = profilesDir || process.env.PROFILES_DIR || '~/.xiaomi-mimo-ultra/profiles';
    this.profilesRoot = rawDir.startsWith('~')
      ? path.join(os.homedir(), rawDir.slice(1))
      : path.resolve(rawDir);
    this.metadataFile = path.join(path.dirname(this.profilesRoot), 'accounts.json');
    this.ensureDirectories();
    this.loadAccounts();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.profilesRoot)) {
      fs.mkdirSync(this.profilesRoot, { recursive: true });
    }
  }

  public loadAccounts(): void {
    if (fs.existsSync(this.metadataFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8')) as AccountMetadata[];
        for (const acc of raw) {
          acc.busy = false;
          this.accounts.set(acc.id, acc);
        }
      } catch (err) {
        console.warn('[AccountPool] Failed to parse accounts.json, scanning profile folders...', err);
      }
    }

    // Also auto-discover any profile folders on disk
    const entries = fs.readdirSync(this.profilesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !this.accounts.has(entry.name)) {
        this.accounts.set(entry.name, {
          id: entry.name,
          label: `Xiaomi Account (${entry.name})`,
          userDataDir: path.join(this.profilesRoot, entry.name),
          hasValidToken: true,
          lastUsedAt: 0,
          cooldownUntil: 0,
          totalTurns: 0,
          busy: false,
        });
      }
    }
    this.saveAccounts();
  }

  public saveAccounts(): void {
    const list = Array.from(this.accounts.values()).map((a) => ({
      ...a,
      busy: false,
    }));
    fs.writeFileSync(this.metadataFile, JSON.stringify(list, null, 2), 'utf8');
  }

  public registerOrUpdateAccount(id: string, userId?: string, label?: string): AccountMetadata {
    const userDataDir = path.join(this.profilesRoot, id);
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    const existing = this.accounts.get(id);
    const updated: AccountMetadata = {
      id,
      label: label || existing?.label || `Xiaomi-${userId || id}`,
      userDataDir,
      userId: userId || existing?.userId,
      hasValidToken: true,
      lastUsedAt: Date.now(),
      cooldownUntil: 0,
      totalTurns: existing?.totalTurns || 0,
      busy: false,
    };
    this.accounts.set(id, updated);
    this.saveAccounts();
    return updated;
  }

  /**
   * Acquires the next available account using round-robin rotation with automatic failover.
   */
  public acquireAccount(): AccountMetadata {
    const now = Date.now();
    const all = Array.from(this.accounts.values());

    if (all.length === 0) {
      // Create a default profile slot if none exists yet
      return this.registerOrUpdateAccount('default');
    }

    for (let i = 0; i < all.length; i++) {
      const idx = (this.roundRobinIndex + i) % all.length;
      const candidate = all[idx];
      if (!candidate.busy && candidate.hasValidToken && candidate.cooldownUntil <= now) {
        candidate.busy = true;
        candidate.lastUsedAt = now;
        this.roundRobinIndex = (idx + 1) % all.length;
        return candidate;
      }
    }

    // Fallback: pick the least recently used valid account even if busy/cooldown
    const valid = all.filter((a) => a.hasValidToken);
    if (valid.length === 0) {
      throw new Error(
        'No valid Xiaomi MiMo accounts available in pool. Run `npm run login` to authenticate an account.'
      );
    }
    valid.sort((a, b) => a.cooldownUntil - b.cooldownUntil || a.lastUsedAt - b.lastUsedAt);
    const chosen = valid[0];
    chosen.busy = true;
    chosen.lastUsedAt = now;
    return chosen;
  }

  public releaseAccount(id: string, incrementTurn = true): void {
    const acc = this.accounts.get(id);
    if (acc) {
      acc.busy = false;
      if (incrementTurn) {
        acc.totalTurns += 1;
      }
      this.saveAccounts();
    }
  }

  public markRateLimited(id: string, cooldownMs = 60_000): void {
    const acc = this.accounts.get(id);
    if (acc) {
      acc.busy = false;
      acc.cooldownUntil = Date.now() + cooldownMs;
      console.warn(`[AccountPool] Account ${id} rate-limited; cooling down for ${cooldownMs / 1000}s.`);
      this.saveAccounts();
    }
  }

  public markTokenExpired(id: string): void {
    const acc = this.accounts.get(id);
    if (acc) {
      acc.busy = false;
      acc.hasValidToken = false;
      console.error(`[AccountPool] Account ${id} serviceToken expired. Please run 'npm run login -- ${id}'.`);
      this.saveAccounts();
    }
  }

  public listAccounts(): AccountMetadata[] {
    return Array.from(this.accounts.values());
  }
}
