// Test-only environment hooks. They are honoured ONLY in an unpackaged build started with
// GUARDED_TEST=1; a packaged app (app.isPackaged) ignores every one of them.
import { app } from 'electron';

export const TEST_MODE = process.env.GUARDED_TEST === '1' && !app.isPackaged;

export function testEnv(name: 'GUARDED_UNSAFE_DISABLE_POLICY' | 'GUARDED_TEST_KEEP_SW' | 'GUARDED_TEST_OPEN_DELAY_MS' | 'GUARDED_DOWNLOAD_DIR' | 'GUARDED_CONFIRM_TIMEOUT_MS' | 'GUARDED_MODEL_DIR' | 'GUARDED_MODEL_CACHE' | 'GUARDED_TEST_MAIL_LOOPBACK' | 'GUARDED_TEST_MAIL_CA' | 'GUARDED_TEST_ATTACH_FILE'): string | undefined {
  return TEST_MODE ? process.env[name] : undefined;
}
