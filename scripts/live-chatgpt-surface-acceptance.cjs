'use strict';

/*
 * Live ChatGPT acceptance probe for the isolated Torsionfield ConversationSurface.
 *
 * This file deliberately drives one real authenticated ChatGPT conversation. It
 * connects to a browser that the operator launched with a dedicated profile,
 * production ScriptCat and a loopback-only CDP endpoint. It never opens or copies
 * cookies, never calls private ChatGPT APIs, and refuses to continue when the
 * composer already contains a human draft.
 *
 * Required environment:
 *   TORSIONFIELD_CDP=http://127.0.0.1:9444
 * Optional:
 *   TORSIONFIELD_EVIDENCE_DIR=<directory>
 *
 * The differentiating postconditions are: one logical user turn, one settled
 * assistant turn, exactly one injected constraint contract, the expected nonce
 * in the assistant answer, an empty composer after submission, and a persisted
 * ConversationSurface receipt.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const cdpEndpoint = process.env.TORSIONFIELD_CDP || 'http://127.0.0.1:9444';
const evidenceDirectory = path.resolve(
  process.env.TORSIONFIELD_EVIDENCE_DIR || 'artifacts/windows-live-acceptance',
);
const receiptKey = 'torsionfield.chatgpt.surface.receipts.v1';

function countOccurrences(text, fragment) {
  if (!fragment) return 0;
  return String(text).split(fragment).length - 1;
}

async function composerText(composer) {
  return (await composer.innerText().catch(async () => composer.inputValue().catch(() => ''))).trim();
}

async function main() {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const nonce = `TORSIONFIELD_LIVE_OK_${Date.now().toString(36).toUpperCase()}`;
  const prompt = `For a browser integration test, reply with exactly this token and nothing else: ${nonce}`;

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context is exposed by the CDP endpoint');

    const page = context.pages().find((candidate) => candidate.url().startsWith('https://chatgpt.com'));
    if (!page) throw new Error('The dedicated browser has no ChatGPT page');

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);

    /*
     * On a fresh browser start ScriptCat's service worker can finish registering
     * the persisted user script after ChatGPT's first document has already passed
     * document-idle. Reload exactly once when the launcher is absent so the newly
     * registered script receives a document lifecycle. A duplicate launcher still
     * fails below; this is not a polling loop or a blind retry of submission.
     */
    if (await page.locator('#tspr-lab-launcher').count() === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#tspr-lab-launcher').waitFor({ state: 'visible', timeout: 20_000 });
    }

    const composer = page.locator(
      '#prompt-textarea,textarea[data-id="root"],form [contenteditable="true"][role="textbox"]',
    ).last();
    await composer.waitFor({ state: 'visible', timeout: 20_000 });

    const initialDraft = await composerText(composer);
    if (initialDraft) {
      throw new Error(`HUMAN_DRAFT_PRESENT: refusing to replace ${initialDraft.length} characters`);
    }
    if (await page.locator('#tspr-lab-launcher').count() !== 1) {
      throw new Error('The Torsionfield userscript launcher is absent or duplicated');
    }

    const before = {
      url: page.url(),
      userCount: await page.locator('[data-message-author-role="user"]').count(),
      assistantCount: await page.locator('[data-message-author-role="assistant"]').count(),
    };

    await composer.fill(prompt);
    const send = page.locator(
      'button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label^="Send"]',
    ).last();
    await send.waitFor({ state: 'visible', timeout: 10_000 });
    await send.click();

    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-message-author-role="user"]').length > count,
      before.userCount,
      { timeout: 30_000 },
    );

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const streaming = await page.locator(
        'button[data-testid="stop-button"],button[aria-label^="Stop"],button[aria-label*="Stop generating"]',
      ).count();
      const assistantCount = await page.locator('[data-message-author-role="assistant"]').count();
      if (!streaming && assistantCount > before.assistantCount) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(4_000);

    const userTexts = await page.locator('[data-message-author-role="user"]').allInnerTexts();
    const assistantTexts = await page.locator('[data-message-author-role="assistant"]').allInnerTexts();
    const receiptRaw = await page.evaluate((key) => sessionStorage.getItem(key), receiptKey);
    const receipts = receiptRaw ? JSON.parse(receiptRaw) : [];
    const latestReceipt = receipts.at(-1) || null;
    const latestUserText = userTexts.at(-1) || '';
    const latestAssistantText = assistantTexts.at(-1) || '';

    const checks = {
      oneNewUserTurn: userTexts.length === before.userCount + 1,
      oneNewAssistantTurn: assistantTexts.length === before.assistantCount + 1,
      oneConstraintContract: countOccurrences(latestUserText, '<ts-constraint-contract') === 1,
      assistantContainsNonce: latestAssistantText.includes(nonce),
      composerEmpty: (await composerText(composer)) === '',
      receiptPresent: Boolean(latestReceipt),
      receiptConfirmed: latestReceipt?.status === 'CONFIRMED',
    };
    const ok = Object.values(checks).every(Boolean);

    const result = {
      ok,
      nonce,
      before,
      after: {
        url: page.url(),
        userCount: userTexts.length,
        assistantCount: assistantTexts.length,
        latestUserText,
        latestAssistantText,
        latestReceipt,
        launcherText: await page.locator('#tspr-lab-launcher').innerText().catch(() => ''),
      },
      checks,
      recordedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(evidenceDirectory, 'live-acceptance.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: path.join(evidenceDirectory, 'live-acceptance.png'), fullPage: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
