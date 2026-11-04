import { createConnection } from 'node:net';

const { DSH_SSH_ASKPASS_PORT: portText, DSH_SSH_ASKPASS_NONCE: nonce, SSH_ASKPASS_PROMPT: hint } = process.env;
const prompt = process.argv[2];
const port = Number(portText);

if (hint || !prompt?.endsWith("'s password: ") || !/^\d{1,5}$/.test(portText) ||
    port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(nonce)) {
  process.exit(1);
}

const chunks = [];
let length = 0;
const socket = createConnection({ host: '127.0.0.1', port }, () => {
  socket.write(`${nonce}:${process.ppid}\n`);
});
socket.setTimeout(5_000, () => socket.destroy(new Error('timeout')));
socket.on('error', () => { process.exitCode = 1; });
socket.on('data', chunk => {
  length += chunk.length;
  if (length > 1023) {
    chunk.fill(0);
    socket.destroy(new Error('invalid response'));
  } else {
    chunks.push(chunk);
  }
});
socket.once('end', () => {
  if (length > 0 && length <= 1023) {
    for (const chunk of chunks.splice(0)) process.stdout.write(chunk, () => chunk.fill(0));
  } else {
    process.exitCode = 1;
  }
});
socket.once('close', () => {
  for (const chunk of chunks) chunk.fill(0);
});
