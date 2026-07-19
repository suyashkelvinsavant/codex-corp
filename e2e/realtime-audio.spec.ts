import { expect, test } from "@playwright/test";

test("bundled microphone AudioWorklet module loads from the app origin", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 24_000 });
    const moduleUrl = new URL(
      "realtime-mic-processor.js",
      document.baseURI,
    ).href;
    try {
      await context.audioWorklet.addModule(moduleUrl);
      return { moduleUrl, loaded: true };
    } finally {
      await context.close();
    }
  });

  expect(result.loaded).toBe(true);
  expect(result.moduleUrl).toBe(
    "http://127.0.0.1:5173/realtime-mic-processor.js",
  );
});
