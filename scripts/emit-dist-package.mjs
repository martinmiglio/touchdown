import { writeFileSync } from "node:fs";
writeFileSync("dist/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
