/**
 * Regenerate seed/labels.json from seed/emails.ts (the single source of truth).
 *   npm run seed:labels
 * Deadlines are stored as days from the seeding anchor; data/seed-run.json
 * (written by npm run seed:inbox) has the same labels with absolute dates and Gmail ids.
 */
import fs from "node:fs";
import { labelsFile } from "../src/lib/seed-labels";

fs.writeFileSync("seed/labels.json", JSON.stringify(labelsFile(), null, 2) + "\n");
console.log(`Wrote seed/labels.json (${labelsFile().emails.length} emails).`);
