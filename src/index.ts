// ncc entrypoint: bundles src/main.ts's run() so tests can import and await it directly.
import { run } from "./main.js";

void run();
