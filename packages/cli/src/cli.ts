#!/usr/bin/env node
import { OPENMINI_CLI_VERSION } from './index';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(OPENMINI_CLI_VERSION);
} else {
  console.log('openmini-cli — no commands implemented yet (Phase 1 scaffold).');
  console.log(`Version: ${OPENMINI_CLI_VERSION}`);
}
