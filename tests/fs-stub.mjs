// Herdr's fs/promises: Node's, plus the exists() Herdr adds.
import { access } from "node:fs/promises";
export * from "node:fs/promises";
export const exists = (path) => access(path).then(() => true, () => false);
