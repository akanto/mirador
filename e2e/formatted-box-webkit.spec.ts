import { devices, test } from "@playwright/test";
import { formattedBoxTests } from "./formatted-box.tests.ts";

/** As the desktop app is: WebKit on a Mac, so the page takes the macOS keys, such as Home and End, as it does there. */
test.use({ ...devices["Desktop Safari"], channel: "", launchOptions: {}, viewport: { width: 1600, height: 1000 } });

formattedBoxTests();
