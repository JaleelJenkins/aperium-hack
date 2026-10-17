// Runs before `npm install` (preinstall). Plain CommonJS with no dependencies on purpose.
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = major > 22 || (major === 22 && minor >= 13);

if (!ok) {
  console.error(`
  Client Pulse needs Node 22.13 or newer (it uses Node's built-in SQLite). You have ${process.version}.

  Install Node 22 LTS, then run npm install again.

  With nvm:
    nvm install 22 && nvm use 22

  With Homebrew:
    brew install node@22 && brew link --overwrite --force node@22
`);
  process.exit(1);
}

if (major % 2 === 1) {
  console.warn(
    `\n  Note: Node ${process.version} is not an LTS release; some dev tools (vitest) only support 22 and 24.` +
      `\n  Recommended: nvm install 22 && nvm use 22\n`,
  );
}
