// Stands in for pnpm finishing an install and then not exiting, as pnpm 11.8
// did after installing dsh 0.2.0-rc.2 (user, 01.10): Done, then nothing, forever.
process.stdout.write('Progress: resolved 3, reused 0, downloaded 3, added 3, done\n');
process.stdout.write('Done in 1.2s using pnpm v11.8.0\n');
setInterval(() => {}, 1_000);
