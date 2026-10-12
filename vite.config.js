import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
let commit = 'development';
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch {}
export default defineConfig({define:{__BUILD_ID__:JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,7) || commit)},build:{target:'es2022'}});
