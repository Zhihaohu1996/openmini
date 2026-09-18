/**
 * Entry script for the CLI-built `hello-styled` package.
 *
 * Its job is only to complete the handshake so the sandbox reaches
 * `running`; the assertion the styled-package e2e actually makes is about
 * the heading's computed color, which proves the browser accepted the
 * builder's inline-style hash.
 */
import { connectOpenMini } from '@openmini/sdk';

async function main(): Promise<void> {
  await connectOpenMini();
  const heading = document.getElementById('styled-heading');
  if (heading) {
    heading.textContent = 'styled and connected';
  }
}

void main();
